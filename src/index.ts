import { parseArgs } from "node:util";
import { ApiClient } from "./api";
import { checkCommand } from "./check";
import {
  accountStatus,
  isPlatformCommand,
  platformCommand,
  withJsonErrors,
} from "./commands";
import { configPath, DEFAULT_SERVER, loadConfig, updateConfig } from "./config";
import { doctorDeployCommand } from "./deploy";
import { run } from "./exec";
import { fixCommand } from "./fix-command";
import { gscAiCommand } from "./gsc-ai";
import { initCommand } from "./init";
import {
  ActionRequired,
  defaultIo,
  EXIT_ACTION_REQUIRED,
  UsageError,
} from "./io";
import { tasksCommand } from "./tasks";
import { VERSION } from "./version";

const HELP = `paradigma ${VERSION} — Paradigma: SEO and AI search monitoring, set up and run by your agent

Get started (in your repository):
  npx paradigma-cli init                     sign in, create the project, verify the domain

Free checks (no sign-in):
  paradigma check seo|aeo|geo|agents <domain> [--json] [--rescan]
                 one pillar from the free public scan: score, label, what to
                 fix first and the suggestions count; --json prints the API JSON
  paradigma check risk <domain> [--json]
                 the penalty risk checker: practices search engines punish,
                 with evidence and the policy; private, one free use per 30
                 days (your own projects: 30 an hour when signed in)
  paradigma check all [--project ID] [--wait SECONDS] [--json]
                 all four pillars of your project (signed in): scores, counts
                 and what to fix first; requests a scan and waits (180 s) when
                 none completed yet (exit 3 = still running)

Setup:
  paradigma init [--token T] [--server URL] [--url U] [--brand B] [--category C]
                 [--use-case U] [--app-root PATH] [--mcp claude|codex|cursor|none]
                 [--yes] [--fix-deploy] [--no-pr] [--wait SECONDS] [--dir PATH]
                 [--level 0|1|2|3 [--confirm-full-autopilot]] [--json]
                 --fix-deploy with --yes runs \`vercel git connect\` when the
                 Vercel project is not connected to Git (default: only reports)
                 --level turns Autopilot on for the repository (asked after the
                 scan in a terminal; level 0 needs the confirmation flag); fixes
                 are made by the Paradigma agent, hosted or in your GitHub
                 Actions
  paradigma doctor deploy [--json] [--fix [--yes]] [--app-root PATH]
                 how the site is published (Vercel, Netlify, Cloudflare, GitHub
                 Pages, Fly.io, Render, Docker) and whether a merged PR goes
                 live; checks the host's Git link with your own host CLI login
                 (never reads the token); --fix runs \`vercel git connect\`
                 after confirming (exit 3 = merges do not deploy)
  paradigma status [--json]                  account checklist and this machine's sign-in
  paradigma links [--json]                   hand-off links (GitHub App, Google, Slack, billing)

Projects and domain:
  paradigma projects list|create|update [--project ID] [--repo owner/name]
                 [--app-root PATH] [--url U] [--brand B] [--category C] [--use-case U]
                 [--sitemap URL] [--alias NAME]... [--competitor NAME]...
  paradigma verify [--method dns|file|meta]... [--project ID]   (exit 3 = not yet)

Tasks (each project's tasks; the ones that need you, do them with your agent):
  paradigma tasks [--project ID | --repo owner/name] [--all] [--json]
                 tasks by project with counts (default: this checkout's project,
                 else all; --all includes finished ones)
  paradigma tasks start <task id> [--checkout] [--json]
                 takes a task for your current agent and prints its brief: branch,
                 allowed paths, diff budget, acceptance, instructions and the
                 finish commands; --checkout creates the branch in this clean clone
  paradigma tasks finish <task id> --pr URL | --done | --skip --reason "…"
                 | --failed --reason "…"          (reason: one line, 200 chars)
  paradigma tasks release <task id>          give a started task back to the queue
  paradigma tasks prompt [--project ID] [--copy]
                 the prompt that hands the open tasks to an agent (--copy: clipboard)

Google (Search Console and Analytics, set up for you):
  paradigma google [--project ID] [--no-open] [--wait SECONDS]
                 one Google consent; connects existing properties or opens the
                 verification-file PR and creates the GA4 property
  paradigma google check [--project ID]      finish Search Console after deploy
  paradigma google account <accountId> [--time-zone Area/City] [--project ID]

IndexNow (tell Bing, Yandex, Naver, Seznam and Yep what each deploy changed):
  paradigma indexnow [status] [--project ID]  state and recent production deploys
                                             (exit 3 = not set up or key file not live)
  paradigma indexnow setup [--project ID]     opens the key-file PR (exit 3 = merge and deploy it)
  paradigma indexnow on|off [--project ID]    resume or pause submissions after deploys

Google indexing (Search Console URL Inspection on your own Google connection):
  paradigma index [--project ID] [--json]
                 pages Google indexed out of those checked, by reason, and
                 today's up to 10 pages to request, each with its Search Console
                 link where you click "Request indexing" (exit 3 = some left)
  paradigma index requested <url>... [--undo] [--project ID]
                 mark pages as requested so tomorrow's list moves on;
                 re-checked after 3 and 7 days
  paradigma index check [--project ID]       run today's inspection batch now, within budget

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
  paradigma connect bing [--project ID]
                 with nothing piped, opens "Connect Bing" (Microsoft consent in
                 the browser) and waits; --key-env NAME uses an API key instead.
                 When the Bing account lacks the site, Paradigma adds it and
                 queues the verification file (setup task setup/bing-verify)
  paradigma gsc-ai [--project ID] [--json]
                 last Search Console AI report import, and the exact export
                 steps with the report link (exit 3 = due: none or 30+ days old)
  paradigma gsc-ai import <file.zip|file.csv>... [--from D --to D] [--project ID] [--json]
                 sends the Generative AI export (up to 5 files, 512 KB) for
                 Paradigma to read; file contents are never printed. --from/--to
                 (YYYY-MM-DD) only when the export has no Chart.csv

AI search (GEO):
  paradigma connect ai [--project ID | --all] [--yes] [--own]
                 on Pro and Agency, AI visibility is included: Paradigma pays,
                 nothing to connect. --own (or other plans) uploads AI keys
                 already in your environment (names shown, never values), then
                 one OpenRouter consent covers the missing engines
  paradigma geo prompts [list [--state all|active|inactive] | add "TEXT"]
  paradigma geo schedule --engine E --daily 1|3|5|10 [--every 7|1] --accept-charges | --off
                 --every: days between runs, google_ai_mode only (default weekly)
  paradigma geo sample --engine E --prompt ID --accept-charges
                 engines: gemini, openai, claude, perplexity, google_ai_overview,
                 google_ai_mode

Alerts and billing (organization owner):
  paradigma alerts budget 0|1|2|3 [--org ID]
  paradigma billing checkout --plan pro|agency [--org ID] [--open]
  paradigma billing portal [--org ID] [--open]

Autopilot policy on the server:
  paradigma autopilot level 0|1|2|3 [--repo owner/name]
                 3 Notify, 2 Open PR, 1 Autopilot, 0 Full autopilot
                 (level 0 needs --confirm-full-autopilot and an allowlisted account)
                 the repository then keeps its own level (overrides the default)
  paradigma autopilot default 0|1|2|3|off [--org ID] [--confirm-full-autopilot]
                 workspace default for every repository that follows it,
                 including new ones; needs write access to every repository
  paradigma autopilot follow-default [--repo owner/name] [--confirm-full-autopilot]
                 the repository follows the workspace default again
  paradigma autopilot pause [--reason TEXT] | resume [--repo owner/name]

Agent MCP:
  paradigma mcp install --agent claude|codex|cursor

GitHub Action (the Paradigma agent in your own CI):
  paradigma fix --task <token> [--api-url URL] [--build CMD] [--test CMD]
                 runs one fix that Paradigma dispatched to your workflow, on
                 the Paradigma model (or your own key, if you turned that on),
                 then opens the PR with GITHUB_TOKEN (the Paradigma GitHub
                 Action calls it)

Sign-in:
  paradigma doctor                           setup checks: Node, git, sign-in, server
  paradigma logout                           removes this machine's CLI credential
  paradigma --help | --version

Agents: add --json for machine-readable output (init streams one JSON event per
line). Exit codes: 0 ok, 1 failed, 2 usage, 3 needs the person or more input.

Environment:
  PARADIGMA_HOME           config directory (default ~/.paradigma)
  PARADIGMA_SERVER         server URL used by init (default ${DEFAULT_SERVER})
`;

