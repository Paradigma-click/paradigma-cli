import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Everything a platform command touches outside its arguments, so tests can
 * drive commands in-process (fake fetch, captured output, scripted answers).
 */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** stdin and stdout are terminals: questions can be asked. */
  interactive: boolean;
  stdinIsTTY: boolean;
  /** Whole stdin (for piped secrets). */
  readStdin(): Promise<string>;
  ask(question: string): Promise<string>;
  /** Like ask, without echoing the answer. */
  askHidden(question: string): Promise<string>;
  openUrl(url: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  fetch?: FetchLike;
}

/** Exit codes: 0 ok, 1 failure, 2 usage, 3 the person (or agent) must act first. */
export const EXIT_ACTION_REQUIRED = 3;

export class UsageError extends Error {}

/** Something the person or agent must provide or do; exits with code 3. */
export class ActionRequired extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = spawn(command[0], command.slice(1), {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

async function readAll(stream: NodeJS.ReadableStream, maxBytes = 64 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxBytes) throw new UsageError("stdin is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function question(text: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    if (hidden) {
      const output = rl as unknown as {
        _writeToOutput?: (value: string) => void;
      };
      output._writeToOutput = (value: string) => {
        // Show the prompt itself, mask everything typed after it.
        if (value.includes(text)) process.stderr.write(text);
      };
    }
    rl.question(text, (answer) => {
      rl.close();
      if (hidden) process.stderr.write("\n");
      resolve(answer);
    });
  });
}

export function defaultIo(): Io {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: () => readAll(process.stdin),
    ask: (text) => question(text, false),
    askHidden: (text) => question(text, true),
    openUrl: openBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/**
 * Human output goes to stdout as lines; with `--json` only JSON goes to
 * stdout (one object per line for progress events), and human lines are
 * dropped so agents can parse the stream.
 */
export class Reporter {
  constructor(
    readonly io: Io,
    readonly json: boolean,
  ) {}

  line(text = "") {
    if (!this.json) this.io.stdout(`${text}\n`);
  }

  warn(text: string) {
    if (!this.json) this.io.stderr(`! ${text}\n`);
  }

  /** NDJSON progress event (json mode only). */
  event(event: string, data: Record<string, unknown> = {}) {
    if (this.json) this.io.stdout(`${JSON.stringify({ event, ...data })}\n`);
  }

  /** Final result: JSON object in json mode, otherwise the human renderer. */
  result(data: unknown, human: () => void) {
    if (this.json) this.io.stdout(`${JSON.stringify(data)}\n`);
    else human();
  }

  /** Confirm with a default; non-interactive sessions return the default. */
  async confirm(text: string, fallback: boolean): Promise<boolean> {
    if (!this.io.interactive || this.json) return fallback;
    const answer = (
      await this.io.ask(`${text} ${fallback ? "[Y/n]" : "[y/N]"} `)
    )
      .trim()
      .toLowerCase();
    if (!answer) return fallback;
    return answer === "y" || answer === "yes";
  }

  /** Free-text question with a default; null when no answer can be asked. */
  async prompt(text: string, fallback?: string): Promise<string | null> {
    if (!this.io.interactive || this.json) return fallback ?? null;
    const answer = (
      await this.io.ask(`${text}${fallback ? ` [${fallback}]` : ""}: `)
    ).trim();
    return answer || fallback || null;
  }
}
