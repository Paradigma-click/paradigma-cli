import { z } from "zod";

/**
 * Wire contract of the fix harness (docs/36): the task brief, acceptance items, evidence records,
 * untrusted data blocks and `check_html`. Shared by the server and the `paradigma` CLI, so keep it
 * dependency-free apart from zod. The brief carries the recipe and what passing means, never the
 * engine: no rule weights, thresholds or internal check ids.
 */

/** Tools with the same names in every mode (hosted, GitHub Action, local). */
export const HARNESS_TOOL_NAMES = [
  "get_task_brief",
  "list_files",
  "read_file",
  "search",
  "write_file",
  "check_html",
  "finish_task",
] as const;
export type HarnessToolName = (typeof HARNESS_TOOL_NAMES)[number];

/** Frameworks the harness has playbooks and a static renderer for. */
export const HARNESS_FRAMEWORKS = [
  "nextjs-app",
  "nextjs-pages",
  "astro",
  "sveltekit",
  "hugo",
  "static",
] as const;
export type HarnessFramework = (typeof HARNESS_FRAMEWORKS)[number];

/** The categories the hosted agent fixes in v1 (docs/36 §6.2). */
export const HARNESS_V1_CATEGORIES = [
  "metadata",
  "robots",
  "sitemap",
  "structured_data",
  "llms_txt",
  "agent_discovery",
] as const;
export type HarnessV1Category = (typeof HARNESS_V1_CATEGORIES)[number];

/**
 * Categories added after the v1 evals passed (docs/36 phase 6): internal links, images and
 * routes. Only the findings the static check can judge run hosted; the rest need a build and go
 * to the GitHub Action.
 */
export const HARNESS_V2_CATEGORIES = ["links", "images", "routes"] as const;
export type HarnessV2Category = (typeof HARNESS_V2_CATEGORIES)[number];

/** Categories with one playbook per framework: v1 and phase 6. */
export const HARNESS_FIX_CATEGORIES = [
  ...HARNESS_V1_CATEGORIES,
  ...HARNESS_V2_CATEGORIES,
] as const;
export type HarnessFixCategory = (typeof HARNESS_FIX_CATEGORIES)[number];

/**
 * Every category the harness has playbooks for: the v1 set, the phase 6 set and penalty risk
 * cleanup (docs/35, phase 7), whose pull requests open as drafts and never auto-merge.
 */
export const HARNESS_CATEGORIES = [
  ...HARNESS_FIX_CATEGORIES,
  "policy_cleanup",
] as const;
export type HarnessCategory = (typeof HARNESS_CATEGORIES)[number];

/** `check_html` refuses HTML larger than this (UTF-8 bytes). */
export const CHECK_HTML_MAX_BYTES = 2 * 1024 * 1024;

export const COVERAGES = ["complete", "partial", "unknown"] as const;
export type Coverage = (typeof COVERAGES)[number];

/** Stable acceptance ids: lowercase, dotted, e.g. `metadata.description`. */
export const ACCEPTANCE_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;

export const acceptanceItemSchema = z.object({
  id: z.string().regex(ACCEPTANCE_ID).max(80),
  /** What is checked, in plain language. */
  checks: z.string().min(1).max(300),
  /** The URL the check reads (a page, or the site root for site files). */
  url: z.string().max(2048),
  /** What passing means. */
  passMeans: z.string().min(1).max(400),
  /** page: read from one page's HTML. site: needs site files (robots.txt, sitemap, llms.txt). change: the diff itself. */
  scope: z.enum(["page", "site", "change"]),
});
export type AcceptanceItem = z.infer<typeof acceptanceItemSchema>;

