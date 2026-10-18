import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  DEPLOY_HOST_LABELS,
  type DeployHost,
  deployHostFiles,
  detectDeployHost,
} from "./contract/deploy-host";
import { gitTopLevel } from "./detect";
import { type ExecResult, run } from "./exec";
import { EXIT_ACTION_REQUIRED, type Io, Reporter } from "./io";

/**
 * `paradigma doctor deploy`: how this site is published, and whether a merged
 * PR reaches production. Detection is static (file names and a few small
 * config files, never project code); the host check uses the person's own
 * host CLI login (`vercel api`, `netlify api`). Tokens are never read,
 * passed or printed: the host CLI uses its own credential store.
 */

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<ExecResult>;

export const defaultRunner: CommandRunner = (command, args, options) =>
  run(command, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
  });

export const VERCEL_AUTH_SETTINGS =
  "https://vercel.com/account/settings/authentication";
const CLI_TIMEOUT = 60_000;
/** `npx vercel@latest` may download the CLI first. */
const NPX_TIMEOUT = 180_000;
const MAX_FILE_BYTES = 256 * 1024;
const RECENT_COMMITS = 20;

export type DeployFixId =
  | "vercel_login"
  | "vercel_link"
  | "vercel_git_connect"
  | "vercel_commit_author"
  | "netlify_login"
  | "netlify_link"
  | "netlify_git_connect"
  | "cloudflare_git_connect"
  | "fly_workflow"
  | "render_auto_deploy"
  | "deploy_on_push";

export interface DeployFix {
  id: DeployFixId;
  /** One sentence for the person. */
  label: string;
  /** Exact command to run in the repository, when there is one. */
  command?: string;
  url?: string;
}

export interface DeployReport {
  host: DeployHost | null;
  label: string | null;
  /** Repo-relative files that gave the host away. */
  evidence: string[];
  appRoot: string;
  /** The host project or site this checkout is linked to (ids, never tokens). */
  project: { id: string; name: string | null; orgId: string | null } | null;
  /** The host's own Git integration; null when it could not be checked. */
  gitConnected: boolean | null;
  /** Git repository and production branch the host deploys from. */
  gitRepo: { repo: string; branch: string | null } | null;
  /** A GitHub Actions workflow that deploys to this host. */
  workflow: { path: string; onPush: boolean } | null;
  /** A merge to the default branch reaches production; null when unknown. */
  deploysOnMerge: boolean | null;
  /** The latest production deployment is BLOCKED (Vercel commit-author check). */
  blocked: boolean | null;
  /** Latest default-branch commit authored by a GitHub noreply address. */
  noreplyAuthor: string | null;
  cli: {
    name: "vercel" | "netlify" | "wrangler";
    available: boolean;
    loggedIn: boolean | null;
  } | null;
  /** The first fix's command (or its instruction when there is no command). */
  fix: string | null;
  fixes: DeployFix[];
  /** Commands to check by hand. */
  checks: string[];
  /** Something went wrong while checking (never includes credentials). */
  problem: string | null;
  /** With --fix: whether the fix ran and worked. */
  fixed?: boolean;
}

/** Whether the report asks the person to act (exit 3). */
export function needsDeployFix(report: DeployReport): boolean {
  return report.deploysOnMerge === false || report.blocked === true;
}

function readSmall(path: string): string | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readSmall(path);
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (value: unknown) =>
  typeof value === "string" && value ? value : null;

/** File names detection looks at, relative to an app root or the repo root. */
const CANDIDATES = [
  ".vercel/project.json",
  ".vercel/repo.json",
  ".netlify/state.json",
  "vercel.json",
  "netlify.toml",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
  "fly.toml",
  "render.yaml",
  "Dockerfile",
];

/** Repo-relative paths of the candidate files that exist, plus workflows. */
export function localDeployPaths(repoRoot: string, appRoot: string): string[] {
  const paths = new Set<string>();
  for (const root of appRoot ? [appRoot, ""] : [""])
    for (const name of CANDIDATES) {
      const path = root ? `${root}/${name}` : name;
      if (existsSync(join(repoRoot, path))) paths.add(path);
    }
  try {
    for (const name of readdirSync(join(repoRoot, ".github", "workflows")))
      paths.add(`.github/workflows/${name}`);
  } catch {}
  return [...paths];
}

