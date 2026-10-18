import { z } from "zod";
import {
  checkHtmlResultSchema,
  FINISH_OUTCOMES,
  HARNESS_TOOL_NAMES,
  taskBriefSchema,
} from "./harness";

/**
 * Wire contract of the GitHub Action mode (docs/36 §7): the Paradigma agent running in the
 * customer's GitHub Actions. By default it calls the Paradigma model through the model proxy
 * (`model` below: the hosted agent's provider, models, caps and zero data retention, on
 * Paradigma's account). With "Use my own key" turned on in Paradigma, it calls the customer's own
 * provider directly with their repository secret instead. Shared by the server and
 * `paradigma fix`, dependency-free apart from zod.
 *
 * The engine stays on the server: the task response carries the system prompt, the brief (with
 * its playbook and acceptance items), the tool definitions and the limits, built per task. The
 * CLI only runs the tool loop over the checked-out repository, enforces the same limits, commits
 * and opens the pull request. `check` evaluates on the server; rule ids, weights and thresholds
 * never reach the CLI.
 *
 * Auth: Paradigma dispatches the workflow with `repository_dispatch` and a short-lived task token
 * in `client_payload.task`. Every call below sends it as `Authorization: Bearer <token>`. The
 * token is one task, one run, one repository, and expires with the task's lease.
 */

/** The `repository_dispatch` event type the workflow listens to. */
export const FIX_ACTION_EVENT = "paradigma-fix";

/** Where the setup pull request puts the workflow. */
export const FIX_ACTION_WORKFLOW_PATH = ".github/workflows/paradigma-fix.yml";

/** The composite action the workflow uses (the open-source CLI repository). */
export const FIX_ACTION_USES = "Paradigma-click/paradigma-cli/action@v1";

/** Task tokens: `pdg_fx_<base64url(body)>.<base64url(Ed25519 signature)>`. */
export const FIX_ACTION_TOKEN_PREFIX = "pdg_fx_";

/** A task token lives as long as the task's lease could: never more than this. */
export const FIX_ACTION_TOKEN_TTL_SECONDS = 60 * 60;

export const fixActionTokenBodySchema = z.object({
  v: z.literal(1),
  /** The task. */
  task: z.uuid(),
  /** The run row in the fix ledger. */
  run: z.uuid(),
  /** owner/name, as GitHub spells it. */
  repo: z.string().min(3).max(200),
  /** Expiry, seconds since the epoch. */
  exp: z.number().int().positive(),
});
export type FixActionTokenBody = z.infer<typeof fixActionTokenBodySchema>;

/** Splits a token into its signed body text and signature, without verifying it. */
export function splitFixActionToken(
  token: string,
): { bodyText: string; body: FixActionTokenBody; signature: string } | null {
  if (!token.startsWith(FIX_ACTION_TOKEN_PREFIX) || token.length > 1024)
    return null;
  const [encoded, signature, extra] = token
    .slice(FIX_ACTION_TOKEN_PREFIX.length)
    .split(".");
  if (!encoded || !signature || extra !== undefined) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature))
    return null;
  let bodyText: string;
  try {
    bodyText = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const parsed = fixActionTokenBodySchema.safeParse(value);
  return parsed.success ? { bodyText, body: parsed.data, signature } : null;
}

/** API paths, relative to the Paradigma origin. */
export const FIX_ACTION_PATHS = {
  task: "/api/autopilot/action/task",
  check: "/api/autopilot/action/check",
  model: "/api/autopilot/action/model",
  report: "/api/autopilot/action/report",
} as const;

/**
 * Providers the customer may bring their own key for ("Use my own key"). Only Anthropic and
 * OpenRouter keys today; the setting is shaped for enterprise providers the customer contracts
 * directly (Amazon Bedrock, Google Vertex AI, Azure OpenAI) to join this list later.
 */
export const OWN_MODEL_PROVIDERS = ["anthropic", "openrouter"] as const;
export type OwnModelProvider = (typeof OWN_MODEL_PROVIDERS)[number];