/** One thing Paradigma saw, REA style: what, how completely, and what stayed unseen. */
export const evidenceRecordSchema = z.object({
  id: z
    .string()
    .regex(/^ev-[a-z0-9-]+$/)
    .max(60),
  seen: z.string().min(1).max(500),
  /** Where it was seen: a live scan, a static read of the repository or a pull request check. */
  source: z.enum(["scan", "static", "pr_guard", "search_console", "other"]),
  url: z.string().max(2048).optional(),
  observedAt: z.iso.datetime().optional(),
  coverage: z.enum(COVERAGES),
  /** Residual unknowns, e.g. "sampled 40 of 112 URLs", "JS-only routes not seen". */
  unknowns: z.array(z.string().min(1).max(200)).max(10),
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export const untrustedBlockSchema = z.object({
  id: z.string().max(60),
  /** What the text is: a page title, a diagnostic, a repository string. */
  label: z.string().max(120),
  /** The text wrapped in the brief's nonce markers. */
  text: z.string().max(4000),
});
export type UntrustedBlock = z.infer<typeof untrustedBlockSchema>;

export const playbookSchema = z.object({
  title: z.string().max(200),
  /** Globs relative to the app root where this fix usually lives. */
  anchorFiles: z.array(z.string().max(200)).max(12),
  steps: z.array(z.string().max(500)).max(12),
  pitfalls: z.array(z.string().max(400)).max(10),
  /** How to confirm locally before finishing. */
  verify: z.array(z.string().max(400)).max(6),
});
export type Playbook = z.infer<typeof playbookSchema>;

export const taskBriefSchema = z.object({
  v: z.literal(1),
  taskId: z.uuid(),
  framework: z.object({
    id: z.enum(HARNESS_FRAMEWORKS),
    label: z.string().max(60),
  }),
  /** Null when the category or framework has no playbook yet; the task's instructions still apply. */
  playbook: playbookSchema.nullable(),
  acceptance: z.array(acceptanceItemSchema).max(16),
  evidence: z.array(evidenceRecordSchema).max(12),
  untrusted: z.object({
    /** Every block starts with `<<untrusted:NONCE>>` and ends with `<</untrusted:NONCE>>`. */
    nonce: z.string().regex(/^[A-Za-z0-9]{12,40}$/),
    note: z.string().max(600),
    blocks: z.array(untrustedBlockSchema).max(12),
  }),
  tools: z.object({
    /** `POST` path of check_html on the same server. */
    checkHtml: z.object({
      path: z.string().max(200),
      maxHtmlBytes: z.number().int().positive(),
    }),
  }),
});
export type TaskBrief = z.infer<typeof taskBriefSchema>;

/**
 * `GET /api/autopilot/tasks/:id/brief`: the brief, signed with the task key so the runner only
 * puts server-made text in its prompt. `body` is the exact JSON that was signed.
 */
export const briefResponseSchema = z.object({
  brief: z.object({
    body: z.string().min(2).max(60_000),
    signature: z.string().min(16).max(200),
  }),
});
export type BriefResponse = z.infer<typeof briefResponseSchema>;

export const checkHtmlRequestSchema = z.object({
  taskId: z.uuid().optional(),
  url: z.url().max(2048),
  /** Rendered HTML of `url`. Absent: the server fetches the public URL itself. */
  html: z.string().optional(),
});
export type CheckHtmlRequest = z.infer<typeof checkHtmlRequestSchema>;

export const CHECK_STATUSES = ["pass", "fail", "unknown"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const checkHtmlEvidenceSchema = z.object({
  conclusion: z.string().max(400),
  url: z.string().max(2048).optional(),
  steps: z.array(z.string().max(300)).max(6).optional(),
});

export const checkHtmlResultSchema = z.object({
  id: z.string().regex(ACCEPTANCE_ID).max(80),
  status: z.enum(CHECK_STATUSES),
  checks: z.string().max(300),
  summary: z.string().max(400),
  evidence: z.array(checkHtmlEvidenceSchema).max(4),
});
export type CheckHtmlResult = z.infer<typeof checkHtmlResultSchema>;

export const checkHtmlResponseSchema = z.object({
  url: z.string().max(2048),
  /** html: the HTML sent was read. fetch: the server fetched the public URL. */
  mode: z.enum(["html", "fetch"]),
  /** True when every result passes. */
  passed: z.boolean(),
  results: z.array(checkHtmlResultSchema).max(16),
});
export type CheckHtmlResponse = z.infer<typeof checkHtmlResponseSchema>;

/** How a fix ended, as `finish_task` reports it. One line, never code. */
export const FINISH_OUTCOMES = ["fixed", "skipped", "failed"] as const;
export type FinishOutcome = (typeof FINISH_OUTCOMES)[number];