/** Redacts anything token-shaped from host CLI output before showing it. */
export function safeMessage(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return line
    .replace(/\b[A-Za-z0-9]{24,}\b/g, "[redacted]")
    .replace(
      /(token|authorization)\s*[:=]\s*(?:bearer\s+)?\S+/gi,
      "$1 [redacted]",
    )
    .replace(/\bbearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 200);
}

const LOGIN_ERROR =
  /no existing credentials|not logged in|please log ?in|log in to|login required|run `?vercel login|run `?netlify login|not authenticated|unauthori[sz]ed|invalid token|token .*(expired|invalid)/i;

type VercelLink = {
  projectId: string;
  orgId: string | null;
  name: string | null;
  /** Directory holding `.vercel/`, where `vercel git connect` runs. */
  dir: string;
};

/** The Vercel project this checkout is linked to (`vercel link` writes it). */
export function readVercelLink(
  repoRoot: string,
  appRoot: string,
): VercelLink | null {
  for (const root of appRoot ? [appRoot, ""] : [""]) {
    const dir = join(repoRoot, root);
    const project = readJson(join(dir, ".vercel", "project.json"));
    const projectId = str(project?.projectId);
    if (projectId)
      return {
        projectId,
        orgId: str(project?.orgId),
        name: str(project?.projectName),
        dir,
      };
    // Monorepo link (`vercel link --repo`): pick the project for this app.
    const repo = readJson(join(dir, ".vercel", "repo.json"));
    const projects = Array.isArray(repo?.projects)
      ? (repo.projects as Record<string, unknown>[])
      : [];
    const want = root ? appRoot.slice(root.length + 1) : appRoot;
    const match =
      projects.find((p) => (str(p.directory) ?? "") === want) ??
      (projects.length === 1 ? projects[0] : undefined);
    const id = str(match?.id);
    if (id)
      return {
        projectId: id,
        orgId: str(repo?.orgId),
        name: str(match?.name),
        dir,
      };
  }
  return null;
}

type Vercel = { command: string; prefix: string[]; timeoutMs: number };

/**
 * The Vercel CLI to use: the installed one when it has `vercel api`, else
 * `npx vercel@latest` (same login). Never runs an unknown subcommand on an
 * old CLI, which would treat it as a path to deploy.
 */
async function resolveVercel(
  runner: CommandRunner,
  cwd: string,
): Promise<Vercel | null> {
  const probe = await runner("vercel", ["api", "--help"], {
    cwd,
    timeoutMs: CLI_TIMEOUT,
  });
  if (probe.error) return null;
  if (
    /vercel api \[endpoint\]|authenticated HTTP requests/i.test(
      `${probe.stdout}\n${probe.stderr}`,
    )
  )
    return { command: "vercel", prefix: [], timeoutMs: CLI_TIMEOUT };
  return {
    command: "npx",
    prefix: ["--yes", "vercel@latest"],
    timeoutMs: NPX_TIMEOUT,
  };
}

type ApiResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; login: boolean; message: string };

async function vercelApi(
  runner: CommandRunner,
  vercel: Vercel,
  cwd: string,
  path: string,
): Promise<ApiResult> {
  const result = await runner(
    vercel.command,
    [...vercel.prefix, "api", path, "--raw", "--non-interactive"],
    { cwd, timeoutMs: vercel.timeoutMs },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0) {
    try {
      const data = JSON.parse(result.stdout);
      if (data && typeof data === "object" && !Array.isArray(data))
        return { ok: true, data: data as Record<string, unknown> };
    } catch {}
    return { ok: false, login: false, message: "unexpected output" };
  }
  return {
    ok: false,
    login: LOGIN_ERROR.test(output),
    message: result.timedOut
      ? "timed out"
      : safeMessage(result.stderr || result.stdout) ||
        (result.error ?? "failed"),
  };
}

function teamQuery(orgId: string | null) {
  // Personal accounts have no team id; the project id alone resolves.
  return orgId?.startsWith("team_")
    ? `teamId=${encodeURIComponent(orgId)}`
    : "";
}

/** Most recent default-branch commit authored by a GitHub noreply address. */
async function noreplyAuthor(
  runner: CommandRunner,
  repoRoot: string,
): Promise<string | null> {
  for (const ref of ["origin/HEAD", "HEAD"]) {
    const result = await runner(
      "git",
      [
        "log",
        "-n",
        String(RECENT_COMMITS),
        "--first-parent",
        "--format=%ae",
        ref,
      ],
      { cwd: repoRoot, timeoutMs: 15_000 },
    );
    if (result.code !== 0) continue;
    return (
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .find((email) => /@users\.noreply\.github\.com$/i.test(email)) ?? null
    );
  }
  return null;
}

