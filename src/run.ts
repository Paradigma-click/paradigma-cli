import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chooseAgent,
  type DetectedAgent,
  detectAgents,
  runAgent,
} from "./agents";
import { ApiClient, ApiError } from "./api";
import {
  type CheckResult,
  ensureDependencies,
  resolveChecks,
  runChecks,
} from "./checks";
import {
  type AgentName,
  ensurePrivateDir,
  homePath,
  loadConfig,
  type PairedConfig,
  requirePaired,
  updateConfig,
} from "./config";
import type {
  AutopilotTaskResult,
  ReportRequest,
  TaskPayload,
} from "./contract/autopilot";
import {
  addDetachedWorktree,
  addWorktree,
  autopilotBranch,
  commit,
  discardUnstaged,
  fetchBase,
  fetchCommit,
  push,
  removeWorktree,
  revertCommit,
  stageAll,
  stagedDiff,
  stagedNumstat,
  statusPaths,
} from "./git";
import { type ChangedFile, redactSecrets, runGuards } from "./guards";
import {
  buildEditPrompt,
  buildReviewPrompt,
  parseReviewVerdict,
  type ReviewVerdict,
} from "./prompt";
import {
  buildPrBody,
  createPullRequest,
  effectiveMode,
  mergeCommitOf,
  prLevel,
  requestAutoMerge,
  savePatch,
} from "./publish";
import { verifyClone } from "./repos";
import { isRunDue } from "./schedule";
import { verifyTask } from "./verify";
import { VERSION } from "./version";

export type RunOptions = {
  once?: boolean;
  dryRun?: boolean;
  agent?: AgentName;
  max?: number;
  keepWorktrees?: boolean;
  skipChecks?: boolean;
  /** Started by the OS scheduler: skip when today's run already succeeded. */
  scheduled?: boolean;
  heartbeatMs?: number;
  agentTimeoutMs?: number;
  checkTimeoutMs?: number;
  log?: (line: string) => void;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type TaskOutcome = {
  taskId: string;
  status: ReportRequest["status"];
  code?: string;
  prUrl?: string;
};

export type RunSummary = {
  ran: boolean;
  reason?: string;
  outcomes: TaskOutcome[];
};

class TaskFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: "failed" | "skipped" = "failed",
  ) {
    super(message);
  }
}

/** Strips credentials from URLs and secret-looking strings, then truncates. */
export function sanitizeMessage(message: string): string {
  // First line only: command stderr can echo file contents further down.
  const firstLine = message.split("\n").find((line) => line.trim()) ?? "";
  return redactSecrets(
    firstLine.replace(/\/\/[^/@\s]+@/g, "//***@").replace(/\s+/g, " "),
  )
    .replaceAll(homedir(), "~")
    .trim()
    .slice(0, 200);
}

type Snapshot = {
  files: ChangedFile[];
  paths: string[];
  diff: string;
};

async function snapshot(worktree: string, base: string): Promise<Snapshot> {
  const paths = await statusPaths(worktree);
  await stageAll(worktree);
  const files = await stagedNumstat(worktree, base);
  const diff = await stagedDiff(worktree, base);
  const allPaths = [...new Set([...paths, ...files.map((f) => f.path)])];
  return { files, paths: allPaths, diff };
}

function acquireLock(): (() => void) | null {
  const file = homePath("run.lock");
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8").trim());
    let alive = false;
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {}
    }
    if (alive) return null;
  }
  writeFileSync(file, String(process.pid), { mode: 0o600 });
  return () => rmSync(file, { force: true });
}

