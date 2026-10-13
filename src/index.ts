import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { type DetectedAgent, detectAgents } from "./agents";
import { ApiClient, normalizeServer } from "./api";
import {
  accountStatus,
  isPlatformCommand,
  platformCommand,
  withJsonErrors,
} from "./commands";
import {
  AGENT_NAMES,
  type AgentName,
  type Config,
  configPath,
  DEFAULT_SERVER,
  isPaired,
  loadConfig,
  requirePaired,
  saveConfig,
  updateConfig,
} from "./config";
import type { PolicyResponse } from "./contract/autopilot";
import { run } from "./exec";
import { initCommand } from "./init";
import {
  ActionRequired,
  defaultIo,
  EXIT_ACTION_REQUIRED,
  UsageError,
} from "./io";
import { pairDevice } from "./pairing";
import {
  cloneRepo,
  defaultScanRoots,
  indexLocalClones,
  parseRepoOverride,
  verifyClone,
} from "./repos";
import { runAutopilot } from "./run";
import {
  describeSchedule,
  installSchedule,
  isScheduleInstalled,
  minuteFor,
  scheduleSpec,
  uninstallSchedule,
} from "./schedule";
import { VERSION } from "./version";

const HELP = `paradigma ${VERSION} — Paradigma: SEO and AI search monitoring, set up and run by your agent

Get started (in your repository):
  npx paradigma-cli init                     sign in, create the project, verify the domain

Setup:
  paradigma init [--token T] [--server URL] [--url U] [--brand B] [--category C]
                 [--use-case U] [--app-root PATH] [--mcp claude|codex|cursor|none]
                 [--yes] [--no-pr] [--wait SECONDS] [--dir PATH] [--json]
  paradigma status [--json]                  account checklist, local runner, policy
  paradigma links [--json]                   hand-off links (GitHub App, Google, Slack, billing)

Projects and domain:
  paradigma projects list|create|update [--project ID] [--repo owner/name]
                 [--app-root PATH] [--url U] [--brand B] [--category C] [--use-case U]
                 [--sitemap URL] [--alias NAME]... [--competitor NAME]...
  paradigma verify [--method dns|file|meta]... [--project ID]   (exit 3 = not yet)

Data:
  paradigma audit [--project ID]
  paradigma sync gsc|bing|ga4|performance|plausible|posthog [--project ID]
  paradigma connect <provider> [--project ID] [--key-env NAME]
                 providers: bing, crux, plausible [--site-domain D],
                 posthog --region us|eu --posthog-project ID,
                 gemini, openai, anthropic, perplexity,
                 dataforseo --login L [--location 2840] [--language en]
                 The key is read from stdin (or the env var named by --key-env),
                 never from arguments, and is never printed.

AI search (GEO, on your own provider keys):
  paradigma geo prompts [list [--state all|active|inactive] | add "TEXT"]
  paradigma geo schedule --engine E --daily 1|3|5|10 --accept-charges | --off
  paradigma geo sample --engine E --prompt ID --accept-charges
                 engines: gemini, openai, claude, perplexity, google_ai_overview

Alerts and billing (organization owner):
  paradigma alerts budget 0|1|2|3 [--org ID]
  paradigma billing checkout --plan pro|agency [--org ID] [--open]
  paradigma billing portal [--org ID] [--open]

Autopilot policy on the server (all runners):
  paradigma autopilot level 0|1|2|3 [--repo owner/name]
                 3 Notify, 2 Open PR, 1 Autopilot, 0 Full autopilot
                 (level 0 needs --confirm-full-autopilot and an allowlisted account)
  paradigma autopilot pause [--reason TEXT] | resume [--repo owner/name]

Agent MCP:
  paradigma mcp install --agent claude|codex|cursor

Local Autopilot runner (this machine):
  paradigma setup [--server URL] [--name NAME] [--repo owner/name=PATH]...
                  [--clone] [--agent claude|codex|cursor] [--schedule [--hour H]]
  paradigma run [--once] [--dry-run] [--agent claude|codex|cursor] [--max N]
                [--keep-worktrees] [--skip-checks]
  paradigma repos [set owner/name PATH | scan [--clone]]
  paradigma schedule install|uninstall|print [--hour H] [--minute M]
  paradigma pause | resume                   local kill switch for this machine only
                                             (server-wide: autopilot pause|resume)
  paradigma doctor
  paradigma logout
  paradigma --help | --version

Agents: add --json for machine-readable output (init streams one JSON event per
line). Exit codes: 0 ok, 1 failed, 2 usage, 3 needs the person or more input.

Environment:
  PARADIGMA_HOME           config directory (default ~/.paradigma)
  PARADIGMA_SERVER         server URL used by init/setup (default ${DEFAULT_SERVER})
  PARADIGMA_AGENT_COMMAND  custom agent command; receives the prompt file path
                           as its last argument
`;