function emptyReport(appRoot: string): DeployReport {
  return {
    host: null,
    label: null,
    evidence: [],
    appRoot,
    project: null,
    gitConnected: null,
    gitRepo: null,
    workflow: null,
    deploysOnMerge: null,
    blocked: null,
    noreplyAuthor: null,
    cli: null,
    fix: null,
    fixes: [],
    checks: [],
    problem: null,
  };
}

function finish(report: DeployReport): DeployReport {
  const workflowShips = report.workflow?.onPush === true;
  report.deploysOnMerge =
    report.gitConnected === true || workflowShips
      ? true
      : report.gitConnected === false
        ? false
        : null;
  const first = report.fixes[0];
  report.fix = first ? (first.command ?? first.url ?? first.label) : null;
  return report;
}

const GIT_CONNECT_FIX: DeployFix = {
  id: "vercel_git_connect",
  label:
    "Connect the Vercel project to its GitHub repository so every merge deploys",
  command: "vercel git connect",
};

const COMMIT_AUTHOR_FIX: DeployFix = {
  id: "vercel_commit_author",
  label:
    "Connect GitHub in Vercel Account › Settings › Authentication so Vercel recognizes the commit author",
  url: VERCEL_AUTH_SETTINGS,
};

async function checkVercel(
  report: DeployReport,
  input: { repoRoot: string; runner: CommandRunner },
) {
  const { repoRoot, runner } = input;
  const link = readVercelLink(repoRoot, report.appRoot);
  report.checks.push("vercel project inspect", "vercel ls --prod");
  report.noreplyAuthor = await noreplyAuthor(runner, repoRoot);
  const addAuthorFix = () => {
    if (
      (report.blocked || report.noreplyAuthor) &&
      !report.fixes.some((f) => f.id === COMMIT_AUTHOR_FIX.id)
    )
      report.fixes.push(COMMIT_AUTHOR_FIX);
  };
  if (!link) {
    report.cli = null;
    if (report.workflow?.onPush) return addAuthorFix();
    report.fixes.push({
      id: "vercel_link",
      label:
        "Link this folder to its Vercel project, then connect it to GitHub",
      command: "vercel link && vercel git connect",
    });
    return addAuthorFix();
  }
  report.project = { id: link.projectId, name: link.name, orgId: link.orgId };
  const vercel = await resolveVercel(runner, link.dir);
  if (!vercel) {
    report.cli = { name: "vercel", available: false, loggedIn: null };
    if (!report.workflow?.onPush)
      report.fixes.push({
        id: "vercel_git_connect",
        label:
          "Install the Vercel CLI, then connect the project to its GitHub repository",
        command: "npx vercel@latest git connect",
      });
    return addAuthorFix();
  }
  const query = teamQuery(link.orgId);
  const project = await vercelApi(
    runner,
    vercel,
    link.dir,
    `/v9/projects/${encodeURIComponent(link.projectId)}${query ? `?${query}` : ""}`,
  );
  if (!project.ok) {
    report.cli = {
      name: "vercel",
      available: true,
      loggedIn: project.login ? false : null,
    };
    if (project.login)
      report.fixes.push({
        id: "vercel_login",
        label: "Log in to the Vercel CLI, then run this check again",
        command: "vercel login",
      });
    else report.problem = `vercel api: ${project.message}`;
    return addAuthorFix();
  }
  report.cli = { name: "vercel", available: true, loggedIn: true };
  report.project.name = str(project.data.name) ?? report.project.name;
  // `link` is null for a project deployed only from the CLI.
  const gitLink =
    project.data.link && typeof project.data.link === "object"
      ? (project.data.link as Record<string, unknown>)
      : null;
  if (gitLink) {
    const owner =
      str(gitLink.org) ?? str(gitLink.owner) ?? str(gitLink.projectNamespace);
    const name =
      str(gitLink.repo) ?? str(gitLink.slug) ?? str(gitLink.projectName);
    report.gitRepo = {
      repo: name
        ? owner
          ? `${owner}/${name}`
          : name
        : (str(gitLink.type) ?? "git"),
      branch: str(gitLink.productionBranch),
    };
  }
  report.gitConnected = gitLink !== null;

  const deployments = await vercelApi(
    runner,
    vercel,
    link.dir,
    `/v7/deployments?projectId=${encodeURIComponent(link.projectId)}&target=production&limit=1${query ? `&${query}` : ""}`,
  );
  if (deployments.ok) {
    const latest = Array.isArray(deployments.data.deployments)
      ? (deployments.data.deployments[0] as Record<string, unknown> | undefined)
      : undefined;
    report.blocked = latest
      ? (str(latest.readyState) ?? str(latest.state)) === "BLOCKED"
      : false;
  }
  if (!report.gitConnected && !report.workflow?.onPush)
    report.fixes.push(GIT_CONNECT_FIX);
  addAuthorFix();
}