/**
 * Which model the Action uses for one run, decided by Paradigma (the repository's setting):
 * - `paradigma`: the model proxy (`FIX_ACTION_PATHS.model`). No secret; the files the agent reads
 *   pass through Paradigma's servers in memory to the hosted agent's provider, under zero data
 *   retention. Spend counts against the plan's dollar caps.
 * - `own`: the customer's own provider, called straight from the runner with their repository
 *   secret, under their terms. `provider` null means whichever supported secret is set
 *   (`FIX_ACTION_KEY_SECRETS` order). Paradigma's servers never see the conversation.
 */
export const actionModelAccessSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("paradigma") }),
  z.object({
    source: z.literal("own"),
    provider: z.enum(OWN_MODEL_PROVIDERS).nullable(),
  }),
]);
export type ActionModelAccess = z.infer<typeof actionModelAccessSchema>;

/** One tool as the model sees it: the definitions come from the server. */
export const actionToolSchema = z.object({
  name: z.enum(HARNESS_TOOL_NAMES),
  description: z.string().min(1).max(1000),
  /** JSON Schema of the tool's input. */
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ActionTool = z.infer<typeof actionToolSchema>;

export const actionCapsSchema = z.object({
  maxTurns: z.number().int().min(1).max(100),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxOutputPerTurn: z.number().int().positive(),
  /** Bytes one read_file returns at most. */
  maxReadBytes: z.number().int().positive(),
  /** Characters one write_file accepts at most. */
  maxWriteChars: z.number().int().positive(),
  maxList: z.number().int().positive(),
  maxMatches: z.number().int().positive(),
});
export type ActionCaps = z.infer<typeof actionCapsSchema>;

/**
 * `GET /api/autopilot/action/task`: everything the Action needs for one task. Fetching it marks
 * the task running.
 */
export const actionTaskResponseSchema = z.object({
  v: z.literal(1),
  taskId: z.uuid(),
  repo: z.object({
    fullName: z.string().min(3).max(200),
    defaultBranch: z.string().min(1).max(255),
    /** Repo-relative folder of the site; "" for the root. */
    appRoot: z.string().max(300),
  }),
  title: z.string().min(1).max(300),
  category: z.string().min(1).max(40),
  /** Always `paradigma/fix-<task>`. */
  branch: z.string().regex(/^paradigma\/fix-[0-9a-f-]{36}$/),
  /** Open the pull request as a draft (penalty risk cleanup). */
  draft: z.boolean(),
  pr: z.object({
    title: z.string().min(1).max(256),
    body: z.string().min(1).max(20_000),
    /** The commit message, with the `Paradigma-Task` trailer. */
    commitMessage: z.string().min(1).max(2000),
  }),
  allowedPaths: z.array(z.string().min(1).max(200)).min(1).max(50),
  diffBudget: z.object({
    maxFiles: z.number().int().min(1).max(50),
    maxLines: z.number().int().min(1).max(5000),
  }),
  /** Files the Action never reads, lists, writes or sends to a model. */
  secretGlobs: z.array(z.string().min(1).max(100)).max(50),
  /** System prompt and first message of the tool loop, built on the server. */
  system: z.string().min(1).max(20_000),
  prompt: z.string().min(1).max(80_000),
  /** The message for the second attempt; `{feedback}` is replaced by the check's reasons. */
  retryPrompt: z.string().min(1).max(4000),
  brief: taskBriefSchema,
  tools: z.array(actionToolSchema).min(1).max(10),
  caps: actionCapsSchema,
  /** Model ids per provider for this category (used with the customer's own key). */
  models: z.object({
    anthropic: z.string().min(1).max(100),
    openrouter: z.string().min(1).max(100),
  }),
  /**
   * Which model to call. Absent from servers older than the model proxy: those runs use the
   * customer's own key, as before.
   */
  modelAccess: actionModelAccessSchema.optional(),
  /** Build or tests the Action may run before committing (their CI, their choice). */
  needsBuild: z.boolean(),
});
export type ActionTaskResponse = z.infer<typeof actionTaskResponseSchema>;

/** One changed file the Action sends for the static check: allowed paths only, within budget. */
export const actionFileSchema = z.object({
  path: z.string().min(1).max(300),
  /** New content; null when the file was deleted. */
  content: z
    .string()
    .max(256 * 1024)
    .nullable(),
});

/**
 * `POST /api/autopilot/action/check`: `check_html` for the Action. With `html` (or a public
 * `url`), the server evaluates that page. With `files`, the server reads the base of the
 * repository through the GitHub App, overlays the changed files in memory and runs the static
 * pre-PR check, the same one the hosted agent passes. Nothing is stored or logged.
 */
export const actionCheckRequestSchema = z
  .object({
    url: z.string().max(2048).optional(),
    html: z.string().optional(),
    files: z.array(actionFileSchema).max(50).optional(),
    /** The last check before committing: its verdict decides whether the fix may auto-merge. */
    final: z.boolean().optional(),
  })
  .refine((body) => body.files !== undefined || body.url !== undefined, {
    message: "url or files is required",
  });
export type ActionCheckRequest = z.infer<typeof actionCheckRequestSchema>;

export const actionCheckResponseSchema = z.object({
  /** html: a page was read. fetch: the public URL was fetched. static: the edited files. */
  mode: z.enum(["html", "fetch", "static"]),
  passed: z.boolean(),
  results: z.array(checkHtmlResultSchema).max(16),
  /** Why the edit cannot ship, one plain line each (limits, regressions). */
  feedback: z.array(z.string().max(400)).max(12),
});
export type ActionCheckResponse = z.infer<typeof actionCheckResponseSchema>;

// ─── Model proxy ────────────────────────────────────────────────────────────

/** Characters of one tool result the CLI sends back to the model, at most. */
export const ACTION_MODEL_MAX_TOOL_RESULT = 100_000;

/** Bytes of one model proxy request, at most (the conversation within the task's input cap). */
export const ACTION_MODEL_MAX_REQUEST_BYTES = 2 * 1024 * 1024;

const actionModelToolCallSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(64),
  input: z.unknown(),
});

