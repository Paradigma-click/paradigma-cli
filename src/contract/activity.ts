import { z } from "zod";

/**
 * What Paradigma did and will do, for people: the local runner's activity file
 * (`~/.paradigma/activity.json`, written by a run) and the server's timeline
 * (`GET /api/cli/v1/activity`). The runner's `activity --json` prints both,
 * and the menu bar app reads that, so field names are stable. Titles,
 * sites, scores, PR links and short reasons only: never repository contents,
 * prompts, tokens, rule ids or how a check decides.
 */

// ─── Local runner file ──────────────────────────────────────────────────────

export const ACTIVITY_FILE_VERSION = 1;
export const RUNNER_STATES = ["idle", "running", "paused"] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];
/** Named agents only; a custom agent command shows as null. */
export const ACTIVITY_AGENTS = ["claude", "codex", "cursor"] as const;
export type ActivityAgent = (typeof ACTIVITY_AGENTS)[number];
export const TASK_STEPS = [
  "preparing",
  "agent",
  "checks",
  "publishing",
] as const;
export type TaskStep = (typeof TASK_STEPS)[number];
export const LOCAL_EVENT_KINDS = [
  "run_started",
  "task_started",
  "pr_opened",
  "merge_requested",
  "task_failed",
  "task_skipped",
  "run_finished",
] as const;
export type LocalEventKind = (typeof LOCAL_EVENT_KINDS)[number];
/** Events kept in the file, newest first. */
export const LOCAL_EVENT_LIMIT = 50;

export const localEventSchema = z.object({
  at: z.string(),
  kind: z.enum(LOCAL_EVENT_KINDS),
  repo: z.string().nullable(),
  title: z.string().nullable(),
  prUrl: z.string().nullable(),
  detail: z.string().nullable(),
  /** The agent (claude, codex, cursor, custom), model and effort behind the event, when one ran. */
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  /**
   * run_started, once the run's first batch is claimed and verified: how many tasks, and
   * their sites (production hosts, else repositories). Absent until then, and when nothing
   * was claimed.
   */
  count: z.number().int().optional(),
  sites: z.array(z.string()).optional(),
  /** task_started: the task's site (production host), when known. */
  site: z.string().nullable().optional(),
});
export type LocalEvent = z.infer<typeof localEventSchema>;

export const localActivitySchema = z.object({
  version: z.literal(ACTIVITY_FILE_VERSION),
  updatedAt: z.string(),
  runner: z.object({
    state: z.enum(RUNNER_STATES),
    agent: z.enum(ACTIVITY_AGENTS).nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    /** Next run of the installed daily schedule; null without one. */
    nextRunAt: z.string().nullable(),
    /** The process of the run in progress; null when idle. */
    pid: z.number().int().nullable(),
    /** Effective model of the current or last run; null when unknown (the agent's default). */
    model: z.string().nullable().default(null),
    /** Effort level of the current or last run; null: the agent's default (or none). */
    effort: z.string().nullable().default(null),
    /**
     * Agents that hit their plan's usage limit: runs do not start them again before `until`
     * (ISO; the reset time the agent named, else an hour later). Other agents are not blocked.
     * `detail`: "Claude Code usage limit reached · resets 10:40pm". Absent: none.
     */
    limits: z
      .array(
        z.object({
          agent: z.string(),
          until: z.string(),
          detail: z.string(),
        }),
      )
      .max(10)
      .optional(),
  }),
  current: z
    .object({
      taskId: z.string(),
      repo: z.string(),
      site: z.string().nullable(),
      title: z.string(),
      step: z.enum(TASK_STEPS),
      startedAt: z.string(),
      /**
       * Absolute path of this task's live log (`~/.paradigma/live/<taskId>.log`). It quotes the
       * repository, so it stays on this machine; the runner's `watch` follows it.
       */
      liveLog: z.string().nullable().optional(),
      /**
       * The terminal the agent runs in while it works, when it runs in one: a session on
       * Paradigma's tmux server (`tmux -L paradigma attach -r -t <tmux>`). Null otherwise.
       */
      terminal: z.object({ tmux: z.string() }).nullable().optional(),
    })
    .nullable(),
  /** The live log of the task that ran last (absolute path); kept after the task ends. */
  lastLiveLog: z.string().nullable().optional(),
  lastRun: z
    .object({
      startedAt: z.string(),
      finishedAt: z.string(),
      claimed: z.number().int(),
      prsOpened: z.number().int(),
      mergeRequested: z.number().int(),
      failed: z.number().int(),
      skipped: z.number().int(),
    })
    .nullable(),
  events: z.array(localEventSchema).max(LOCAL_EVENT_LIMIT),
});
export type LocalActivity = z.infer<typeof localActivitySchema>;

// ─── Server timeline ────────────────────────────────────────────────────────

export const ACTIVITY_EVENT_KINDS = [
  "scan_completed",
  "tasks_planned",
  "task_claimed",
  "pr_opened",
  "merged",
  "live",
  "not_live",
  "task_failed",
  "task_skipped",
] as const;
export type ActivityEventKind = (typeof ACTIVITY_EVENT_KINDS)[number];
export const ACTIVITY_MAX_EVENTS = 200;
export const ACTIVITY_DEFAULT_HOURS = 24;
export const ACTIVITY_MAX_DAYS = 7;