async function checkNetlify(
  report: DeployReport,
  input: { repoRoot: string; runner: CommandRunner },
) {
  const { repoRoot, runner } = input;
  report.checks.push("netlify status");
  let siteId: string | null = null;
  for (const root of report.appRoot ? [report.appRoot, ""] : [""]) {
    siteId = str(
      readJson(join(repoRoot, root, ".netlify", "state.json"))?.siteId,
    );
    if (siteId) break;
  }
  const project = siteId
    ? { id: siteId, name: null as string | null, orgId: null }
    : null;
  report.project = project;
  const fallback = () => {
    if (report.workflow?.onPush) return;
    report.fixes.push(
      siteId
        ? {
            id: "netlify_git_connect",
            label:
              "Connect the Netlify site to its GitHub repository (continuous deployment)",
            command: "netlify init",
          }
        : {
            id: "netlify_link",
            label:
              "Link this folder to its Netlify site, then connect it to GitHub",
            command: "netlify link && netlify init",
          },
    );
  };
  if (!siteId || !project) return fallback();
  const result = await runner(
    "netlify",
    ["api", "getSite", "--data", JSON.stringify({ site_id: siteId })],
    { cwd: repoRoot, timeoutMs: CLI_TIMEOUT },
  );
  if (result.error) {
    report.cli = { name: "netlify", available: false, loggedIn: null };
    return fallback();
  }
  if (result.code !== 0) {
    const login = LOGIN_ERROR.test(`${result.stdout}\n${result.stderr}`);
    report.cli = {
      name: "netlify",
      available: true,
      loggedIn: login ? false : null,
    };
    if (login)
      report.fixes.push({
        id: "netlify_login",
        label: "Log in to the Netlify CLI, then run this check again",
        command: "netlify login",
      });
    else
      report.problem = `netlify api: ${safeMessage(result.stderr || result.stdout)}`;
    return;
  }
  report.cli = { name: "netlify", available: true, loggedIn: true };
  let site: Record<string, unknown> = {};
  try {
    site = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    report.problem = "netlify api: unexpected output";
    return;
  }
  project.name = str(site.name);
  const build = (site.build_settings ?? {}) as Record<string, unknown>;
  const repoUrl = str(build.repo_url);
  report.gitConnected = Boolean(repoUrl);
  report.gitRepo = repoUrl
    ? {
        repo: repoUrl.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, ""),
        branch: str(build.repo_branch),
      }
    : null;
  if (!report.gitConnected) fallback();
}

async function checkCloudflare(
  report: DeployReport,
  input: { runner: CommandRunner; repoRoot: string },
) {
  report.checks.push("npx wrangler pages project list");
  const probe = await input.runner("wrangler", ["--version"], {
    cwd: input.repoRoot,
    timeoutMs: CLI_TIMEOUT,
  });
  report.cli = {
    name: "wrangler",
    available: !probe.error && probe.code === 0,
    loggedIn: null,
  };
  if (report.workflow?.onPush) return;
  report.fixes.push({
    id: "cloudflare_git_connect",
    label:
      "Connect the repository in Cloudflare › Workers & Pages › your project › Settings › Builds (a Pages project made by direct upload cannot switch: deploy from a GitHub Actions workflow with cloudflare/wrangler-action instead)",
    url: "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
  });
}

/**
 * Static detection plus the host check. `runner` runs the host CLI and git;
 * tests pass a fake.
 */