function print(line = "") {
  process.stdout.write(`${line}\n`);
}

function parseAgent(value: string | undefined): AgentName | undefined {
  if (value === undefined) return undefined;
  if (!(AGENT_NAMES as readonly string[]).includes(value))
    throw new UsageError(`--agent must be one of ${AGENT_NAMES.join(", ")}`);
  return value as AgentName;
}

function parseIntFlag(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new UsageError(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

function apiFor(config: Config) {
  return new ApiClient({
    server: config.server,
    token: config.token,
    userAgent: `paradigma-cli/${VERSION}`,
  });
}

function describeAgents(agents: readonly DetectedAgent[]) {
  return agents.length
    ? agents
        .map((a) => `${a.name}${a.version ? ` ${a.version}` : ""}`)
        .join(", ")
    : "none";
}

/** Maps every policy repository to a local clone; returns lines to print. */
async function mapRepos(
  config: Config,
  policy: PolicyResponse,
  options: { overrides: string[]; clone: boolean },
): Promise<string[]> {
  const lines: string[] = [];
  const overrides = new Map<string, string>();
  for (const raw of options.overrides) {
    const parsed = parseRepoOverride(raw);
    if (!parsed)
      throw new UsageError(`--repo must look like owner/name=PATH (${raw})`);
    overrides.set(parsed.fullName.toLowerCase(), parsed.path);
  }
  let index: Map<string, string> | undefined;
  for (const repo of policy.repos) {
    const key = repo.fullName.toLowerCase();
    const override = overrides.get(key);
    if (override) {
      const problem = await verifyClone(override, repo.fullName);
      if (problem) throw new UsageError(problem);
      config.repos[repo.repoId] = override;
      config.repoNames[repo.repoId] = repo.fullName;
      lines.push(`  ${repo.fullName} → ${override}`);
      continue;
    }
    const existing = config.repos[repo.repoId];
    if (existing && !(await verifyClone(existing, repo.fullName))) {
      config.repoNames[repo.repoId] = repo.fullName;
      lines.push(`  ${repo.fullName} → ${existing}`);
      continue;
    }
    index ??= await indexLocalClones(defaultScanRoots());
    let path = index.get(key);
    if (!path && options.clone) {
      lines.push(`  Cloning ${repo.fullName}…`);
      path = await cloneRepo(repo.fullName);
    }
    if (path) {
      config.repos[repo.repoId] = path;
      config.repoNames[repo.repoId] = repo.fullName;
      lines.push(`  ${repo.fullName} → ${path}`);
    } else {
      delete config.repos[repo.repoId];
      lines.push(
        `  ${repo.fullName} → not found (use --repo ${repo.fullName}=PATH or --clone)`,
      );
    }
  }
  return lines;
}

async function setup(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string" },
      name: { type: "string" },
      repo: { type: "string", multiple: true },
      clone: { type: "boolean" },
      agent: { type: "string" },
      schedule: { type: "boolean" },
      hour: { type: "string" },
    },
    strict: true,
  });
  const agentPreference = parseAgent(values.agent);
  const hour = parseIntFlag(values.hour, "--hour", 0, 23);
  const config = loadConfig();
  const server = normalizeServer(
    values.server ?? process.env.PARADIGMA_SERVER ?? config.server,
  );
  const approved = await pairDevice({
    server,
    name: (values.name ?? hostname()).slice(0, 100),
    io: defaultIo(),
    say: print,
  });

  config.server = server;
  config.runnerId = approved.runnerId;
  config.token = approved.runnerToken;
  config.publicKey = approved.publicKey;
  if (agentPreference) config.agent = agentPreference;
  await saveConfig(config);
  print(`Paired as runner ${approved.runnerId}. Config: ${configPath()}`);

  const agents = await detectAgents();
  print(`Agents found: ${describeAgents(agents)}`);
  if (!agents.length)
    print("! Install Claude Code, Codex or Cursor Agent before running.");

  const policy = await apiFor(config).policy();
  if (!policy.repos.length) {
    print(
      "No repositories have Autopilot enabled yet. Enable them in the dashboard, then run `paradigma repos scan`.",
    );
  } else {
    print("Repositories:");
    for (const line of await mapRepos(config, policy, {
      overrides: values.repo ?? [],
      clone: Boolean(values.clone),
    }))
      print(line);
  }
  await saveConfig(config);

  if (values.schedule)
    await scheduleCommand([
      "install",
      ...(hour === undefined ? [] : ["--hour", String(hour)]),
    ]);
  else
    print(
      "Next: `paradigma run --dry-run`, then `paradigma schedule install --hour 9` for a daily run.",
    );
}

