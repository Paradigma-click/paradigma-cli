import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { briefSections } from "./brief";
import { type Ctx, context, resolveProject } from "./commands";
import { chooseAppRoot, detectRepo } from "./detect";
import { run } from "./exec";
import { ActionRequired, type Io, UsageError } from "./io";
import { PlatformError } from "./platform";
import {
  type FinishTaskBody,
  type ProjectTasks,
  repoLabel,
  type StartedTask,
  type TaskSummary,
  type TasksResponse,
} from "./tasks-api";
import { cleanLine } from "./text";

/**
 * Project tasks: `paradigma tasks` lists each project's tasks; the person's current agent takes
 * one with `tasks start` and closes it with `tasks finish` or `tasks release`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Server ids that go into paths and file names: letters, digits, `_` and `-` only. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const PR_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9]\d{0,9}\/?$/;
/** A branch name safe to pass to git: no `..`, no leading `-`, no trailing `.` `/` or `.lock`. */
const BRANCH =
  /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])(?<!\.lock)$/;
export const MAX_REASON = 200;

// ─── Argument validation (pure) ─────────────────────────────────────────────

export function parseTaskId(value: string | undefined, usage: string): string {
  if (!value) throw new UsageError(usage);
  if (!SAFE_ID.test(value))
    throw new UsageError(
      `${value} is not a task id (see \`paradigma tasks\`).`,
    );
  return value;
}

/** A github.com pull request URL, else a usage error. */
export function validatePrUrl(url: string): string {
  const value = url.trim();
  if (!PR_URL.test(value))
    throw new UsageError(
      "--pr must be a GitHub pull request URL, like https://github.com/owner/repo/pull/123",
    );
  return value.replace(/\/$/, "");
}

/** A short reason for the dashboard: one line, at most 200 characters, no code. */
export function validateReason(reason: string): string {
  const value = reason.trim();
  if (!value) throw new UsageError("--reason must not be empty.");
  if (/[\r\n]/.test(value))
    throw new UsageError("--reason must be a single line.");
  if (value.includes("```") || /\p{Cc}/u.test(value))
    throw new UsageError(
      "--reason must be plain text (no code fences or control characters).",
    );
  if (value.length > MAX_REASON)
    throw new UsageError(
      `--reason must be at most ${MAX_REASON} characters (it has ${value.length}).`,
    );
  return value;
}

/** The finish body from `--pr URL | --done | --skip --reason R | --failed --reason R`. */
export function finishBody(values: {
  pr?: string;
  done?: boolean;
  skip?: boolean;
  failed?: boolean;
  reason?: string;
}): FinishTaskBody {
  const chosen = [
    values.pr !== undefined,
    values.done,
    values.skip,
    values.failed,
  ].filter(Boolean).length;
  if (chosen !== 1)
    throw new UsageError(
      'Pass exactly one of --pr URL, --done, --skip --reason "…" or --failed --reason "…".',
    );
  const reason =
    values.reason === undefined ? undefined : validateReason(values.reason);
  if ((values.skip || values.failed) && !reason)
    throw new UsageError(
      `--${values.skip ? "skip" : "failed"} needs --reason "…" (one line, at most ${MAX_REASON} characters).`,
    );
  const extra = reason ? { reason } : {};
  if (values.pr !== undefined)
    return { status: "pr_opened", prUrl: validatePrUrl(values.pr), ...extra };
  if (values.done) return { status: "done", ...extra };
  return { status: values.skip ? "skipped" : "failed", ...extra };
}

// ─── Rendering (pure) ───────────────────────────────────────────────────────

const CHIPS: Record<string, string> = {
  queued: "queued",
  needs_you: "needs you",
  running: "running",
  pr_opened: "PR open",
  merged: "merged",
  live: "live",
  failed: "failed",
  skipped: "skipped",
};

/** Short status text for a task: "queued", "needs you", "PR open", "running (agent)"… */
export function statusChip(task: Pick<TaskSummary, "status" | "startedBy">) {
  const chip =
    CHIPS[task.status] ?? cleanLine(task.status.replaceAll("_", " "));
  return task.status === "running" && task.startedBy === "agent"
    ? `${chip} (agent)`
    : chip;
}

function oneLine(text: string | null | undefined) {
  return cleanLine((text ?? "").replace(/\s+/g, " ")).trim();
}

