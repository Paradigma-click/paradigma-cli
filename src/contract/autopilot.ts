import { z } from "zod";

/**
 * Wire contract between the Paradigma server and the `paradigma` CLI for
 * Autopilot. Shared by both sides, so keep it dependency-free apart from zod.
 * Payloads never carry repository file contents.
 */

/**
 * 0 full autopilot (any category and risk may auto-merge; allowlisted users
 * only), 1 auto-merge low risk, 2 open PR, 3 notify.
 */
export const AUTOPILOT_LEVELS = [0, 1, 2, 3] as const;
export type AutopilotLevel = (typeof AUTOPILOT_LEVELS)[number];
export const autopilotLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export const LEVEL_LABELS: Record<AutopilotLevel, string> = {
  0: "Full autopilot",
  1: "Autopilot",
  2: "Open PR",
  3: "Notify",
};

/**
 * Coding agents a runner may be told to prefer. `null` (Auto) lets the runner
 * pick from what is installed. `custom` (PARADIGMA_AGENT_COMMAND) is only
 * ever chosen on the machine itself.
 */
export const RUNNER_AGENTS = ["claude", "codex", "cursor"] as const;
export type RunnerAgent = (typeof RUNNER_AGENTS)[number];
export const runnerAgentSchema = z.enum(RUNNER_AGENTS);

/**
 * Who does a repository's fixes: `paradigma` (the hosted Paradigma agent, on
 * Paradigma's servers) or `runner` (this CLI with a local coding agent). A
 * runner never claims the tasks a repository gives the hosted agent.
 */
export const FIX_AGENTS = ["paradigma", "runner"] as const;
export type FixAgentChoice = (typeof FIX_AGENTS)[number];
export const fixAgentSchema = z.enum(FIX_AGENTS);

/**
 * Where a repository's fixes run (docs/36 §0, 18/10/2026): `auto` routes each task (hosted by
 * default, the GitHub Action when the task needs a build or tests, or when hosted cannot run),
 * `hosted` only on Paradigma's servers, `github` only in the customer's GitHub Actions. `local`
 * (the local runner) exists for internal admins only and is never offered to anyone else.
 */
export const FIX_MODES = ["auto", "hosted", "github", "local"] as const;
export type FixMode = (typeof FIX_MODES)[number];
export const fixModeSchema = z.enum(FIX_MODES);
/** The fix modes every account may choose. */
export const PUBLIC_FIX_MODES = ["auto", "hosted", "github"] as const;

/** Model names or aliases passed to the agent CLI as is (`opus`, `gpt-5-codex`); never a flag. */
export const RUNNER_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const RUNNER_MODEL_MAX = 64;
export const runnerModelSchema = z
  .string()
  .min(1)
  .max(RUNNER_MODEL_MAX)
  .regex(RUNNER_MODEL_PATTERN);

/**
 * Reasoning effort levels an agent CLI may accept. Claude Code takes all of
 * them (`--effort`), Codex all but "max" (`-c model_reasoning_effort=…`),
 * Cursor none. A custom agent command reads the level from
 * PARADIGMA_AGENT_EFFORT.
 */
export const RUNNER_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type RunnerEffort = (typeof RUNNER_EFFORTS)[number];
export const runnerEffortSchema = z.enum(RUNNER_EFFORTS);

export const EFFORTS_BY_AGENT: Record<
  RunnerAgent | "custom",
  readonly RunnerEffort[]
> = {
  claude: RUNNER_EFFORTS,
  codex: ["low", "medium", "high", "xhigh", "max"],
  cursor: [],
  custom: RUNNER_EFFORTS,
};

/**
 * The effort level when `agent` accepts it, else null. With no agent (Auto)
 * any known level is kept: it applies once an agent that accepts it is
 * picked. Pure.
 */
