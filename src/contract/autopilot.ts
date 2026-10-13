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
  "revert",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

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
        name: z.enum(["claude", "codex", "cursor", "custom"]),
        version: z.string().max(80).nullable(),
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
  max: z.number().int().min(1).max(20).default(5),
  agents: z
    .array(
      z.object({
        name: z.string().max(40),
        version: z.string().max(80).nullable(),
      }),
    )
    .max(5)
    .default([]),
  version: z.string().max(40).optional(),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const claimResponseSchema = z.object({
  tasks: z.array(signedTaskSchema),
  /** Present when nothing was claimed, e.g. "outside_run_window". */
  reason: z.string().max(80).optional(),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const heartbeatRequestSchema = z.object({
  taskIds: z.array(z.uuid()).max(20),
});
export const heartbeatResponseSchema = z.object({
  /** Tasks the runner must stop (paused, cancelled or lease lost). */
  cancel: z.array(z.uuid()),
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
});
export const policyResponseSchema = z.object({
  runnerId: z.uuid(),
  repos: z.array(repoPolicyViewSchema),
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