function autopilotLabel(project: ProjectTasks["project"]) {
  const autopilot = project.autopilot;
  if (!autopilot) return null;
  return autopilot.enabled
    ? `Autopilot level ${autopilot.level ?? "?"}`
    : "Autopilot off";
}

/** One task line: status chip, id, title, then the PR link or the planned date. */
export function taskLine(task: TaskSummary): string {
  const after = task.prUrl
    ? `  ${oneLine(task.prUrl)}`
    : task.status === "queued" && task.plannedFor
      ? `  (planned ${oneLine(task.plannedFor).slice(0, 10)})`
      : "";
  const suggestion = task.mode === "suggestion" ? " (suggestion)" : "";
  return `  ${statusChip(task).padEnd(15)} ${task.id}  ${oneLine(task.title)}${suggestion}${after}`;
}

/** A setup step: its line, why it matters, then the command or who does it. */
export function setupLines(task: TaskSummary): string[] {
  const setup = task.setup;
  const lines = [taskLine(task)];
  if (!setup) return lines;
  const pad = " ".repeat(18);
  if (setup.why) lines.push(`${pad}${oneLine(setup.why)}`);
  if (setup.command)
    lines.push(
      `${pad}${setup.who === "you" ? "You run" : "Run"}: ${oneLine(setup.command)}`,
    );
  else if (setup.who === "agent") lines.push(`${pad}Agent can do this`);
  if (setup.alternative)
    lines.push(
      `${pad}${oneLine(setup.alternative.text)}: ${oneLine(setup.alternative.url)}`,
    );
  return lines;
}

/** `paradigma tasks` human output: each project with its counts and tasks. */
export function formatTasks(
  response: TasksResponse,
  options: { all?: boolean } = {},
): string[] {
  const lines: string[] = [];
  for (const group of response.projects) {
    const { project, counts, tasks } = group;
    const header = [
      oneLine(project.name) || project.id,
      oneLine(project.url),
      oneLine(repoLabel(project.repo)),
      autopilotLabel(project),
    ].filter(Boolean);
    if (lines.length) lines.push("");
    lines.push(header.join("  ·  "));
    lines.push(
      `  ${counts.open} open: ${counts.queued} queued, ${counts.needsYou} need you, ${counts.running} running · ${counts.done} done · project ${project.id}`,
    );
    if (project.verified === false)
      lines.push(
        `  Locked until the domain is verified: paradigma verify --project ${project.id}`,
      );
    if (!tasks.length)
      lines.push(options.all ? "  No tasks yet." : "  No open tasks.");
    const setup = tasks.filter((task) => task.setup && !task.setup.done);
    const rest = tasks.filter((task) => !task.setup || task.setup.done);
    if (setup.length) {
      lines.push("  Setup:");
      for (const task of setup) lines.push(...setupLines(task));
      if (rest.length) lines.push("  Tasks:");
    }
    for (const task of rest) lines.push(taskLine(task));
  }
  if (!response.projects.length) return lines;
  const workable = response.projects.filter((group) =>
    group.tasks.some((t) => t.status === "queued" || t.status === "needs_you"),
  );
  if (workable.length) {
    const projectId =
      workable.length === 1 ? workable[0].project.id : "<project id>";
    lines.push("");
    lines.push("Do one with this agent:   paradigma tasks start <task id>");
    lines.push(
      `Or hand them all to it:   paradigma tasks prompt --project ${projectId} --copy`,
    );
  }
  return lines;
}

/** The commands that close a started task (printed after the instructions). */
export function finishCommands(taskId: string) {
  return {
    pr: `paradigma tasks finish ${taskId} --pr <pull request URL>`,
    done: `paradigma tasks finish ${taskId} --done`,
    skip: `paradigma tasks finish ${taskId} --skip --reason "<one line why>"`,
    failed: `paradigma tasks finish ${taskId} --failed --reason "<one line why>"`,
    release: `paradigma tasks release ${taskId}`,
  };
}

/** Git commands that create the task's branch from the default branch. */
export function branchCommands(task: StartedTask): string[] {
  const base = task.repo?.defaultBranch ?? "main";
  return [
    `git fetch origin ${base}`,
    `git switch -c ${task.branch} origin/${base}`,
  ];
}