export const activityEventSchema = z
  .object({
    at: z.string(),
    kind: z.enum(ACTIVITY_EVENT_KINDS),
    site: z.string(),
    projectId: z.string(),
    title: z.string().nullable(),
    prUrl: z.string().nullable(),
    prNumber: z.number().int().nullable(),
    /** scan_completed: the four headline scores (null for a pillar with no score). */
    scores: z
      .object({
        seo: z.number().nullable(),
        aeo: z.number().nullable(),
        geo: z.number().nullable(),
        agents: z.number().nullable(),
      })
      .nullable(),
    /** tasks_planned: how many. */
    count: z.number().int().nullable(),
    /** A short human reason (failed, skipped, not live, set to merge). */
    detail: z.string().nullable(),
  })
  .passthrough();
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const activityResponseSchema = z
  .object({
    since: z.string(),
    now: z.string(),
    schedule: z
      .object({
        scanEveryHours: z.number(),
        /** Newest completed scan across the projects. */
        lastScanAt: z.string().nullable(),
        /** Soonest next daily scan across the projects; null when none is scheduled. */
        nextScanAt: z.string().nullable(),
        /** When Autopilot plans tasks, in words ("off" when Autopilot is off on the server). */
        planner: z.string(),
      })
      .passthrough(),
    /** The same, per project. */
    projects: z
      .array(
        z
          .object({
            projectId: z.string(),
            site: z.string(),
            lastScanAt: z.string().nullable(),
            nextScanAt: z.string().nullable(),
            /** A scan is queued or running now. */
            scanning: z.boolean(),
          })
          .passthrough(),
      )
      .default([]),
    runners: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          lastSeenAt: z.string().nullable(),
          online: z.boolean(),
        })
        .passthrough(),
    ),
    events: z.array(activityEventSchema).max(ACTIVITY_MAX_EVENTS),
  })
  .passthrough();
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

// ─── Reasons ────────────────────────────────────────────────────────────────

const CHECK_LABELS: Record<string, string> = {
  install: "Installing dependencies",
  lint: "Lint",
  typecheck: "Type check",
  test: "Tests",
  build: "Build",
};

function checkLabel(name: string): string {
  const custom = /^custom-(\d+)$/.exec(name);
  if (custom) return `Custom check ${custom[1]}`;
  return CHECK_LABELS[name] ?? "A check";
}

const REASONS: Record<string, string> = {
  no_changes: "No changes needed",
  finding_resolved: "Already fixed on the site",
  expired: "Expired before the runner got to it",
  lease_lost: "The runner lost the task",
  lease_expired: "The runner stopped before finishing",
  cancelled: "Cancelled",
  paused: "Paused; back in the queue",
  interrupted: "Stopped; back in the queue",
  pr_closed: "The pull request was closed without merging",
  invalid_payload: "The task could not be prepared",
  checks_failed: "Checks failed",
  "guard:too_many_files": "The change was larger than allowed",
  "guard:too_many_lines": "The change was larger than allowed",
  "guard:path_not_allowed": "The change touched files outside its scope",
  "guard:forbidden_path": "The change touched files outside its scope",
  "guard:path_outside_repo": "The change touched files outside its scope",
  "guard:secret_detected": "The change looked like it contained a secret",
  agent_failed: "The coding agent did not finish",
  agent_timeout: "The coding agent timed out",
  usage_limit: "Agent usage limit reached; back in the queue",
  review_rejected: "Self-review rejected the change",
  auto_merge_unavailable: "Auto-merge is not available on this repository",
  repo_not_mapped: "No local clone of the repository",
  repo_mismatch: "The local clone points to another repository",
  fetch_failed: "Could not fetch the repository",
  worktree_failed: "Could not prepare a worktree",
  revert_failed: "Could not revert the pull request",
  commit_failed: "Could not commit the change",
  push_failed: "Could not push the branch",
  pr_create_failed: "Could not open the pull request",
  internal_error: "Unexpected runner error",
  /** A setup step finished because the connection or install is in place. */
  "setup:done": "Set up",
};

/**
 * A short human reason for a task outcome ("Lint failed", "No changes needed"), from its
 * machine code, check names and, for `no_changes` only, the runner's sanitized one-line
 * explanation. Null when there is nothing to say. Pure.
 */
export function taskOutcomeReason(input: {
  status: string;
  code?: string | null;
  checks?: readonly { name: string; status: string }[] | null;
  message?: string | null;
}): string | null {
  const code = input.code ?? null;
  if (code === "no_changes") {
    const message = input.message?.replace(/\s+/g, " ").trim();
    return message ? message.slice(0, 300) : REASONS.no_changes;
  }
  if (code === "checks_failed") {
    const bad = input.checks?.find(
      (check) => check.status === "failed" || check.status === "timeout",
    );
    if (bad)
      return `${checkLabel(bad.name)} ${bad.status === "timeout" ? "timed out" : "failed"}`;
  }
  if (code && REASONS[code]) return REASONS[code];
  if (code?.startsWith("guard:"))
    return "The change did not pass the safety checks";
  if (input.status === "failed") return "Failed";
  if (input.status === "skipped") return "Skipped";
  if (input.status === "cancelled") return "Cancelled";
  return null;
}