export async function deployDoctor(input: {
  repoRoot: string;
  appRoot?: string;
  runner?: CommandRunner;
}): Promise<DeployReport> {
  const repoRoot = input.repoRoot;
  const appRoot = input.appRoot ?? "";
  const runner = input.runner ?? defaultRunner;
  const report = emptyReport(appRoot);
  const paths = localDeployPaths(repoRoot, appRoot);
  const contents: Record<string, string> = {};
  for (const path of deployHostFiles(paths)) {
    const text = readSmall(join(repoRoot, path));
    if (text !== null) contents[path] = text;
  }
  const detected = detectDeployHost({ paths, contents, appRoot });
  report.host = detected.host;
  report.label = detected.host ? DEPLOY_HOST_LABELS[detected.host] : null;
  report.evidence = detected.evidence;
  report.workflow = detected.workflow
    ? { path: detected.workflow.path, onPush: detected.workflow.onPush }
    : null;

  switch (detected.host) {
    case "vercel":
      await checkVercel(report, { repoRoot, runner });
      break;
    case "netlify":
      await checkNetlify(report, { repoRoot, runner });
      break;
    case "cloudflare":
      await checkCloudflare(report, { repoRoot, runner });
      break;
    case "github-pages":
    case "github-actions":
      if (!report.workflow?.onPush)
        report.fixes.push({
          id: "deploy_on_push",
          label: `Trigger ${report.workflow?.path ?? "the deploy workflow"} on push to the default branch so merges deploy`,
        });
      break;
    case "fly":
      if (!report.workflow?.onPush)
        report.fixes.push({
          id: "fly_workflow",
          label:
            "Deploy on push with a GitHub Actions workflow that runs `flyctl deploy --remote-only`",
          url: "https://fly.io/docs/launch/continuous-deployment-with-github-actions/",
        });
      break;
    case "render":
      if (!report.workflow?.onPush)
        report.fixes.push({
          id: "render_auto_deploy",
          label:
            "Check that the Render service is connected to this repository with Auto-Deploy on (Settings › Build & Deploy)",
        });
      break;
    default:
      if (!report.workflow?.onPush)
        report.fixes.push({
          id: "deploy_on_push",
          label:
            "Make sure a merge to the default branch deploys: connect the repository in your host, or add a deploy workflow",
        });
  }
  return finish(report);
}

/**
 * Runs `vercel git connect` non-interactively in the linked folder, then
 * re-checks. Only for a Vercel project that is linked and not connected.
 */
export async function connectVercelGit(input: {
  repoRoot: string;
  appRoot?: string;
  runner?: CommandRunner;
}): Promise<{ ok: boolean; message: string | null; report: DeployReport }> {
  const runner = input.runner ?? defaultRunner;
  const link = readVercelLink(input.repoRoot, input.appRoot ?? "");
  if (!link)
    return {
      ok: false,
      message: "No .vercel/project.json: run `vercel link` first.",
      report: await deployDoctor(input),
    };
  const vercel = (await resolveVercel(runner, link.dir)) ?? {
    command: "npx",
    prefix: ["--yes", "vercel@latest"],
    timeoutMs: NPX_TIMEOUT,
  };
  const args = [
    ...vercel.prefix,
    "git",
    "connect",
    "--yes",
    "--project",
    link.projectId,
  ];
  if (link.orgId?.startsWith("team_")) args.push("--scope", link.orgId);
  const result = await runner(vercel.command, args, {
    cwd: link.dir,
    timeoutMs: vercel.timeoutMs,
  });
  const report = await deployDoctor(input);
  const ok = result.code === 0 && report.gitConnected === true;
  return {
    ok,
    message: ok
      ? null
      : safeMessage(result.stderr || result.stdout) ||
        (result.timedOut ? "timed out" : "vercel git connect failed"),
    report: { ...report, fixed: ok },
  };
}

/** Whether `--fix` can run the first fix itself (only `vercel git connect`). */
export function canAutoFix(report: DeployReport): boolean {
  return (
    report.host === "vercel" &&
    report.project !== null &&
    report.gitConnected === false &&
    report.fixes[0]?.id === "vercel_git_connect"
  );
}

