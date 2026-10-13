import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentName } from "./config";
import { run, splitCommand } from "./exec";

export type DetectedAgent = {
  name: AgentName;
  version: string | null;
  /** Command (and leading args) used to start it. */
  command: string[];
};

export type AgentMode = "edit" | "review";

export const AGENT_BINARIES: Record<Exclude<AgentName, "custom">, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
};

export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;

/** Tools the edit step may use. No shell, no network. */
const CLAUDE_EDIT_TOOLS = "Read,Edit,Write,Glob,Grep";
const CLAUDE_EDIT_DENY = "Bash,WebFetch,WebSearch";
const CLAUDE_REVIEW_TOOLS = "Read,Glob,Grep";
const CLAUDE_REVIEW_DENY = "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch";

export function parseVersion(output: string): string | null {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-.+][0-9A-Za-z.-]+)?/.exec(output);
  return match ? match[0].slice(0, 80) : output.trim().slice(0, 80) || null;
}

export function customAgentCommand(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const raw = env.PARADIGMA_AGENT_COMMAND?.trim();
  if (!raw) return null;
  const parts = splitCommand(raw);
  return parts.length ? parts : null;
}

/** Installed agents with their versions (`<bin> --version`). */
export async function detectAgents(
  env: Record<string, string | undefined> = process.env,
): Promise<DetectedAgent[]> {
  const custom = customAgentCommand(env);
  const found: DetectedAgent[] = [];
  if (custom) found.push({ name: "custom", version: null, command: custom });
  const checks = await Promise.all(
    (Object.entries(AGENT_BINARIES) as Array<[AgentName, string]>).map(
      async ([name, binary]) => {
        const result = await run(binary, ["--version"], {
          timeoutMs: 15_000,
          env: env as NodeJS.ProcessEnv,
        });
        if (result.code !== 0) return null;
        return {
          name,
          version: parseVersion(result.stdout || result.stderr),
          command: [binary],
        } satisfies DetectedAgent;
      },
    ),
  );
  for (const agent of checks) if (agent) found.push(agent);
  return found;
}

/** Explicit flag, then config preference, then custom, claude, codex, cursor. */
export function chooseAgent(
  detected: readonly DetectedAgent[],
  preference?: AgentName,
): DetectedAgent | null {
  if (preference) return detected.find((a) => a.name === preference) ?? null;
  const order: AgentName[] = ["custom", "claude", "codex", "cursor"];
  for (const name of order) {
    const agent = detected.find((a) => a.name === name);
    if (agent) return agent;
  }
  return null;
}

export type AgentInvocation = {
  command: string;
  args: string[];
};

/**
 * Pure argv builder. The prompt always comes right after the print flag and
 * before any flag that takes several values, so it can never be swallowed.
 */
export function buildAgentArgv(
  agent: Pick<DetectedAgent, "name" | "command">,
  input: {
    mode: AgentMode;
    prompt: string;
    promptFile: string;
    /** Codex writes its final message here (`--output-last-message`). */
    lastMessageFile: string;
  },
): AgentInvocation {
  const [command, ...base] = agent.command;
  const review = input.mode === "review";
  switch (agent.name) {
    case "claude":
      return {
        command,
        args: [
          ...base,
          "-p",
          input.prompt,
          "--output-format",
          "json",
          "--no-session-persistence",
          "--permission-mode",
          review ? "dontAsk" : "acceptEdits",
          "--allowedTools",
          review ? CLAUDE_REVIEW_TOOLS : CLAUDE_EDIT_TOOLS,
          "--disallowedTools",
          review ? CLAUDE_REVIEW_DENY : CLAUDE_EDIT_DENY,
        ],
      };
    case "codex":
      return {
        command,
        args: [
          ...base,
          "exec",
          input.prompt,
          "--sandbox",
          review ? "read-only" : "workspace-write",
          "--skip-git-repo-check",
          "--ephemeral",
          "--color",
          "never",
          "-c",
          'approval_policy="never"',
          "--output-last-message",
          input.lastMessageFile,
        ],
      };
    case "cursor":
      return {
        command,
        args: [
          ...base,
          "-p",
          input.prompt,
          "--output-format",
          "json",
          "--trust",
          "--sandbox",
          "enabled",
          ...(review ? ["--mode", "ask"] : []),
        ],
      };
    case "custom":
      return { command, args: [...base, input.promptFile] };
  }
}

/** Final assistant text from an agent's stdout (JSON for claude/cursor). */
export function extractAgentText(name: AgentName, stdout: string): string {
  if (name === "claude" || name === "cursor") {
    const trimmed = stdout.trim();
    const lastLine = trimmed.split("\n").filter(Boolean).at(-1) ?? "";
    for (const candidate of [trimmed, lastLine]) {
      try {
        const data = JSON.parse(candidate) as { result?: unknown };
        if (typeof data?.result === "string") return data.result;
      } catch {}
    }
  }
  return stdout;
}

/** Claude/Cursor JSON results flag errors even with exit code 0. */
export function agentReportedError(name: AgentName, stdout: string): boolean {
  if (name !== "claude" && name !== "cursor") return false;
  try {
    const data = JSON.parse(stdout.trim()) as { is_error?: unknown };
    return data?.is_error === true;
  } catch {
    return false;
  }
}

export type AgentRunResult = {
  ok: boolean;
  code: "agent_failed" | "agent_timeout" | "cancelled" | null;
  text: string;
  durationMs: number;
};

/**
 * Runs the agent in `cwd` with stdin closed, a timeout and tree kill. The
 * prompt file and the last-message file live outside the worktree.
 */
export async function runAgent(
  agent: DetectedAgent,
  input: {
    mode: AgentMode;
    prompt: string;
    cwd: string;
    scratchDir: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<AgentRunResult> {
  const dir = await mkdtemp(join(input.scratchDir, `${input.mode}-`));
  const promptFile = join(dir, "prompt.md");
  const lastMessageFile = join(dir, "last-message.txt");
  try {
    await writeFile(promptFile, input.prompt, { mode: 0o600 });
    const invocation = buildAgentArgv(agent, {
      mode: input.mode,
      prompt: input.prompt,
      promptFile,
      lastMessageFile,
    });
    const result = await run(invocation.command, invocation.args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      signal: input.signal,
      env: {
        ...process.env,
        PARADIGMA_AGENT_MODE: input.mode,
        CI: process.env.CI ?? "1",
      },
    });
    let text = extractAgentText(agent.name, result.stdout);
    if (agent.name === "codex") {
      try {
        text = await readFile(lastMessageFile, "utf8");
      } catch {}
    }
    if (result.cancelled)
      return {
        ok: false,
        code: "cancelled",
        text,
        durationMs: result.durationMs,
      };
    if (result.timedOut)
      return {
        ok: false,
        code: "agent_timeout",
        text,
        durationMs: result.durationMs,
      };
    if (result.code !== 0 || agentReportedError(agent.name, result.stdout))
      return {
        ok: false,
        code: "agent_failed",
        text: text || result.stderr,
        durationMs: result.durationMs,
      };
    return { ok: true, code: null, text, durationMs: result.durationMs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