/**
 * One message of the Action's conversation, provider neutral. The system prompt and the tools
 * are never sent: the proxy uses the server's own (the same the task response listed), so the
 * proxy only ever runs the Paradigma agent.
 */
export const actionModelMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    content: z.string().min(1).max(200_000),
  }),
  z.object({
    role: z.literal("assistant"),
    text: z.string().max(100_000),
    toolCalls: z.array(actionModelToolCallSchema).max(20),
  }),
  z.object({
    role: z.literal("tool"),
    results: z
      .array(
        z.object({
          id: z.string().min(1).max(200),
          name: z.string().min(1).max(64),
          output: z.string().max(ACTION_MODEL_MAX_TOOL_RESULT + 100),
        }),
      )
      .min(1)
      .max(20),
  }),
]);
export type ActionModelMessage = z.infer<typeof actionModelMessageSchema>;

/**
 * `POST /api/autopilot/action/model`: one turn of the tool loop on the Paradigma model. The
 * server picks the model for the task's category, enforces the run's token and turn caps
 * request by request, records tokens and cost, and keeps nothing else: the body passes through
 * in memory and is never logged or stored.
 */
export const actionModelRequestSchema = z.object({
  messages: z.array(actionModelMessageSchema).min(1).max(400),
  /** Output tokens this turn may use; the server lowers it to what the caps leave. */
  maxTokens: z.number().int().min(1).max(64_000),
});
export type ActionModelRequest = z.infer<typeof actionModelRequestSchema>;

export const actionModelResponseSchema = z.object({
  model: z.string().min(1).max(120),
  text: z.string().max(200_000),
  toolCalls: z.array(actionModelToolCallSchema).max(20),
  usage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
});
export type ActionModelResponse = z.infer<typeof actionModelResponseSchema>;

/**
 * Error codes of the model proxy (JSON `{ error }`): `caps` (429, the run's token or turn cap is
 * spent), `rate_limited` (429), `provider_unavailable` or `timeout` (502), `model_unavailable`
 * (503, no hosted provider), `own_model` (409, this run uses the customer's own key).
 */
