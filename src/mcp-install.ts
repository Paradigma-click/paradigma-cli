import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./exec";

export const MCP_AGENTS = ["claude", "codex", "cursor"] as const;
export type McpAgent = (typeof MCP_AGENTS)[number];
export const MCP_SERVER_NAME = "paradigma";

export function mcpUrl(server: string) {
  return `${server.replace(/\/$/, "")}/api/mcp`;
}

export type McpInstallResult = {
  agent: McpAgent;
  status: "installed" | "already_configured" | "updated" | "failed";
  /** What was run or written, for the person to see. */
  action: string;
  next?: string;
  error?: string;
};

/** argv for each agent's own `mcp add` (never through a shell). */
export function mcpAddCommand(agent: "claude" | "codex", url: string) {
  return agent === "claude"
    ? ["claude", "mcp", "add", "--transport", "http", MCP_SERVER_NAME, url]
    : ["codex", "mcp", "add", MCP_SERVER_NAME, "--url", url];
}

async function installWithCli(
  agent: "claude" | "codex",
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<McpInstallResult> {
  const binary = agent;
  const existing = await run(binary, ["mcp", "get", MCP_SERVER_NAME], {
    timeoutMs: 20_000,
    env,
  });
  const next =
    agent === "claude"
      ? "In Claude Code, run /mcp and authenticate paradigma to approve access."
      : `Run \`codex mcp login ${MCP_SERVER_NAME}\` to approve access.`;
  if (existing.error)
    return {
      agent,
      status: "failed",
      action: `${binary} not found`,
      error: `Install ${agent === "claude" ? "Claude Code" : "Codex"} first, or use --agent cursor.`,
    };
  const [command, ...args] = mcpAddCommand(agent, url);
  const printable = [command, ...args].join(" ");
  if (existing.code === 0) {
    if (existing.stdout.includes(url))
      return { agent, status: "already_configured", action: printable, next };
    return {
      agent,
      status: "failed",
      action: printable,
      error: `An MCP server named "${MCP_SERVER_NAME}" already exists with another URL. Remove it (\`${binary} mcp remove ${MCP_SERVER_NAME}\`) and run this again.`,
    };
  }
  const added = await run(command, args, { timeoutMs: 30_000, env });
  if (added.code !== 0)
    return {
      agent,
      status: "failed",
      action: printable,
      error: (added.stderr || added.stdout)
        .trim()
        .split("\n")
        .slice(-2)
        .join(" ")
        .slice(0, 300),
    };
  return { agent, status: "installed", action: printable, next };
}

/**
 * Merges `mcpServers.paradigma` into Cursor's global config. Other servers
 * are kept; the previous file is backed up first; invalid JSON is never
 * overwritten.
 */
export async function installCursor(
  url: string,
  home = homedir(),
  now = new Date(),
): Promise<McpInstallResult> {
  const file = join(home, ".cursor", "mcp.json");
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object");
      config = parsed;
    } catch {
      return {
        agent: "cursor",
        status: "failed",
        action: `read ${file}`,
        error: `${file} is not valid JSON; fix it and run this again (nothing was changed).`,
      };
    }
  }
  const servers =
    config.mcpServers &&
    typeof config.mcpServers === "object" &&
    !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  const current = servers[MCP_SERVER_NAME] as { url?: unknown } | undefined;
  if (current?.url === url)
    return {
      agent: "cursor",
      status: "already_configured",
      action: `${file} already has ${MCP_SERVER_NAME}`,
    };
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
  }
  const next = {
    ...config,
    mcpServers: { ...servers, [MCP_SERVER_NAME]: { url } },
  };
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temp, file);
  return {
    agent: "cursor",
    status: current ? "updated" : "installed",
    action: `wrote mcpServers.${MCP_SERVER_NAME} to ${file}${backup ? ` (backup: ${backup})` : ""}`,
    next: "Open Cursor Settings → MCP and sign in to paradigma to approve access.",
  };
}

export function installMcp(
  agent: McpAgent,
  server: string,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<McpInstallResult> {
  const url = mcpUrl(server);
  if (agent === "cursor") return installCursor(url, options.home);
  return installWithCli(agent, url, options.env ?? process.env);
}

/** The agent this CLI is probably running inside, from its environment. */
export function hostAgent(
  env: Record<string, string | undefined>,
): McpAgent | null {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (env.CODEX_SANDBOX || env.CODEX_HOME || env.CODEX_MANAGED_BY_NPM)
    return "codex";
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return "cursor";
  return null;
}