export function validEffort(
  agent: string | null | undefined,
  value: unknown,
): RunnerEffort | null {
  if (typeof value !== "string") return null;
  const level = value.trim().toLowerCase();
  if (!(RUNNER_EFFORTS as readonly string[]).includes(level)) return null;
  if (!agent) return level as RunnerEffort;
  const allowed = EFFORTS_BY_AGENT[agent as RunnerAgent | "custom"];
  return allowed?.includes(level as RunnerEffort)
    ? (level as RunnerEffort)
    : null;
}

/**
 * Agent, model and effort a runner should use; null means Auto / the agent's
 * default. `effort` is optional: older servers omit it and older runners
 * ignore it.
 */
export const runnerPreferenceSchema = z.object({
  agent: runnerAgentSchema.nullable(),
  model: runnerModelSchema.nullable(),
  effort: runnerEffortSchema.nullable().optional(),
});
export type RunnerPreference = z.infer<typeof runnerPreferenceSchema>;

/** An agent found on the runner's machine. */
export const reportedAgentSchema = z.object({
  name: z.string().max(40),
  version: z.string().max(80).nullable(),
  /** Whether the agent CLI is signed in; absent when unknown. */
  loggedIn: z.boolean().nullable().optional(),
});
export type ReportedAgent = z.infer<typeof reportedAgentSchema>;