/** `paradigma tasks start` human output: the brief for the agent that does the task. */
export function formatStartedTask(
  task: StartedTask,
  options: { checkedOut?: boolean; checkoutProblem?: string | null } = {},
): string[] {
  const repo = task.repo ? `${task.repo.owner}/${task.repo.name}` : null;
  const project = task.project
    ? [oneLine(task.project.name), oneLine(task.project.url)]
        .filter(Boolean)
        .join("  ")
    : null;
  const lines = [`Task:      ${oneLine(task.title)}`];
  if (project) lines.push(`Project:   ${project}`);
  if (repo)
    lines.push(
      `Repo:      ${repo}${task.repo?.appRoot ? ` (app in ${oneLine(task.repo.appRoot)}/)` : ""}`,
    );
  const kind = [task.category, task.risk ? `risk ${task.risk}` : null]
    .filter(Boolean)
    .map((value) => oneLine(value));
  if (kind.length) lines.push(`Kind:      ${kind.join(", ")}`);
  if (task.findingUrl) lines.push(`Finding:   ${oneLine(task.findingUrl)}`);
  if (task.leaseExpiresAt)
    lines.push(
      `Lease:     until ${oneLine(task.leaseExpiresAt)} (finish or release it before then)`,
    );
  lines.push("");
  lines.push(
    options.checkedOut
      ? `1. Branch: switched to ${task.branch} (from origin/${task.repo?.defaultBranch ?? "main"}).`
      : `1. In your clone of ${repo ?? "the repository"}, create the branch from the default branch:`,
  );
  if (!options.checkedOut) {
    if (options.checkoutProblem)
      lines.push(`   (--checkout did not run: ${options.checkoutProblem})`);
    for (const command of branchCommands(task)) lines.push(`   ${command}`);
  }
  lines.push("2. Change only files matching:");
  if (task.allowedPaths.length)
    for (const path of task.allowedPaths) lines.push(`   - ${oneLine(path)}`);
  else lines.push("   - (no limit given; keep the change small)");
  if (task.diffBudget)
    lines.push(
      `3. Diff budget: at most ${task.diffBudget.maxFiles} file(s) and ${task.diffBudget.maxLines} changed line(s).`,
    );
  else lines.push("3. Diff budget: keep the change small and focused.");
  lines.push("4. Done when:");
  if (task.acceptance.length)
    for (const item of task.acceptance) lines.push(`   - ${oneLine(item)}`);
  else lines.push("   - the instructions below are met");
  lines.push("");
  lines.push("Instructions:");
  for (const line of task.instructions.split(/\r?\n/))
    lines.push(`  ${cleanLine(line)}`.trimEnd());
  if (task.brief) {
    lines.push("");
    for (const section of briefSections(task.brief, { checkHtml: "mcp" })) {
      for (const line of section.split(/\r?\n/))
        lines.push(`  ${cleanLine(line)}`.trimEnd());
      lines.push("");
    }
  }
  const commands = finishCommands(task.id);
  lines.push("");
  lines.push("When you are done, run one of:");
  lines.push(`  ${commands.pr}`);
  lines.push(`      after you open the pull request (gh pr create)`);
  lines.push(`  ${commands.done}`);
  lines.push("      finished without a pull request");
  lines.push(`  ${commands.skip}`);
  lines.push("      nothing to change, or the task does not apply");
  lines.push(`  ${commands.failed}`);
  lines.push("      you could not do it");
  lines.push(`  ${commands.release}`);
  lines.push("      stop without finishing: the task goes back to the queue");
  return lines;
}

// ─── Clipboard ──────────────────────────────────────────────────────────────

/** Clipboard commands to try, in order, for this platform. Pure. */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[][] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip"]];
  const x11 = [
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ];
  return env.WAYLAND_DISPLAY ? [["wl-copy"], ...x11] : [...x11, ["wl-copy"]];
}