export const ACTION_MODEL_ERRORS = [
  "caps",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "model_error",
  "model_unavailable",
  "own_model",
] as const;
export type ActionModelError = (typeof ACTION_MODEL_ERRORS)[number];

/** Why an Action run did not open a pull request: categories, never text from the repository. */
export const ACTION_REASONS = [
  "no_model_key",
  "model_unavailable",
  "provider_error",
  "rate_limited",
  "limits",
  "pre_pr_failed",
  "agent_skipped",
  "build_failed",
  "git_failed",
  "pr_failed",
  "pr_permission",
  "token_expired",
  "caps",
  "internal_error",
] as const;
export type ActionReason = (typeof ACTION_REASONS)[number];

/** `POST /api/autopilot/action/report`: the `finish_task` of the Action. Metadata only. */
export const actionReportRequestSchema = z.object({
  outcome: z.enum(["pr_opened", "skipped", "failed"]),
  reason: z.enum(ACTION_REASONS).nullable(),
  /** The agent's own finish_task, when it called it. */
  agentOutcome: z.enum(FINISH_OUTCOMES).nullable().optional(),
  prUrl: z.url().max(500).nullable().optional(),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable()
    .optional(),
  changedPaths: z.array(z.string().min(1).max(300)).max(50).default([]),
  lines: z.number().int().nonnegative().max(100_000).default(0),
  /**
   * The model and tokens the CLI counted. With the customer's own key they are recorded as theirs
   * (no spend); with the Paradigma model the server's own per-request count is kept instead.
   */
  model: z.string().max(120).nullable().optional(),
  tokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .optional(),
  /** Build and test commands the Action ran, by name and status only. */
  checks: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        status: z.enum(["passed", "failed", "skipped", "timeout"]),
        durationMs: z.number().int().nonnegative().max(3_600_000),
      }),
    )
    .max(10)
    .optional(),
});
export type ActionReportRequest = z.input<typeof actionReportRequestSchema>;

export const actionReportResponseSchema = z.object({ ok: z.literal(true) });

/**
 * Repository secrets the Action reads with "Use my own key", in order of preference. Without
 * that setting the Action ignores them.
 */
export const FIX_ACTION_KEY_SECRETS = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/**
 * The workflow the setup pull request adds (`.github/workflows/paradigma-fix.yml`). The Paradigma
 * origin is written into the file, never taken from the dispatch payload, so a task token only
 * ever goes back to the server that issued it. The token reaches the step through `env`, never
 * interpolated into a shell line. No secret is needed: the model comes from Paradigma. The
 * secret lines stay commented out for "Use my own key".
 */
export function fixActionWorkflow(input: { appUrl: string }): string {
  const origin = new URL(input.appUrl).origin;
  return [
    "# Paradigma fixes in your own GitHub Actions (https://paradigma.click).",
    "# Paradigma starts this workflow with repository_dispatch for one task at a time.",
    "# The model comes from Paradigma: no secret is needed.",
    "name: Paradigma fix",
    "on:",
    "  repository_dispatch:",
    `    types: [${FIX_ACTION_EVENT}]`,
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "concurrency:",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not JavaScript.
    "  group: paradigma-fix-${{ github.event.client_payload.task_id }}",
    "  cancel-in-progress: false",
    "jobs:",
    "  fix:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      - uses: ${FIX_ACTION_USES}`,
    "        with:",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not JavaScript.
    "          task: ${{ github.event.client_payload.task }}",
    `          api-url: ${origin}`,
    "          # Optional: your build and tests, run before the pull request opens.",
    '          build-command: ""',
    '          test-command: ""',
    "        # Optional: your own model key, only if you turn on Use my own key in Paradigma.",
    "        # env:",
    ...FIX_ACTION_KEY_SECRETS.map(
      (name) => `        #   ${name}: \${{ secrets.${name} }}`,
    ),
    "",
  ].join("\n");
}
