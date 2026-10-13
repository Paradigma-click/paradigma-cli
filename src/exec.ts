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
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = keepTail(stdout, chunk, max);
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