export async function runAutopilot(
  options: RunOptions = {},
): Promise<RunSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  const config = requirePaired(loadConfig());
  if (config.paused) {
    log("Autopilot is paused on this machine. Run `paradigma resume`.");
    return { ran: false, reason: "paused", outcomes: [] };
  }
  if (
    options.scheduled &&
    config.schedule &&
    !isRunDue(
      new Date(),
      config.lastSuccessAt,
      config.schedule.hour,
      config.schedule.minute,
    )
  ) {
    log("Today's run already finished.");
    return { ran: false, reason: "not_due", outcomes: [] };
  }

  const api = new ApiClient({
    server: config.server,
    token: config.token,
    fetch: options.fetch,
    userAgent: `paradigma-cli/${VERSION}`,
  });
  const policy = await api.policy();
  if (policy.runnerId !== config.runnerId)
    throw new Error(
      "The server identifies this token as a different runner. Run `paradigma setup` again.",
    );
  const active = policy.repos.filter(
    (repo) => repo.enabled && !repo.paused && config.repos[repo.repoId],
  );
  const unmapped = policy.repos.filter(
    (repo) => repo.enabled && !config.repos[repo.repoId],
  );
  for (const repo of unmapped)
    log(
      `! ${repo.fullName} has no local clone. Run \`paradigma repos set ${repo.fullName} PATH\`.`,
    );

  const detected = await detectAgents();
  const agent = chooseAgent(detected, options.agent ?? config.agent);
  if (!agent) {
    const wanted = options.agent ?? config.agent;
    throw new Error(
      wanted
        ? `The ${wanted} agent is not installed or not on PATH.`
        : "No coding agent found. Install Claude Code, Codex or Cursor Agent.",
    );
  }

  if (options.dryRun) {
    log(`Agent: ${agent.name}${agent.version ? ` ${agent.version}` : ""}`);
    if (!active.length) log("No enabled repositories are mapped locally.");
    for (const repo of active)
      log(
        `Would claim up to ${options.max ?? 5} task(s) for ${repo.fullName} (level ${repo.level}) in ${config.repos[repo.repoId]}`,
      );
    log("Dry run: nothing was claimed.");
    return { ran: false, reason: "dry_run", outcomes: [] };
  }
  if (!active.length) {
    log("No enabled repositories are mapped locally. Nothing to do.");
    return { ran: false, reason: "no_repos", outcomes: [] };
  }

  ensurePrivateDir(homePath());
  const release = acquireLock();
  if (!release) {
    log("Another paradigma run is in progress.");
    return { ran: false, reason: "locked", outcomes: [] };
  }
  const outcomes: TaskOutcome[] = [];
  try {
    const batches = options.once ? 1 : 5;
    for (let batch = 0; batch < batches; batch++) {
      const claimed = await api.claim({
        repoIds: active.map((repo) => repo.repoId),
        max: options.max ?? 5,
        agents: detected
          .slice(0, 5)
          .map((a) => ({ name: a.name, version: a.version })),
        version: VERSION,
      });
      if (!claimed.tasks.length) {
        if (batch === 0)
          log(
            claimed.reason
              ? `Nothing to do (${claimed.reason}).`
              : "Nothing to do.",
          );
        break;
      }
      for (const signed of claimed.tasks) {
        const verified = verifyTask(signed, {
          publicKey: config.publicKey,
          runnerId: config.runnerId,
        });
        if (!verified.ok) {
          log(
            `! Ignored a task that failed verification (${verified.reason}).`,
          );
          if (verified.reason === "expired" && verified.payload) {
            await safeReport(api, log, {
              taskId: verified.payload.taskId,
              status: "skipped",
              result: { code: "expired" },
            });
            outcomes.push({
              taskId: verified.payload.taskId,
              status: "skipped",
              code: "expired",
            });
          }
          continue;
        }
        outcomes.push(
          await executeTask(verified.payload, {
            api,
            config,
            agent,
            options,
            log,
          }),
        );
      }
    }
    await updateConfig((next) => {
      next.lastRunAt = new Date().toISOString();
      next.lastSuccessAt = next.lastRunAt;
    });
  } finally {
    release();
  }
  return { ran: true, outcomes };
}

/** 404 unknown task, 403 repo access gone, 409 lease expired: stop the task. */
export function isLeaseLost(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "conflict" ||
      error.code === "forbidden" ||
      error.code === "disabled")
  );
}

/** Never throws; returns the error so callers can detect a lost lease. */
async function safeReport(
  api: ApiClient,
  log: (line: string) => void,
  request: ReportRequest,
): Promise<unknown> {
  try {
    await api.report(request);
    return null;
  } catch (error) {
    log(
      `! Could not report ${request.status} for ${request.taskId}: ${(error as Error).message}`,
    );
    return error;
  }
}