/** Writes `input` to a command's stdin; true when it exits 0 (false when it is missing). */
export function pipeTo(command: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command[0], command.slice(1), {
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Copies text with the first clipboard tool that works; its name, else null. */
export async function copyToClipboard(
  text: string,
  options: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    pipe?: (command: string[], input: string) => Promise<boolean>;
  } = {},
): Promise<string | null> {
  const pipe = options.pipe ?? pipeTo;
  for (const command of clipboardCommands(
    options.platform ?? process.platform,
    options.env ?? process.env,
  ))
    if (await pipe(command, text)) return command[0];
  return null;
}

/** Process hooks, replaceable in tests. */
export const hooks = {
  copy: copyToClipboard,
};

// ─── Commands ───────────────────────────────────────────────────────────────

/** The project for this checkout, when one matches its git remote and folder. */
async function projectForCwd(ctx: Ctx): Promise<string | null> {
  const repo = await detectRepo(ctx.io.cwd);
  if (!repo) return null;
  try {
    const { projects } = await ctx.client.projects();
    const inRepo = projects.filter(
      (p) => p.repoFullName?.toLowerCase() === repo.fullName.toLowerCase(),
    );
    const root = chooseAppRoot(
      inRepo.map((p) => p.appRoot),
      repo.relativeDir,
    );
    return inRepo.find((p) => p.appRoot === root)?.id ?? null;
  } catch {
    return null;
  }
}

async function listTasks(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      project: { type: "string" },
      repo: { type: "string" },
      all: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > (positionals[0] === "list" ? 1 : 0))
    throw new UsageError(
      "Usage: paradigma tasks [--project ID | --repo owner/name] [--all] [--json]",
    );
  if (values.project && values.repo)
    throw new UsageError("Pass --project or --repo, not both.");
  if (values.project && !UUID.test(values.project))
    throw new UsageError("--project must be a project id (UUID).");
  if (values.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo))
    throw new UsageError("--repo must look like owner/name.");
  const ctx = context(io, Boolean(values.json));
  const status = values.all ? "all" : "open";
  const project =
    values.project ?? (values.repo ? null : await projectForCwd(ctx));
  let response = await ctx.client.tasks({
    ...(project ? { project } : {}),
    status,
  });
  if (values.repo) {
    const wanted = values.repo.toLowerCase();
    response = {
      ...response,
      projects: response.projects.filter(
        (group) => repoLabel(group.project.repo)?.toLowerCase() === wanted,
      ),
    };
  }
  ctx.out.result(response, () => {
    if (!response.projects.length) {
      ctx.out.line(
        values.repo
          ? `No Paradigma project for ${values.repo}. Add it with \`npx paradigma-cli init\` in its clone.`
          : "No projects yet. Run `npx paradigma-cli init` in your repository.",
      );
      return;
    }
    for (const line of formatTasks(response, { all: values.all }))
      ctx.out.line(line);
  });
}

/** Creates the task branch in this checkout when it is a clean clone of the task's repository. */
async function checkoutBranch(
  cwd: string,
  task: StartedTask,
): Promise<string | null> {
  if (!task.repo) return "the server did not say which repository";
  const fullName = `${task.repo.owner}/${task.repo.name}`;
  const base = task.repo.defaultBranch;
  if (!BRANCH.test(task.branch) || !BRANCH.test(base))
    return "the branch name is not one this CLI passes to git";
  const repo = await detectRepo(cwd);
  if (!repo || repo.fullName.toLowerCase() !== fullName.toLowerCase())
    return `this directory is not a clone of ${fullName}`;
  const status = await run("git", ["status", "--porcelain"], {
    cwd: repo.root,
    timeoutMs: 30_000,
  });
  if (status.code !== 0) return "git status failed";
  if (status.stdout.trim()) return "the working tree has uncommitted changes";
  const fetched = await run("git", ["fetch", "--quiet", "origin", base], {
    cwd: repo.root,
    timeoutMs: 120_000,
  });
  if (fetched.code !== 0)
    return `git fetch origin ${base} failed: ${oneLine(fetched.stderr).slice(0, 200)}`;
  const switched = await run(
    "git",
    ["switch", "--quiet", "-c", task.branch, `origin/${base}`],
    { cwd: repo.root, timeoutMs: 30_000 },
  );
  if (switched.code !== 0)
    return `git switch failed: ${oneLine(switched.stderr).slice(0, 200)}`;
  return null;
}

