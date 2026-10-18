import { spawn } from "node:child_process";

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the whole process tree after this many milliseconds. */
  timeoutMs?: number;
  /** Aborting kills the whole process tree (used for server-side cancel). */
  signal?: AbortSignal;
  /** Run through the platform shell (only for commands the user configured). */
  shell?: boolean;
  /** Bytes kept per stream; older output is dropped. */
  maxOutputBytes?: number;
  /**
   * Called with each stdout line as it arrives (without the newline), e.g. to follow an agent's
   * stream live. The full stdout is still kept (bounded) for the result. Errors are ignored.
   */
  onStdoutLine?: (line: string) => void;
};

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Spawn failure, e.g. ENOENT when the binary is missing. */
  error?: string;
  durationMs: number;
};

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;
/** Longest stdout line handed to `onStdoutLine`; a longer line is dropped whole. */
const MAX_STREAM_LINE = 1024 * 1024;

/**
 * Splits a stream into lines for a callback: `push` takes chunks, `end` flushes the last
 * unterminated line. A line over `maxLine` characters is dropped whole. Never throws.
 */
export function lineSplitter(
  onLine: (line: string) => void,
  maxLine = MAX_STREAM_LINE,
) {
  let pending = "";
  let dropping = false;
  const emit = (line: string) => {
    try {
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    } catch {}
  };
  return {
    push(chunk: string) {
      let start = 0;
      let index = chunk.indexOf("\n");
      while (index >= 0) {
        if (!dropping) emit(pending + chunk.slice(start, index));
        pending = "";
        dropping = false;
        start = index + 1;
        index = chunk.indexOf("\n", start);
      }
      if (dropping) return;
      pending += chunk.slice(start);
      if (pending.length > maxLine) {
        pending = "";
        dropping = true;
      }
    },
    end() {
      if (pending && !dropping) emit(pending);
      pending = "";
      dropping = false;
    },
  };
}

function keepTail(current: string, chunk: string, max: number) {
  const next = current + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Kills the process group (POSIX) or tree (Windows). Never throws. */
export function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }, 3000).unref();
}

/** Children started by `run` that have not exited yet (their own process groups). */
const liveChildren = new Set<number>();

/**
 * Kills every child `run` started that is still running, with its whole process group, at once
 * (SIGKILL). For a forced exit: children run in their own process groups, so a terminal's
 * Ctrl+C never reaches them and they would outlive the CLI. Never throws.
 */
export function killAllChildren() {
  for (const pid of liveChildren) {
    try {
      if (process.platform === "win32") killTree(pid);
      else process.kill(-pid, "SIGKILL");
    } catch {}
  }
  liveChildren.clear();
}

/** How many children `run` started are still running (tests). */
export function liveChildCount() {
  return liveChildren.size;
}

/**
 * Runs a command with stdin closed, a timeout and process-tree cleanup.
 * Arguments are passed as an array, never interpolated into a shell, unless
 * `shell` is set explicitly for user-configured commands.
 */
export function run(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const started = Date.now();
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: true,
        durationMs: 0,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: options.shell ?? false,
      windowsHide: true,
    });
    const pid = child.pid;
    if (pid) liveChildren.add(pid);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const lines = options.onStdoutLine
      ? lineSplitter(options.onStdoutLine)
      : null;
    child.stdout?.on("data", (chunk: string) => {
      stdout = keepTail(stdout, chunk, max);
      lines?.push(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = keepTail(stderr, chunk, max);
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, options.timeoutMs)
      : undefined;
    const onAbort = () => {
      cancelled = true;
      killTree(child.pid);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      lines?.end();
      if (pid) liveChildren.delete(pid);
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        cancelled,
        error,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}

/** Runs a command and throws with stderr when it does not exit 0. */
export async function runOk(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const reason = result.timedOut
      ? "timed out"
      : result.cancelled
        ? "cancelled"
        : (result.error ??
          result.stderr.trim().split("\n").slice(-3).join(" "));
    throw new CommandError(
      `${command} ${args[0] ?? ""} failed: ${reason}`.trim(),
      result,
    );
  }
  return result.stdout;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
  }
}

/** Splits a command string like a POSIX shell would for simple quoting. */
export function splitCommand(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < input.length)
        current += input[++index];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      has = true;
    } else if (/\s/.test(char)) {
      if (has || current) parts.push(current);
      current = "";
      has = false;
    } else if (char === "\\" && index + 1 < input.length) {
      current += input[++index];
    } else {
      current += char;
    }
  }
  if (has || current) parts.push(current);
  return parts;
}