/** Human lines for a report. */
export function renderDeploy(report: DeployReport): string[] {
  const lines: string[] = [];
  if (!report.host) {
    lines.push(
      "Deploy: host not detected (no vercel.json, netlify.toml, wrangler config, deploy workflow or Dockerfile)",
    );
  } else {
    lines.push(
      `Deploy: ${report.label}${report.evidence.length ? ` (${report.evidence.join(", ")})` : ""}`,
    );
  }
  const name = report.project
    ? `${report.label} ${report.host === "netlify" ? "site" : "project"} ${report.project.name ?? report.project.id}`
    : report.label;
  if (report.gitConnected === true && report.gitRepo)
    lines.push(
      `✓ ${name} deploys from GitHub (${report.gitRepo.repo}${report.gitRepo.branch ? `, branch ${report.gitRepo.branch}` : ""})`,
    );
  else if (report.workflow?.onPush)
    lines.push(`✓ ${report.workflow.path} deploys on push`);
  else if (report.gitConnected === false)
    lines.push(
      `✗ ${name} is not connected to Git: merged PRs never reach the live site.`,
    );
  if (report.blocked)
    lines.push(
      "✗ The latest production deployment is BLOCKED: Vercel did not recognize the commit author.",
    );
  else if (report.noreplyAuthor && report.host === "vercel")
    lines.push(
      `! Recent commits are authored by ${report.noreplyAuthor}. Vercel blocks Git deploys from authors it cannot match to your team.`,
    );
  if (report.problem) lines.push(`! ${report.problem}`);
  for (const fix of report.fixes)
    lines.push(
      `  Fix: ${fix.label}${fix.command ? `: ${fix.command}` : ""}${fix.url ? ` (${fix.url})` : ""}`,
    );
  if (
    report.gitConnected === null &&
    !report.workflow?.onPush &&
    report.checks.length
  )
    lines.push(`  Check: ${report.checks.join(" · ")}`);
  return lines;
}

/** The compact `deploy` object for `init`'s done event. */
export function deploySummary(report: DeployReport) {
  return {
    host: report.host,
    gitConnected: report.gitConnected,
    deploysOnMerge: report.deploysOnMerge,
    ...(report.blocked === null ? {} : { blocked: report.blocked }),
    fix: report.fix,
    ...(report.fixed === undefined ? {} : { fixed: report.fixed }),
  };
}

/** One line for `init`'s human output. */
export function deployLine(report: DeployReport): string {
  if (!report.host)
    return "• Deploy host not detected: check that merges deploy (npx paradigma-cli doctor deploy)";
  if (report.blocked)
    return `✗ ${report.label}: the latest production deploy is BLOCKED (commit author). Fix: ${report.fix}`;
  if (report.deploysOnMerge === true)
    return report.noreplyAuthor && report.host === "vercel"
      ? `✓ Deploys with ${report.label} on merge (! connect GitHub in Vercel Account › Settings › Authentication: ${VERCEL_AUTH_SETTINGS})`
      : `✓ Deploys with ${report.label} on merge`;
  if (report.deploysOnMerge === false)
    return `✗ ${report.label} is not connected to Git, so merged fixes never go live. Fix: ${report.fix}`;
  return `• Deploys with ${report.label}${report.fix ? `; to make merges deploy: ${report.fix}` : ""}`;
}

/** `paradigma doctor deploy [--json] [--fix] [--yes] [--app-root P] [--dir P]` */
export async function doctorDeployCommand(
  io: Io,
  args: string[],
  runner: CommandRunner = defaultRunner,
) {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      fix: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "app-root": { type: "string" },
      dir: { type: "string" },
    },
    strict: true,
  });
  const out = new Reporter(io, Boolean(values.json));
  const dir = values.dir ? resolve(io.cwd, values.dir) : io.cwd;
  const repoRoot = (await gitTopLevel(dir)) ?? dir;
  const rel = relative(repoRoot, dir).split(sep).join("/");
  const appRoot =
    values["app-root"]?.replace(/^\/+|\/+$/g, "") ??
    (rel.startsWith("..") ? "" : rel);
  let report = await deployDoctor({ repoRoot, appRoot, runner });

  if (values.fix && canAutoFix(report)) {
    const run =
      values.yes || (await out.confirm("Run `vercel git connect` now?", false));
    if (run) {
      out.line("Running vercel git connect…");
      const result = await connectVercelGit({ repoRoot, appRoot, runner });
      report = result.report;
      if (!result.ok) {
        report.fixed = false;
        if (result.message)
          report.problem = `vercel git connect: ${result.message}`;
      }
    } else {
      report.fixed = false;
      if (out.json) report.problem = "Pass --yes to run `vercel git connect`.";
    }
  }

  out.result({ ok: true, ...report }, () => {
    for (const line of renderDeploy(report)) out.line(line);
    if (!values.fix && canAutoFix(report))
      out.line("  Or run: npx paradigma-cli doctor deploy --fix");
  });
  if (needsDeployFix(report)) process.exitCode = EXIT_ACTION_REQUIRED;
}