async function runCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      once: { type: "boolean" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
      max: { type: "string" },
      "keep-worktrees": { type: "boolean" },
      "skip-checks": { type: "boolean" },
      scheduled: { type: "boolean" },
    },
    strict: true,
  });
  const summary = await runAutopilot({
    once: values.once,
    dryRun: values["dry-run"],
    agent: parseAgent(values.agent),
    max: parseIntFlag(values.max, "--max", 1, 20),
    keepWorktrees: values["keep-worktrees"],
    skipChecks: values["skip-checks"],
    scheduled: values.scheduled,
  });
  if (summary.outcomes.length) {
    const failed = summary.outcomes.filter((o) => o.status === "failed").length;
    print(`Done: ${summary.outcomes.length} task(s), ${failed} failed.`);
  }
}

async function statusCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    strict: true,
  });
  const config = loadConfig();
  if (values.json) {
    const account = await accountStatus(defaultIo(), true).catch(
      (error: Error) => ({ error: error.message }),
    );
    print(
      JSON.stringify({
        account,
        local: {
          config: configPath(),
          server: config.server,
          runnerId: config.runnerId ?? null,
          paused: config.paused,
          agent: config.agent ?? null,
          defaultProjectId: config.defaultProjectId ?? null,
          scheduleInstalled: isScheduleInstalled(),
          lastRunAt: config.lastRunAt ?? null,
          repos: Object.entries(config.repos).map(([id, path]) => ({
            repoId: id,
            fullName: config.repoNames[id] ?? null,
            path,
          })),
        },
      }),
    );
    return;
  }
  try {
    await accountStatus(defaultIo(), false);
  } catch (error) {
    print(`! ${(error as Error).message}`);
  }
  print(`Config:     ${configPath()}`);
  print(`Server:     ${config.server}`);
  print(`Runner:     ${config.runnerId ?? "not paired"}`);
  print(`Paused:     ${config.paused ? "yes" : "no"}`);
  print(`Agent:      ${config.agent ?? "auto"}`);
  print(
    `Schedule:   ${isScheduleInstalled() && config.schedule ? `daily at ${String(config.schedule.hour).padStart(2, "0")}:${String(config.schedule.minute).padStart(2, "0")}` : isScheduleInstalled() ? "installed" : "not installed"}`,
  );
  print(`Last run:   ${config.lastRunAt ?? "never"}`);
  print("Repositories:");
  const ids = Object.keys(config.repos);
  if (!ids.length) print("  none mapped");
  for (const id of ids)
    print(`  ${config.repoNames[id] ?? id} → ${config.repos[id]}`);
  if (!isPaired(config)) return;
  try {
    const policy = await apiFor(config).policy();
    for (const repo of policy.repos)
      print(
        `  [server] ${repo.fullName}: ${repo.enabled ? `level ${repo.level}` : "disabled"}${repo.paused ? ", paused" : ""}, runs at ${repo.runHour}:00 ${repo.timezone}${config.repos[repo.repoId] ? "" : " (not mapped)"}`,
      );
  } catch (error) {
    print(`! ${(error as Error).message}`);
  }
}