async function startTask(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean" }, checkout: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const taskId = parseTaskId(
    positionals[1],
    "Usage: paradigma tasks start <task id> [--checkout] [--json]",
  );
  const ctx = context(io, Boolean(values.json));
  let response: Awaited<ReturnType<typeof ctx.client.startTask>>;
  try {
    response = await ctx.client.startTask(taskId);
  } catch (error) {
    if (error instanceof PlatformError && error.status === 403)
      throw new ActionRequired(
        `${error.message} The project is locked until its domain is verified: run \`paradigma verify --project <project id>\` (see \`paradigma tasks\`).`,
        { error: error.code },
      );
    if (error instanceof PlatformError && error.status === 409)
      throw new PlatformError(
        error.code,
        `${error.message} The task is already running (Paradigma's agent or another agent has it); see \`paradigma tasks --all\`.`,
        409,
      );
    throw error;
  }
  const { task } = response;
  let checkout: { ok: boolean; branch: string; problem: string | null } | null =
    null;
  if (values.checkout) {
    const problem = await checkoutBranch(io.cwd, task);
    checkout = { ok: !problem, branch: task.branch, problem };
  }
  ctx.out.result(
    {
      ...response,
      commands: {
        branch: branchCommands(task),
        ...finishCommands(task.id),
      },
      ...(checkout ? { checkout } : {}),
    },
    () => {
      for (const line of formatStartedTask(task, {
        checkedOut: checkout?.ok,
        checkoutProblem: checkout?.problem,
      }))
        ctx.out.line(line);
    },
  );
}

async function finishTask(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      pr: { type: "string" },
      done: { type: "boolean" },
      skip: { type: "boolean" },
      failed: { type: "boolean" },
      reason: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const taskId = parseTaskId(
    positionals[1],
    'Usage: paradigma tasks finish <task id> (--pr URL | --done | --skip --reason "…" | --failed --reason "…")',
  );
  const body = finishBody(values);
  const ctx = context(io, Boolean(values.json));
  const result = await ctx.client.finishTask(taskId, body);
  ctx.out.result({ ok: true, taskId, ...body, ...result }, () => {
    const words: Record<string, string> = {
      pr_opened: "PR opened",
      done: "done",
      skipped: "skipped",
      failed: "failed",
    };
    ctx.out.line(`Task ${taskId}: ${words[body.status]}.`);
    if (body.prUrl) ctx.out.line(`  PR: ${body.prUrl}`);
    if (body.reason) ctx.out.line(`  Reason: ${body.reason}`);
  });
}

async function releaseTask(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const taskId = parseTaskId(
    positionals[1],
    "Usage: paradigma tasks release <task id>",
  );
  const ctx = context(io, Boolean(values.json));
  const result = await ctx.client.releaseTask(taskId);
  ctx.out.result({ ok: true, taskId, ...result }, () =>
    ctx.out.line(`Task ${taskId} is back in the queue.`),
  );
}

async function tasksPrompt(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      project: { type: "string" },
      copy: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1)
    throw new UsageError(
      "Usage: paradigma tasks prompt [--project ID] [--copy]",
    );
  const ctx = context(io, Boolean(values.json));
  const project = await resolveProject(ctx, values.project);
  const { prompt } = await ctx.client.tasksPrompt(project.id);
  const copied = values.copy ? await hooks.copy(prompt, { env: io.env }) : null;
  ctx.out.result({ prompt, ...(values.copy ? { copied } : {}) }, () => {
    if (copied) {
      ctx.out.line(
        `Copied the tasks prompt to the clipboard (${copied}). Paste it into your agent.`,
      );
      return;
    }
    ctx.out.line(prompt);
    if (values.copy)
      ctx.out.warn(
        "No clipboard tool found (pbcopy, wl-copy, xclip or xsel); copy the prompt above.",
      );
  });
}

/** `paradigma tasks [list|start|finish|release|prompt] …`. */
export async function tasksCommand(io: Io, args: string[]) {
  const action = args.find((arg) => !arg.startsWith("-"));
  switch (action) {
    case undefined:
    case "list":
      return listTasks(io, args);
    case "start":
      return startTask(io, args);
    case "finish":
      return finishTask(io, args);
    case "release":
      return releaseTask(io, args);
    case "prompt":
      return tasksPrompt(io, args);
    default:
      // `paradigma tasks --project ID`: the flag value is not an action.
      if (args[args.indexOf(action) - 1]?.startsWith("--"))
        return listTasks(io, args);
      throw new UsageError(
        "Usage: paradigma tasks [list|start|finish|release|prompt]",
      );
  }
}