export const TASK_CATEGORIES = [
  "metadata",
  "robots",
  "sitemap",
  "structured_data",
  "images",
  "llms_txt",
  "links",
  "routes",
  "performance",
  "content",
  "agent_discovery",
  "server_rendering",
  "revert",
  /**
   * A project setup step (`setup/<step>` kinds): a connection or an install
   * a project still lacks, such as the Google Analytics tag. Servers send it
   * only to runners that know it; older runners get the payload as
   * `metadata` with risk medium, so it never auto-merges as low risk.
   */
  "setup",
  /**
   * Penalty risk cleanup (docs/35, phase 7): remove hidden or injected text, qualify paid links,
   * drop self-serving review markup, propose noindex or 301 merges, fix hreflang and lang, remove
   * generated-text leftovers, stop fake `lastmod` bumps, align an llms.txt mirror. Never
   * auto-merged at any level, level 0 included: it always opens a draft pull request for the
   * owner (`neverAutoMerges`). Servers send it only to runners that know it.
   */
  "policy_cleanup",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/**
 * Categories that never auto-merge, at any level (level 0 included): the pull request always
 * waits for the owner. Every merge decision checks this (the server's mode, the runner's
 * effective mode, the hosted agent's mode and the report transitions), not only the planner.
 */
export const NEVER_AUTO_MERGE_CATEGORIES: readonly TaskCategory[] = [
  "policy_cleanup",
];

/** Whether a task of this category must never be merged without the owner. Pure. */
export function neverAutoMerges(category: string): boolean {
  return (NEVER_AUTO_MERGE_CATEGORIES as readonly string[]).includes(category);
}

/** Categories whose pull request opens as a draft: a proposal the owner reviews. */
export function opensDraftPullRequest(category: string): boolean {
  return neverAutoMerges(category);
}

/** Categories that may auto-merge at level 1. Only level 0 merges the rest. */
export const LOW_RISK_CATEGORIES: readonly TaskCategory[] = [
  "metadata",
  "robots",
  "sitemap",
  "structured_data",
  "images",
  "llms_txt",
  "revert",
];

export const RISKS = ["low", "medium", "high"] as const;
export type TaskRisk = (typeof RISKS)[number];

export const TASK_MODES = ["notify", "pull_request", "auto_merge"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const TERMINAL_STATUSES = [
  "notified",
  "pr_opened",
  "merge_requested",
  "merged",
  "failed",
  "skipped",
  "cancelled",
  "reverted",
] as const;

export const diffBudgetSchema = z.object({
  maxFiles: z.number().int().min(1).max(50),
  maxLines: z.number().int().min(1).max(2000),
});
export type DiffBudget = z.infer<typeof diffBudgetSchema>;

export const taskImpactSchema = z
  .object({
    impressions: z.number().nonnegative().optional(),
    clicks: z.number().nonnegative().optional(),
    routes: z.array(z.string().max(300)).max(20).optional(),
    note: z.string().max(300).optional(),
  })
  .strict();
export type TaskImpact = z.infer<typeof taskImpactSchema>;

/** What the runner receives for one task, signed by the server. */
export const taskPayloadSchema = z.object({
  v: z.literal(1),
  taskId: z.uuid(),
  runnerId: z.uuid(),
  repo: z.object({
    id: z.uuid(),
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    defaultBranch: z.string().min(1).max(255),
    appRoot: z.string().max(300),
  }),
  kind: z.string().min(1).max(60),
  category: z.enum(TASK_CATEGORIES),
  risk: z.enum(RISKS),
  mode: z.enum(TASK_MODES),
  /**
   * Level the policy acted at when the task was claimed. Only 0 lets the
   * runner honor `auto_merge` outside the low-risk categories; absent means
   * the low-risk rule applies.
   */
  level: autopilotLevelSchema.optional(),
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(8000),
  acceptance: z.array(z.string().min(1).max(500)).min(1).max(12),
  /** Glob patterns relative to the repo root; edits outside are rejected. */
  allowedPaths: z.array(z.string().min(1).max(300)).min(1).max(30),
  diffBudget: diffBudgetSchema,
  impact: taskImpactSchema,
  findingId: z.uuid().nullable(),
  revertsPrNumber: z.number().int().positive().nullable(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type TaskPayload = z.infer<typeof taskPayloadSchema>;

/** `body` is the exact JSON that was signed; verify before parsing. */
export const signedTaskSchema = z.object({
  body: z.string().min(2).max(20000),
  signature: z.string().min(16).max(200),
});
export type SignedTask = z.infer<typeof signedTaskSchema>;

export const checkResultSchema = z.object({
  name: z.string().min(1).max(60),
  status: z.enum(["passed", "failed", "skipped", "timeout"]),
  durationMs: z.number().int().nonnegative().max(3_600_000),
});

/** Metadata only: never file contents, never diffs. */
export const autopilotTaskResultSchema = z
  .object({
    agent: z
      .object({
        /** `paradigma` is the hosted agent; runners report their own agent. */
        name: z.enum(["claude", "codex", "cursor", "custom", "paradigma"]),
        version: z.string().max(80).nullable(),
        /**
         * The model asked for, else the one the agent reported; null: unknown
         * (its default). Lenient on purpose: a model name never fails a
         * report; the server keeps it only when it matches `runnerModelSchema`.
         */
        model: z.string().max(120).nullable().optional(),
        /** The effort level asked for; null or absent: the agent's default. */
        effort: z.string().max(20).nullable().optional(),
      })
      .optional(),
    files: z.array(z.string().min(1).max(300)).max(50).optional(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    checks: z.array(checkResultSchema).max(10).optional(),
    review: z
      .object({
        verdict: z.enum(["approved", "rejected"]),
        reasons: z.array(z.string().min(1).max(300)).max(8),
      })
      .optional(),
    /** Short machine-readable reason, e.g. "guard:path_not_allowed". */
    code: z.string().max(80).optional(),
    message: z.string().max(500).optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AutopilotTaskResult = z.infer<typeof autopilotTaskResultSchema>;

export const REPORT_STATUSES = [
  "running",
  "notified",
  "pr_opened",
  "merge_requested",
  "merged",
  "failed",
  "skipped",
] as const;

export const reportRequestSchema = z.object({
  taskId: z.uuid(),
  status: z.enum(REPORT_STATUSES),
  branch: z.string().max(255).optional(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.url().max(500).optional(),
  result: autopilotTaskResultSchema.optional(),
});
export type ReportRequest = z.infer<typeof reportRequestSchema>;

export const claimRequestSchema = z.object({
  /** Only plan/claim for these repositories (the ones mapped locally). */
  repoIds: z.array(z.uuid()).max(200).optional(),
  /** Only claim tasks of these projects (site ids); absent: every project. */
  siteIds: z.array(z.uuid()).max(200).optional(),
  /**
   * The background run request this claim serves (`/api/cli/v1/run-requests`).
   * A valid one lets the server claim on its repository even when Autopilot
   * is off there: the person asked. Older runners send neither field.
   */
  requestId: z.uuid().optional(),
  max: z.number().int().min(1).max(20).default(5),
  agents: z.array(reportedAgentSchema).max(5).default([]),
  version: z.string().max(40).optional(),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const claimResponseSchema = z.object({
  tasks: z.array(signedTaskSchema),
  /** Present when nothing was claimed, e.g. "outside_run_window". */
  reason: z.string().max(80).optional(),
  /**
   * The agent and model chosen for this runner in the dashboard (nulls mean
   * Auto and the agent's default). Outside the signed task bodies; absent
   * from older servers.
   */
  runner: runnerPreferenceSchema.nullish(),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const heartbeatRequestSchema = z.object({
  taskIds: z.array(z.uuid()).max(20),
  /** Agents installed on the machine; replaces the stored list when non-empty. */
  agents: z.array(reportedAgentSchema).max(5).optional().catch(undefined),
  /**
   * The agent and model this run actually uses (after flags, the dashboard's
   * choice and local config). Shown as the runner's current agent; it never
   * changes the dashboard's choice. Invalid values are ignored rather than
   * failing the heartbeat.
   */
  preferred: z
    .object({
      agent: z.string().min(1).max(40),
      model: z.string().max(120).nullable().optional(),
      effort: z.string().max(20).nullable().optional(),
    })
    .optional()
    .catch(undefined),
  /**
   * Tasks the runner gives back without finishing them (paused or
   * interrupted): they return to the queue without using an attempt. Older
   * servers ignore it and the lease simply expires.
   */
  release: z.array(z.uuid()).max(20).optional().catch(undefined),
});
export const heartbeatResponseSchema = z.object({
  /** Tasks the runner must stop (paused, cancelled or lease lost). */
  cancel: z.array(z.uuid()),
  /** Tasks from `release` that went back to the queue; absent from older servers. */
  released: z.array(z.uuid()).optional(),
  /** The runner's current preference, as in the claim response. */
  runner: runnerPreferenceSchema.nullish(),
});

export const repoPolicyViewSchema = z.object({
  repoId: z.uuid(),
  fullName: z.string(),
  defaultBranch: z.string(),
  enabled: z.boolean(),
  level: autopilotLevelSchema,
  paused: z.boolean(),
  runHour: z.number().int().min(0).max(23),
  timezone: z.string(),
  /**
   * Who does the repository's fixes; `paradigma` repositories are worked on
   * Paradigma's servers once the organization consented. Absent from older
   * servers (the runner).
   */
  agent: fixAgentSchema.optional(),
  /** Where the repository's fixes run; absent from older servers. */
  fixMode: fixModeSchema.optional(),
});
export const policyResponseSchema = z.object({
  runnerId: z.uuid(),
  repos: z.array(repoPolicyViewSchema),
  /** The runner's preference, as in the claim response. */
  runner: runnerPreferenceSchema.nullish(),
});
export type PolicyResponse = z.infer<typeof policyResponseSchema>;

export const pairStartRequestSchema = z.object({
  machineName: z.string().min(1).max(100),
  platform: z.string().min(1).max(40),
});
export const pairStartResponseSchema = z.object({
  deviceCode: z.string().min(32),
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verificationUrl: z.url(),
  intervalSeconds: z.number().int().positive(),
  expiresInSeconds: z.number().int().positive(),
});
export const pairPollRequestSchema = z.object({
  deviceCode: z.string().min(32).max(200),
});
export const pairPollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({
    status: z.literal("approved"),
    runnerId: z.uuid(),
    runnerToken: z.string().min(32),
    /** Ed25519 public key (base64url, raw 32 bytes) that signs tasks. */
    publicKey: z.string().min(40).max(60),
  }),
]);
export type PairPollResponse = z.infer<typeof pairPollResponseSchema>;

/** Canonical prefix for runner bearer tokens, so leaks are recognizable. */
export const RUNNER_TOKEN_PREFIX = "pdg_rt_";