function print(line = "") {
  process.stdout.write(`${line}\n`);
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
          signedIn: Boolean(config.token),
          defaultProjectId: config.defaultProjectId ?? null,
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
  print(`Signed in:  ${config.token ? "yes" : "no (npx paradigma-cli init)"}`);
}

/** Setup checks: Node, git, the saved credential and the server (with its pinned key). */
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
  const config = loadConfig();
  check(Boolean(config.token), "signed in", "run `npx paradigma-cli init`");
  const api = new ApiClient({
    server: config.server,
    userAgent: `paradigma-cli/${VERSION}`,
  });
  try {
    const key = await api.publicKey();
    check(true, `server reachable (${config.server})`);
    if (config.publicKey)
      check(
        key.publicKey === config.publicKey,
        "public key pinned and matches the server",
        "the server key changed; run `npx paradigma-cli init` again",
      );
  } catch (error) {
    check(
      false,
      `server reachable (${config.server})`,
      (error as Error).message,
    );
  }
  if (config.token) {
    try {
      await accountStatus(defaultIo(), true);
      check(true, "CLI credential valid");
    } catch (error) {
      check(false, "CLI credential valid", (error as Error).message);
    }
  }
  print("Deploy pipeline: paradigma doctor deploy");
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
    case "init":
      return withJsonErrors(rest, defaultIo(), (io) => initCommand(io, rest));
    case "fix": {
      const code = await fixCommand(defaultIo(), rest);
      if (code) process.exitCode = code;
      return;
    }
    case "check":
      return withJsonErrors(rest, defaultIo(), (io) => checkCommand(io, rest));
    case "status":
      return statusCommand(rest);
    case "tasks":
      return withJsonErrors(rest, defaultIo(), (io) => tasksCommand(io, rest));
    case "gsc-ai":
      return withJsonErrors(rest, defaultIo(), (io) => gscAiCommand(io, rest));
    case "doctor":
      if (rest[0] === "deploy")
        return withJsonErrors(rest, defaultIo(), (io) =>
          doctorDeployCommand(io, rest.slice(1)),
        );
      return doctor();
    case "logout":
      await updateConfig((config) => {
        config.runnerId = undefined;
        config.token = undefined;
        config.publicKey = undefined;
      });
      print(
        "Removed the CLI credential from this machine. Revoke it in the dashboard too (Agents).",
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