type TaskContext = {
  api: ApiClient;
  config: PairedConfig;
  agent: DetectedAgent;
  options: RunOptions;
  log: (line: string) => void;
};

async function executeTask(
  task: TaskPayload,
  context: TaskContext,
): Promise<TaskOutcome> {
  const { api, log, options } = context;
  const branch = autopilotBranch(task.taskId);
  log(`→ ${task.repo.owner}/${task.repo.name}: ${task.title}`);
  const startError = await safeReport(api, log, {
    taskId: task.taskId,
    status: "running",
    branch,
  });
  if (isLeaseLost(startError)) {
    log("  Lease lost before starting; skipped.");
    return { taskId: task.taskId, status: "skipped", code: "lease_lost" };
  }

  const controller = new AbortController();
  let leaseLost = false;
  const heartbeat = setInterval(async () => {
    try {
      const response = await api.heartbeat([task.taskId]);
      if (response.cancel.includes(task.taskId)) controller.abort();
    } catch (error) {
      if (isLeaseLost(error)) {
        leaseLost = true;
        controller.abort();
      }
      log(`! Heartbeat failed: ${(error as Error).message}`);
    }
  }, options.heartbeatMs ?? 60_000);

  const started = Date.now();
  const cleanups: Array<() => Promise<unknown>> = [];
  let failed = true;
  const result: AutopilotTaskResult = {
    agent: { name: context.agent.name, version: context.agent.version },
  };
  let report: ReportRequest;
  try {
    report = await processTask(task, context, {
      branch,
      signal: controller.signal,
      result,
      cleanups,
    });
    failed = report.status === "failed";
  } catch (error) {
    const failure =
      error instanceof TaskFailure
        ? error
        : new TaskFailure("internal_error", (error as Error)?.message ?? "");
    const cancelled = controller.signal.aborted;
    result.code = leaseLost
      ? "lease_lost"
      : cancelled
        ? "cancelled"
        : failure.code;
    result.message =
      sanitizeMessage(
        cancelled ? "Cancelled by the server" : failure.message,
      ) || undefined;
    report = {
      taskId: task.taskId,
      status: cancelled ? "skipped" : failure.status,
      branch,
      result,
    };
    failed = report.status === "failed";
  } finally {
    clearInterval(heartbeat);
  }
  report.result = { ...report.result, durationMs: Date.now() - started };
  if (!(failed && options.keepWorktrees)) {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {}
    }
  } else {
    log("  Kept the worktree for inspection (--keep-worktrees).");
  }
  if (leaseLost) {
    log("  Lease lost; stopped and cleaned up.");
    return { taskId: task.taskId, status: "skipped", code: "lease_lost" };
  }
  const finalError = await safeReport(api, log, report);
  if (isLeaseLost(finalError)) log("  The server no longer holds this lease.");
  log(
    `  ${report.status}${report.result?.code ? ` (${report.result.code})` : ""}${report.prUrl ? ` ${report.prUrl}` : ""}`,
  );
  return {
    taskId: task.taskId,
    status: report.status,
    code: report.result?.code,
    prUrl: report.prUrl,
  };
}