async function reposCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { clone: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const [action, fullName, path] = positionals;
  const config = requirePaired(loadConfig());
  if (!action) {
    let policy: PolicyResponse | undefined;
    try {
      policy = await apiFor(config).policy();
    } catch (error) {
      print(`! ${(error as Error).message}`);
    }
    if (!policy) {
      for (const [id, local] of Object.entries(config.repos))
        print(`${config.repoNames[id] ?? id} → ${local}`);
      return;
    }
    if (!policy.repos.length) print("No repositories have Autopilot enabled.");
    for (const repo of policy.repos)
      print(`${repo.fullName} → ${config.repos[repo.repoId] ?? "not mapped"}`);
    return;
  }
  const policy = await apiFor(config).policy();
  if (action === "scan") {
    for (const line of await mapRepos(config, policy, {
      overrides: [],
      clone: Boolean(values.clone),
    }))
      print(line);
    await saveConfig(config);
    return;
  }
  if (action !== "set" || !fullName || !path)
    throw new UsageError("Usage: paradigma repos set owner/name PATH");
  const override = parseRepoOverride(`${fullName}=${path}`);
  if (!override)
    throw new UsageError("Usage: paradigma repos set owner/name PATH");
  const repo = policy.repos.find(
    (r) => r.fullName.toLowerCase() === fullName.toLowerCase(),
  );
  if (!repo)
    throw new UsageError(`${fullName} does not have Autopilot enabled.`);
  const problem = await verifyClone(override.path, repo.fullName);
  if (problem) throw new UsageError(problem);
  await updateConfig((next) => {
    next.repos[repo.repoId] = override.path;
    next.repoNames[repo.repoId] = repo.fullName;
  });
  print(`${repo.fullName} → ${override.path}`);
}

async function scheduleCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { hour: { type: "string" }, minute: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const action = positionals[0];
  const config = loadConfig();
  const hour =
    parseIntFlag(values.hour, "--hour", 0, 23) ?? config.schedule?.hour ?? 9;
  const minute =
    parseIntFlag(values.minute, "--minute", 0, 59) ??
    config.schedule?.minute ??
    minuteFor(config.runnerId);
  const spec = scheduleSpec(hour, minute);
  if (action === "print") {
    print(describeSchedule(spec));
    return;
  }
  if (action === "install") {
    if (/[\\/]_npx[\\/]/.test(spec.programArgs[1] ?? ""))
      print(
        "! paradigma is running from the npx cache, which may be cleared. Install it with `npm i -g paradigma-cli` and run this again.",
      );
    const where = await installSchedule(spec);
    await updateConfig((next) => {
      next.schedule = { hour, minute };
    });
    print(
      `Scheduled a daily run at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${where}).`,
    );
    return;
  }
  if (action === "uninstall") {
    await uninstallSchedule();
    await updateConfig((next) => {
      next.schedule = undefined;
    });
    print("Removed the daily run.");
    return;
  }
  throw new UsageError("Usage: paradigma schedule install|uninstall|print");
}