async function processTask(
  task: TaskPayload,
  context: TaskContext,
  state: {
    branch: string;
    signal: AbortSignal;
    result: AutopilotTaskResult;
    cleanups: Array<() => Promise<unknown>>;
  },
): Promise<ReportRequest> {
  const { config, agent, options, log } = context;
  const { branch, signal, result } = state;
  const fullName = `${task.repo.owner}/${task.repo.name}`;
  const checkpoint = () => {
    if (signal.aborted)
      throw new TaskFailure("cancelled", "Cancelled by the server", "skipped");
  };

  const repoPath = config.repos[task.repo.id];
  if (!repoPath)
    throw new TaskFailure("repo_not_mapped", `${fullName} is not mapped`);
  const mismatch = await verifyClone(repoPath, fullName);
  if (mismatch) throw new TaskFailure("repo_mismatch", mismatch);

  let baseSha: string;
  try {
    baseSha = await fetchBase(repoPath, task.repo.defaultBranch);
  } catch (error) {
    throw new TaskFailure("fetch_failed", (error as Error).message);
  }
  ensurePrivateDir(homePath("worktrees"));
  const scratch = ensurePrivateDir(homePath("tmp"));
  const worktree = homePath("worktrees", task.taskId);
  if (existsSync(worktree)) await removeWorktree(repoPath, worktree);
  await rm(worktree, { recursive: true, force: true });
  try {
    await addWorktree(repoPath, worktree, branch, baseSha);
  } catch (error) {
    throw new TaskFailure("worktree_failed", (error as Error).message);
  }
  state.cleanups.push(async () => {
    await removeWorktree(repoPath, worktree, branch);
    await rm(worktree, { recursive: true, force: true });
  });
  const appDir = join(worktree, task.repo.appRoot || ".");
  const isRevert = task.category === "revert" && task.revertsPrNumber !== null;

  const edit = async (previousRejection?: string[]) => {
    const outcome = await runAgent(agent, {
      mode: "edit",
      prompt: buildEditPrompt(task, { previousRejection }),
      cwd: worktree,
      scratchDir: scratch,
      timeoutMs: options.agentTimeoutMs,
      signal,
    });
    if (outcome.code === "cancelled") checkpoint();
    if (!outcome.ok)
      throw new TaskFailure(
        outcome.code ?? "agent_failed",
        `${agent.name} exited without finishing`,
      );
  };

  if (isRevert) {
    try {
      const sha = await mergeCommitOf(
        worktree,
        task,
        task.revertsPrNumber as number,
      );
      await fetchCommit(repoPath, sha);
      await revertCommit(worktree, sha);
    } catch (error) {
      throw new TaskFailure("revert_failed", (error as Error).message);
    }
  } else {
    log(`  Running ${agent.name}…`);
    await edit();
  }
  checkpoint();

  let review: ReviewVerdict | undefined;
  let checks: CheckResult[] = [];
  let current: Snapshot | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) {
      log("  Self-review rejected the change; retrying once…");
      await edit(review?.reasons);
      checkpoint();
    }
    current = await snapshot(worktree, baseSha);
    result.files = current.files.map((f) => f.path.slice(0, 300)).slice(0, 50);
    result.additions = current.files.reduce((sum, f) => sum + f.additions, 0);
    result.deletions = current.files.reduce((sum, f) => sum + f.deletions, 0);
    if (!current.files.length)
      return {
        taskId: task.taskId,
        status: "skipped",
        result: { ...result, code: "no_changes" },
      };
    const guard = runGuards({
      files: current.files,
      paths: current.paths,
      allowedPaths: task.allowedPaths,
      budget: task.diffBudget,
      diff: current.diff,
    });
    if (!guard.ok)
      throw new TaskFailure(`guard:${guard.reason}`, guard.message);

    if (!options.skipChecks) {
      log("  Running checks…");
      checks = await runRepoChecks(task, context, {
        repoPath,
        worktree,
        appDir,
        baseSha,
        signal,
        cleanups: state.cleanups,
      });
      result.checks = checks;
      await discardUnstaged(worktree);
      checkpoint();
      if (checks.some((c) => c.status === "failed" || c.status === "timeout"))
        throw new TaskFailure("checks_failed", "Repository checks failed");
    }

    if (isRevert) break;
    log("  Self-review…");
    const reviewRun = await runAgent(agent, {
      mode: "review",
      prompt: buildReviewPrompt(task, current.diff),
      cwd: worktree,
      scratchDir: scratch,
      timeoutMs: options.agentTimeoutMs,
      signal,
    });
    if (reviewRun.code === "cancelled") checkpoint();
    review = reviewRun.ok
      ? parseReviewVerdict(reviewRun.text)
      : {
          verdict: "rejected",
          reasons: [`The ${agent.name} review run failed.`],
        };
    // Reasons are free text from the agent and may quote repository code, so
    // they stay local (retry prompt, PR body). The server gets the verdict.
    result.review = { verdict: review.verdict, reasons: [] };
    if (review.verdict === "approved") break;
    if (attempt === 2) {
      const patch = await savePatch(task.taskId, current.diff);
      log(`  Saved the patch to ${patch}`);
      return {
        taskId: task.taskId,
        status: "notified",
        result: { ...result, code: "review_rejected" },
      };
    }
  }
  if (!current) throw new TaskFailure("internal_error", "No diff");
  checkpoint();

  const mode = effectiveMode(task, {
    checksSkipped: Boolean(options.skipChecks) || checks.length === 0,
    reviewApproved: isRevert || review?.verdict === "approved",
    checks,
  });
  if (mode === "notify") {
    const patch = await savePatch(task.taskId, current.diff);
    log(`  Saved the patch to ${patch}`);
    return { taskId: task.taskId, status: "notified", result };
  }

  try {
    await commit(worktree, task.title, task.taskId);
  } catch (error) {
    throw new TaskFailure("commit_failed", (error as Error).message);
  }
  try {
    await push(worktree, branch);
  } catch (error) {
    throw new TaskFailure("push_failed", (error as Error).message);
  }
  const bodyFile = join(scratch, `${task.taskId}-pr.md`);
  await writeFile(
    bodyFile,
    buildPrBody({
      task,
      checks,
      review,
      agent: result.agent,
      level: prLevel(task, mode),
    }),
    { mode: 0o600 },
  );
  state.cleanups.push(() => rm(bodyFile, { force: true }));
  let pr: { prUrl: string; prNumber: number };
  try {
    pr = await createPullRequest({ cwd: worktree, task, branch, bodyFile });
  } catch (error) {
    throw new TaskFailure("pr_create_failed", (error as Error).message);
  }
  if (mode === "auto_merge") {
    try {
      await requestAutoMerge(worktree, task, pr.prNumber);
      return {
        taskId: task.taskId,
        status: "merge_requested",
        branch,
        ...pr,
        result,
      };
    } catch (error) {
      return {
        taskId: task.taskId,
        status: "pr_opened",
        branch,
        ...pr,
        result: {
          ...result,
          code: "auto_merge_unavailable",
          message: sanitizeMessage((error as Error).message),
        },
      };
    }
  }
  return { taskId: task.taskId, status: "pr_opened", branch, ...pr, result };
}