async function doctor() {
  let ok = true;
  const check = (pass: boolean, label: string, hint?: string) => {
    if (!pass) ok = false;
    print(`${pass ? "✓" : "✗"} ${label}${!pass && hint ? ` — ${hint}` : ""}`);
  };
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 20, `Node ${process.versions.node}`, "Node 20+ is required");
  const gitVersion = await run("git", ["--version"], { timeoutMs: 10_000 });
  check(gitVersion.code === 0, "git installed", "install git");
  const gh = await run("gh", ["auth", "status"], { timeoutMs: 15_000 });
  check(
    gh.code === 0,
    "gh installed and logged in",
    gh.error ? "install the GitHub CLI" : "run `gh auth login`",
  );
  const agents = await detectAgents();
  check(
    agents.length > 0,
    `agents: ${describeAgents(agents)}`,
    "install Claude Code, Codex or Cursor Agent",
  );
  for (const agent of agents) {
    if (agent.name === "custom") continue;
    const status =
      agent.name === "claude"
        ? await run("claude", ["auth", "status"], { timeoutMs: 15_000 })
        : agent.name === "codex"
          ? await run("codex", ["login", "status"], { timeoutMs: 15_000 })
          : await run("cursor-agent", ["status"], { timeoutMs: 15_000 });
    const text = `${status.stdout}\n${status.stderr}`;
    const loggedIn =
      status.code === 0 && !/not logged in|"loggedIn":\s*false/i.test(text);
    check(loggedIn, `${agent.name} logged in`, `log in to ${agent.name}`);
  }
  const config = loadConfig();
  check(isPaired(config), "paired", "run `paradigma setup`");
  const api = apiFor(config);
  try {
    const key = await api.publicKey();
    check(true, `server reachable (${config.server})`);
    if (config.publicKey)
      check(
        key.publicKey === config.publicKey,
        "public key pinned and matches the server",
        "the server key changed; run `paradigma setup` again",
      );
  } catch (error) {
    check(
      false,
      `server reachable (${config.server})`,
      (error as Error).message,
    );
  }
  if (isPaired(config)) {
    try {
      const policy = await api.policy();
      check(true, "runner token valid");
      const unmapped = policy.repos.filter((r) => !config.repos[r.repoId]);
      check(
        unmapped.length === 0,
        `${policy.repos.length - unmapped.length}/${policy.repos.length} repositories mapped`,
        `map ${unmapped.map((r) => r.fullName).join(", ")} with \`paradigma repos set\``,
      );
    } catch (error) {
      check(false, "runner token valid", (error as Error).message);
    }
  }
  for (const [id, local] of Object.entries(config.repos))
    check(
      existsSync(local),
      `${config.repoNames[id] ?? id} clone exists`,
      `${local} is missing`,
    );
  check(
    isScheduleInstalled(),
    "daily schedule installed",
    "run `paradigma schedule install`",
  );
  if (config.paused)
    print("! Autopilot is paused locally (`paradigma resume`).");
  if (!ok) process.exitCode = 1;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      print(HELP);
      return;
    case "--version":
    case "-v":
    case "version":
      print(VERSION);
      return;
    case "setup":
      return setup(rest);
    case "run":
      return runCommand(rest);
    case "init":
      return withJsonErrors(rest, defaultIo(), (io) => initCommand(io, rest));
    case "status":
      return statusCommand(rest);
    case "repos":
      return reposCommand(rest);
    case "schedule":
      return scheduleCommand(rest);
    case "pause":
      await updateConfig((config) => {
        config.paused = true;
      });
      print(
        "Paused locally. Scheduled runs on this machine do nothing until `paradigma resume` (server-wide: `paradigma autopilot pause`).",
      );
      return;
    case "resume":
      await updateConfig((config) => {
        config.paused = false;
      });
      print("Resumed.");
      return;
    case "doctor":
      return doctor();
    case "logout":
      await updateConfig((config) => {
        config.runnerId = undefined;
        config.token = undefined;
        config.publicKey = undefined;
      });
      print(
        "Removed the runner token from this machine. Revoke the runner in the dashboard too, and run `paradigma schedule uninstall` to stop daily runs.",
      );
      return;
    default:
      if (isPlatformCommand(command))
        return platformCommand(command, rest, defaultIo());
      throw new UsageError(`Unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (
    error instanceof UsageError ||
    (error as { code?: string })?.code?.startsWith?.("ERR_PARSE_ARGS")
  ) {
    process.stderr.write(
      `${(error as Error).message}\n\nRun \`paradigma --help\` for usage.\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (error instanceof ActionRequired) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT_ACTION_REQUIRED;
    return;
  }
  process.stderr.write(`paradigma: ${(error as Error)?.message ?? error}\n`);
  process.exitCode = 1;
});