/** Runs checks; a failure that also happens on the base commit is skipped. */
async function runRepoChecks(
  task: TaskPayload,
  context: TaskContext,
  input: {
    repoPath: string;
    worktree: string;
    appDir: string;
    baseSha: string;
    signal: AbortSignal;
    cleanups: Array<() => Promise<unknown>>;
  },
): Promise<CheckResult[]> {
  const { options, config } = context;
  const timing = { timeoutMs: options.checkTimeoutMs, signal: input.signal };
  const planned = resolveChecks(
    input.worktree,
    task.repo.appRoot,
    config.checks[task.repo.id],
  );
  if (!planned.checks.length) return [];
  if (planned.needsInstall) {
    const install = await ensureDependencies(
      input.worktree,
      task.repo.appRoot,
      timing,
    );
    if (install && install.status !== "passed")
      return [
        {
          name: install.name,
          status: install.status,
          durationMs: install.durationMs,
        },
      ];
  }
  const { results } = await runChecks(planned.checks, input.appDir, timing);
  const failing = results.filter(
    (r) => r.status === "failed" || r.status === "timeout",
  );
  if (!failing.length || input.signal.aborted) return results;

  // Re-run only the failing checks on the base commit.
  const baseTree = homePath("worktrees", `${task.taskId}-base`);
  try {
    await addDetachedWorktree(input.repoPath, baseTree, input.baseSha);
  } catch {
    return results;
  }
  try {
    if (planned.needsInstall)
      await ensureDependencies(baseTree, task.repo.appRoot, timing);
    const baseDir = join(baseTree, task.repo.appRoot || ".");
    const rerun = await runChecks(
      planned.checks.filter((c) => failing.some((f) => f.name === c.name)),
      baseDir,
      timing,
    );
    const preexisting = new Set(
      rerun.results
        .filter((r) => r.status === "failed" || r.status === "timeout")
        .map((r) => r.name),
    );
    return results.map((r) =>
      preexisting.has(r.name) ? { ...r, status: "skipped" as const } : r,
    );
  } finally {
    await removeWorktree(input.repoPath, baseTree);
    await rm(baseTree, { recursive: true, force: true });
  }
}
