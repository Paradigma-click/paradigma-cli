import { z } from "zod";
import { diffBudgetSchema, runnerPreferenceSchema } from "./autopilot";
import { GEO_SAMPLE_ENGINES } from "./geo-engines";
import { taskBriefSchema } from "./harness";

/**
 * Wire contract for `/api/cli/v1/*`, shared by the Paradigma server and the
 * `paradigma` CLI. Keep it dependency-free apart from zod and relative imports
 * of other modules in this folder (no path aliases, no server code).
 *
 * Request schemas are the transport shape only; the server still applies its
 * own validation and permission checks.
 */

export const CLI_API_PREFIX = "/api/cli/v1";

/** Stable error codes in `{ error, message }` bodies. */
export const CLI_ERROR_CODES = [
  "invalid_token",
  "invalid_request",
  "invalid_json",
  "invalid_body",
  "payload_too_large",
  "disabled",
  "not_found",
  "forbidden",
  "billing_owner_required",
  "full_autopilot_forbidden",
  "confirmation_required",
  "invalid_input",
  "unverified",
  "unavailable",
  "conflict",
  "internal",
] as const;
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

export const cliErrorBodySchema = z.object({
  error: z.string().max(64),
  message: z.string().max(500).optional(),
  issues: z
    .array(z.object({ path: z.string(), code: z.string() }))
    .max(10)
    .optional(),
});
export type CliErrorBody = z.infer<typeof cliErrorBodySchema>;

const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

const name = z.string().trim().min(1).max(80);

export const projectConfigBodySchema = z
  .object({
    productionUrl: z.string().trim().min(1).max(2048),
    sitemapUrl: z.string().trim().max(2048).nullish(),
    brandName: name,
    brandAliases: z.array(name).max(10).optional(),
    category: z.string().trim().min(1).max(100),
    useCase: z.string().trim().min(1).max(100),
    competitors: z.array(name).max(10).optional(),
    competitorAliases: z
      .array(z.object({ name, aliases: z.array(name).min(1).max(10) }))
      .max(10)
      .optional(),
  })
  .strict();

export const createProjectRequestSchema = z
  .object({
    repoId: z.uuid(),
    /** Empty string for the repository root. */
    appRoot: z.string().max(500),
    config: projectConfigBodySchema,
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    config: projectConfigBodySchema.partial(),
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const VERIFICATION_METHODS = ["dns", "file", "meta"] as const;
export type CliVerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const verifyRequestSchema = z
  .object({
    methods: z.array(z.enum(VERIFICATION_METHODS)).min(1).max(3).optional(),
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

export const operationBodySchema = z
  .object({ idempotencyKey: idempotencyKey.optional() })
  .strict();

export const SYNC_SOURCES = [
  "gsc",
  "bing",
  "ga4",
  "performance",
  "plausible",
  "posthog",
] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

export const syncRequestSchema = z
  .object({
    source: z.enum(SYNC_SOURCES),
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

/** Secrets are accepted loosely so validation issues never describe a value. */
const secret = z.string().min(1).max(1024);
const geoKeyBody = <P extends string>(provider: P) =>
  z.object({ provider: z.literal(provider), apiKey: secret }).strict();

export const CREDENTIAL_PROVIDERS = [
  "bing",
  "crux",
  "plausible",
  "posthog",
  "gemini",
  "openai",
  "anthropic",
  "perplexity",
  "dataforseo",
] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

/** Write-only: no response ever contains these values. */
export const credentialRequestSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("bing"),
      apiKey: secret,
      idempotencyKey: idempotencyKey.optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("crux"),
      apiKey: secret,
      idempotencyKey: idempotencyKey.optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("plausible"),
      apiKey: secret,
      siteDomain: z.string().trim().min(1).max(253).optional(),
      idempotencyKey: idempotencyKey.optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("posthog"),
      apiKey: secret,
      region: z.enum(["us", "eu"]),
      posthogProjectId: z.string().trim().min(1).max(40),
      idempotencyKey: idempotencyKey.optional(),
    })
    .strict(),
  geoKeyBody("gemini"),
  geoKeyBody("openai"),
  geoKeyBody("anthropic"),
  geoKeyBody("perplexity"),
  z
    .object({
      provider: z.literal("dataforseo"),
      login: z.string().trim().min(1).max(200),
      password: secret,
      locationCode: z.number().int().min(1).max(99_999_999),
      languageCode: z.string().trim().min(2).max(10),
    })
    .strict(),
]);
export type CredentialRequest = z.infer<typeof credentialRequestSchema>;

export const GEO_ENGINES = GEO_SAMPLE_ENGINES;
export type CliGeoEngine = (typeof GEO_ENGINES)[number];
export const GEO_DAILY_LIMITS = [1, 3, 5, 10] as const;

// ─── AI visibility: OpenRouter and engine routes ───────────────────────────

/** Engines one OpenRouter key samples; Google AI Overviews and AI Mode need DataForSEO. */
export const OPENROUTER_ENGINES = [
  "gemini",
  "openai",
  "claude",
  "perplexity",
] as const;

/**
 * Starts OpenRouter OAuth PKCE on the server. `workspace` (the default)
 * covers every project in the project's workspace the user can write to;
 * `all` every writable project; `project` only this one.
 */
export const openRouterStartBodySchema = z
  .object({
    projectId: z.uuid(),
    scope: z.enum(["project", "workspace", "all"]).default("workspace"),
  })
  .strict();
export type OpenRouterStartBody = z.input<typeof openRouterStartBodySchema>;

/** The URL to open in a browser; the key goes from OpenRouter to the server only. */
export const openRouterStartResponseSchema = z
  .object({
    requestId: z.string(),
    authorizationUrl: z.string(),
    expiresAt: z.string(),
    projectIds: z.array(z.string()),
  })
  .passthrough();
export type CliOpenRouterStart = z.infer<typeof openRouterStartResponseSchema>;

export const OPENROUTER_REQUEST_STATUSES = [
  "pending",
  "exchanging",
  "connected",
  "declined",
  "failed",
  "expired",
] as const;

export const openRouterStatusResponseSchema = z
  .object({
    requestId: z.string(),
    status: z.enum(OPENROUTER_REQUEST_STATUSES),
    expiresAt: z.string(),
    projectIds: z.array(z.string()),
    connectedProjectIds: z.array(z.string()),
  })
  .passthrough();
export type CliOpenRouterStatus = z.infer<
  typeof openRouterStatusResponseSchema
>;

// ─── Bing Webmaster: "Connect Bing" with Microsoft OAuth ───────────────────

/**
 * Starts Bing Webmaster OAuth on the server for one project. `available:
 * false` means the server has no Bing OAuth client: use an API key
 * (`paradigma connect bing --key-env NAME`). The tokens go from Microsoft
 * to the server only.
 */
export const bingOAuthStartResponseSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      requestId: z.string(),
      authorizationUrl: z.string(),
      expiresAt: z.string(),
      projectId: z.string(),
    })
    .passthrough(),
  z.object({ available: z.literal(false) }).passthrough(),
]);
export type CliBingOAuthStart = z.infer<typeof bingOAuthStartResponseSchema>;

export const BING_OAUTH_REQUEST_STATUSES = [
  "pending",
  "exchanging",
  /** Several Bing properties match: the browser shows the picker. */
  "choose",
  "connected",
  "no_property",
  /**
   * The Bing account lacked the production domain: Paradigma added it and an
   * agent installs Bing's verification code (setup task `setup/bing-verify`);
   * Bing connects by itself once the deploy is verified.
   */
  "verifying",
  "declined",
  "failed",
  "expired",
] as const;

export const bingOAuthStatusResponseSchema = z
  .object({
    requestId: z.string(),
    status: z.enum(BING_OAUTH_REQUEST_STATUSES),
    projectId: z.string(),
    expiresAt: z.string(),
  })
  .passthrough();
export type CliBingOAuthStatus = z.infer<typeof bingOAuthStatusResponseSchema>;

/** How each engine of a project is called now; never a key or its label. */
export const aiEnginesResponseSchema = z
  .object({
    projectId: z.string(),
    openRouter: z.object({ connectedAt: z.string() }).passthrough().nullable(),
    engines: z.array(
      z
        .object({
          engine: z.string(),
          transport: z.enum(["direct", "openrouter"]).nullable(),
          automaticSampling: z.boolean(),
        })
        .passthrough(),
    ),
    /**
     * AI visibility included in the plan, sampled on Paradigma's key
     * (engines with no key of their own). Null when not included; absent
     * from older servers.
     */
    included: z
      .object({
        plan: z.string(),
        promptsPerDay: z.number().int(),
        engines: z.array(z.string()),
        activePrompts: z.number().int(),
        paused: z.string().nullable(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type CliAiEngines = z.infer<typeof aiEnginesResponseSchema>;

export const promptsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  state: z.enum(["all", "active", "inactive"]).default("all"),
});

export const savePromptRequestSchema = z
  .object({
    text: z.string().min(5).max(500),
    /** brand prompts show how AI describes the brand; at most 10 active. */
    segment: z.enum(["discovery", "brand"]).optional(),
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

export const geoScheduleBodySchema = z
  .object({
    engine: z.enum(GEO_ENGINES),
    dailyLimit: z.union([
      z.literal(1),
      z.literal(3),
      z.literal(5),
      z.literal(10),
    ]),
    /** Days between automatic runs; google_ai_mode only (7 = weekly default). */
    intervalDays: z.union([z.literal(1), z.literal(7)]).optional(),
    enabled: z.boolean().default(true),
    /** Mandatory explicit consent to customer-key charges when enabling. */
    acceptCharges: z.boolean().default(false),
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

export const geoSampleBodySchema = z
  .object({
    promptId: z.uuid(),
    engine: z.enum(GEO_ENGINES),
    /** Must be exactly true: the provider call may be charged even if it fails. */
    acceptCharges: z.boolean().default(false),
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

export const alertBudgetBodySchema = z
  .object({ weekly: z.number().int().min(0).max(3) })
  .strict();

export const checkoutBodySchema = z
  .object({ plan: z.enum(["pro", "agency"]) })
  .strict();

export const autopilotPauseBodySchema = z
  .object({ reason: z.string().trim().min(1).max(200).optional() })
  .strict();

const autopilotLevel = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

/**
 * Workspace default level for every repository of an organization; the ones
 * that follow it change at once and new repositories start following it.
 * Level 0 needs an allowlisted account and confirmFullAutopilot: true.
 */
export const autopilotDefaultBodySchema = z
  .object({
    level: autopilotLevel,
    /** Defaults to true; false keeps the level but switches Autopilot off. */
    enabled: z.boolean().optional(),
    confirmFullAutopilot: z.boolean().optional(),
  })
  .strict();
export type AutopilotDefaultBody = z.infer<typeof autopilotDefaultBodySchema>;

/** Makes a repository follow the workspace default again. */
export const autopilotFollowDefaultBodySchema = z
  .object({ confirmFullAutopilot: z.boolean().optional() })
  .strict();

/** A workspace default as answered by the server (absent on older servers). */
export const autopilotWorkspaceDefaultSchema = z
  .object({
    orgId: z.string(),
    enabled: z.boolean(),
    level: autopilotLevel,
  })
  .passthrough();

/**
 * Answer of the policy and follow-default routes. `inherits` and
 * `workspaceDefault` are absent from servers without workspace defaults.
 */
export const autopilotPolicyResponseSchema = z
  .object({
    repoId: z.string(),
    policy: z
      .object({
        enabled: z.boolean().optional(),
        level: autopilotLevel.optional(),
        inherits: z.boolean().optional(),
      })
      .passthrough(),
    workspaceDefault: autopilotWorkspaceDefaultSchema.nullish(),
    /** GET only: whether this account may choose level 0 on the repository. */
    fullAutopilotAllowed: z.boolean().optional(),
    /**
     * GET only: whether this account may pair and run the local runner (internal admins only,
     * docs/36 §0). Absent from older servers; treat absent as false for new setups.
     */
    runnerAllowed: z.boolean().optional(),
  })
  .passthrough();
export type CliAutopilotPolicyResponse = z.infer<
  typeof autopilotPolicyResponseSchema
>;

export const autopilotDefaultResponseSchema = z
  .object({
    orgId: z.string(),
    workspaceDefault: autopilotWorkspaceDefaultSchema,
    /** Repositories that already followed the default and changed. */
    updated: z.number(),
    /** Repositories without a policy that now follow it. */
    inserted: z.number(),
  })
  .passthrough();
export type CliAutopilotDefaultResponse = z.infer<
  typeof autopilotDefaultResponseSchema
>;

/**
 * The agent, model and effort this runner should use (`/api/cli/v1/runner`).
 * null is Auto (the runner picks an installed agent) and the agent's default
 * model and effort; an omitted effort is the default too.
 */
export const runnerAgentBodySchema = runnerPreferenceSchema.strict();
export type RunnerAgentBody = z.infer<typeof runnerAgentBodySchema>;

/** The calling runner as the dashboard shows it. */
export const cliRunnerResponseSchema = z
  .object({
    runnerId: z.string(),
    name: z.string(),
    agents: z.array(
      z
        .object({
          name: z.string(),
          version: z.string().nullable(),
          loggedIn: z.boolean().nullable().optional(),
        })
        .passthrough(),
    ),
    preferred: z.object({
      agent: z.string().nullable(),
      model: z.string().nullable(),
      /** Absent from older servers. */
      effort: z.string().nullable().optional(),
    }),
    lastAgent: z
      .object({
        name: z.string(),
        version: z.string().nullable(),
        model: z.string().nullable(),
        effort: z.string().nullable().optional(),
      })
      .nullable(),
  })
  .passthrough();
export type CliRunnerResponse = z.infer<typeof cliRunnerResponseSchema>;

// ─── Responses built by the routes (actions return their own shapes) ───────

const link = z.string().nullable();

export const cliStatusResponseSchema = z.object({
  ready: z.boolean(),
  next: z.string().nullable(),
  steps: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.string(),
      done: z.boolean(),
    }),
  ),
  project: z
    .object({
      siteId: z.string(),
      repoId: z.string(),
      orgId: z.string(),
      name: z.string(),
      productionUrl: z.string(),
      verified: z.boolean(),
    })
    .nullable(),
  /** Absolute URLs to hand to the person. */
  links: z.record(z.string(), link),
  server: z.string(),
  mcpUrl: z.string(),
});
export type CliStatusResponse = z.infer<typeof cliStatusResponseSchema>;

export const cliTargetsResponseSchema = z.object({
  repositories: z.array(
    z.object({
      repoId: z.string(),
      orgId: z.string(),
      owner: z.string(),
      name: z.string(),
      fullName: z.string(),
      enabled: z.boolean(),
      apps: z.array(
        z.object({
          appRoot: z.string(),
          // Absent from servers older than any-framework support.
          framework: z.string().optional(),
          // How the app is published (deploy-host.ts ids); absent from older servers.
          deployHost: z.string().nullable().optional(),
          router: z.string().nullable(),
          projectId: z.string().nullable(),
          productionUrl: z.string().nullable(),
          verified: z.boolean().nullable(),
        }),
      ),
    }),
  ),
  installGithubAppUrl: link,
  /**
   * Live GitHub App installations the user can see, so a missing repository
   * can be added to the existing one with a pre-selected link. Absent from
   * older servers.
   */
  installations: z
    .array(
      z.object({
        installationId: z.number(),
        accountId: z.number(),
        accountLogin: z.string(),
      }),
    )
    .optional(),
});
export type CliTargetsResponse = z.infer<typeof cliTargetsResponseSchema>;
export type CliTargetRepository = CliTargetsResponse["repositories"][number];

export const cliProjectsResponseSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      orgId: z.string(),
      repoId: z.string(),
      repoFullName: z.string().nullable(),
      appRoot: z.string(),
      name: z.string(),
      productionUrl: z.string(),
      /** null when the app is no longer detected or not writable. */
      verified: z.boolean().nullable(),
    }),
  ),
});
export type CliProjectsResponse = z.infer<typeof cliProjectsResponseSchema>;
export type CliProject = CliProjectsResponse["projects"][number];

export const verificationInstructionsSchema = z.object({
  dns: z.object({ name: z.string(), value: z.string() }),
  file: z.object({
    path: z.string(),
    url: z.string(),
    contents: z.string(),
    repoPath: z.string(),
  }),
  meta: z.object({ tag: z.string(), nextjsMetadata: z.string() }),
});
export type CliVerificationInstructions = z.infer<
  typeof verificationInstructionsSchema
>;

/** "Set up Google for me" state (docs/19); passthrough keeps newer fields. */
export const googleSetupResponseSchema = z
  .object({
    projectId: z.string(),
    verified: z.boolean(),
    started: z.boolean(),
    done: z.boolean(),
    startUrl: z.string(),
    result: z.string().optional(),
    searchConsole: z
      .object({
        status: z.string(),
        property: z.string().nullable(),
        file: z
          .object({
            name: z.string(),
            repoPath: z.string(),
            url: z.string(),
            contents: z.string(),
          })
          .nullable(),
        pullUrl: z.string().nullable(),
      })
      .passthrough(),
    analytics: z
      .object({
        status: z.string(),
        propertyId: z.string().nullable(),
        measurementId: z.string().nullable(),
        accounts: z.array(z.object({ id: z.string(), name: z.string() })),
        createAccountUrl: z.string().nullable(),
        tagInstructions: z.string().nullable(),
      })
      .passthrough(),
    lastError: z.string().nullable(),
  })
  .passthrough();
export type CliGoogleSetup = z.infer<typeof googleSetupResponseSchema>;

export const chooseGa4AccountRequestSchema = z
  .object({
    accountId: z.string().regex(/^[1-9]\d{0,15}$/),
    timeZone: z.string().max(64).optional(),
  })
  .strict();

// ─── IndexNow (docs/22) ─────────────────────────────────────────────────────

export const indexNowEnabledBodySchema = z
  .object({ enabled: z.boolean() })
  .strict();

/**
 * `paradigma gsc-ai import`: the Search Console Generative AI export (the
 * .zip or its CSVs) as base64, at most 5 files and 512 KB decoded. The
 * server parses it like the dashboard upload; `fromDate`/`toDate` are needed
 * only when the export has no Chart.csv.
 */
export const gscAiImportRequestSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            name: z.string().min(5).max(124),
            base64: z.string().max(700_000),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    fromDate: z.iso.date().optional(),
    toDate: z.iso.date().optional(),
  })
  .strict();
export type GscAiImportRequest = z.infer<typeof gscAiImportRequestSchema>;

/** The last Search Console AI report import and the export deep link. */
export const gscAiStatusResponseSchema = z
  .object({
    projectId: z.string(),
    productionUrl: z.string(),
    verified: z.boolean(),
    searchConsoleConnected: z.boolean(),
    property: z.string().nullable(),
    /** search.google.com/search-console/performance/search-analytics/ai?resource_id=… */
    reportUrl: z.string(),
    lastImport: z
      .object({
        importedAt: z.string(),
        fromDate: z.string(),
        toDate: z.string(),
        pages: z.number(),
        days: z.number(),
      })
      .passthrough()
      .nullable(),
    settingsUrl: z.string(),
  })
  .passthrough();
export type CliGscAiStatus = z.infer<typeof gscAiStatusResponseSchema>;

export const gscAiImportResponseSchema = z
  .object({
    projectId: z.string(),
    imported: z.literal(true),
    fromDate: z.string(),
    toDate: z.string(),
    pages: z.number(),
    days: z.number(),
    settingsUrl: z.string(),
  })
  .passthrough();
export type CliGscAiImport = z.infer<typeof gscAiImportResponseSchema>;

/** IndexNow state for a project; setup and on/off answer with the same shape plus `result` / `enabled`. */
export const indexNowStatusResponseSchema = z
  .object({
    projectId: z.string(),
    productionUrl: z.string(),
    /** not_started | waiting (key file not served yet) | active | off */
    state: z.string(),
    keyFilePath: z.string().nullable(),
    keyFileUrl: z.string().nullable(),
    pullRequestUrl: z.string().nullable(),
    recentDeploys: z.array(
      z
        .object({
          urlCount: z.number(),
          /** baseline | submitted | nothing_changed | no_sitemap | key_unverified | failed | pending */
          outcome: z.string(),
          httpStatus: z.number().nullable(),
          submittedAt: z.string(),
        })
        .passthrough(),
    ),
    settingsUrl: z.string(),
    /** setup only: started | verified | conflict */
    result: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();
export type CliIndexNowStatus = z.infer<typeof indexNowStatusResponseSchema>;

// ─── Google index coverage ──────────────────────────────────────────────────

/** Pages a person asks Google to index each day (Search Console's own limit is about this). */
export const INDEX_REQUESTS_PER_DAY = 10;

const indexRequestItemSchema = z
  .object({
    url: z.string(),
    /** discovered_not_indexed | crawled_not_indexed | unknown | … */
    reason: z.string(),
    reasonLabel: z.string(),
    /** Search Console URL Inspection for this page, where "Request indexing" is. */
    inspectUrl: z.string(),
    requested: z.boolean(),
    requestedAt: z.string().nullable(),
    /** waiting | indexed_after_request | not_yet; null before a request */
    outcome: z.string().nullable(),
  })
  .passthrough();

const indexRequestsSchema = z
  .object({
    /** UTC day the list was picked; null before the first daily check. */
    day: z.string().nullable(),
    items: z.array(indexRequestItemSchema),
  })
  .passthrough();

const indexWinSchema = z
  .object({ url: z.string(), requestedAt: z.string(), indexedAt: z.string() })
  .passthrough();

/** Index coverage of a project from Google's URL Inspection, plus today's pages to request. */
export const indexCoverageResponseSchema = z
  .object({
    projectId: z.string(),
    productionUrl: z.string(),
    /** Search Console connected for this project. */
    connected: z.boolean(),
    property: z.string().nullable(),
    /** read_write (sitemaps can be resubmitted) | read_only | unknown */
    access: z.string(),
    candidates: z.number(),
    checked: z.number(),
    indexed: z.number(),
    notChecked: z.number(),
    /** indexed / checked; null before the first inspection */
    coverage: z.number().nullable(),
    /** Indexed now minus the previous day; null without history */
    change: z.number().nullable(),
    byReason: z.record(z.string(), z.number()),
    lastCheckAt: z.string().nullable(),
    running: z.boolean(),
    budget: z
      .object({ daily: z.number(), usedToday: z.number() })
      .passthrough(),
    requests: indexRequestsSchema,
    wins: z.array(indexWinSchema),
    sitemap: z
      .object({
        read: z.boolean().nullable(),
        roots: z.array(z.string()),
        canSubmit: z.boolean(),
        submittedAt: z.string().nullable(),
        submitError: z.string().nullable(),
        report: z.array(
          z
            .object({
              path: z.string(),
              lastSubmitted: z.string().nullable(),
              lastDownloaded: z.string().nullable(),
              isPending: z.boolean(),
              errors: z.number(),
              warnings: z.number(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    dashboardUrl: z.string(),
    /** Consent link for read/write Search Console (sitemap resubmission); null when granted. */
    reconnectUrl: z.string().nullable(),
  })
  .passthrough();
export type CliIndexCoverage = z.infer<typeof indexCoverageResponseSchema>;

export const indexRequestedBodySchema = z
  .object({
    urls: z.array(z.string().min(1).max(2048)).min(1).max(20),
    /** false clears the mark */
    requested: z.boolean().default(true),
  })
  .strict();
export type IndexRequestedBody = z.input<typeof indexRequestedBodySchema>;

export const indexRequestedResponseSchema = z
  .object({
    projectId: z.string(),
    /** Stored URLs that were marked (or cleared). */
    marked: z.array(z.string()),
    /** URLs that are not among the project's checked pages. */
    unknown: z.array(z.string()),
    requests: indexRequestsSchema,
  })
  .passthrough();
export type CliIndexRequested = z.infer<typeof indexRequestedResponseSchema>;

/** `requested` false: a check is already running (reason running). */
export const indexCheckResponseSchema = z
  .object({
    projectId: z.string(),
    requested: z.boolean(),
    reason: z.string().optional(),
    budget: z
      .object({ daily: z.number(), usedToday: z.number() })
      .passthrough(),
  })
  .passthrough();
export type CliIndexCheck = z.infer<typeof indexCheckResponseSchema>;

// ─── Four-pillar scan of a project ──────────────────────────────────────────

/**
 * `none` until the first scan is requested; `failed` when the newest scan
 * errored. Scores and fixes always come from the latest completed scan, so a
 * rescan in flight (`queued`, `running`) still answers with the previous ones.
 */
export const PROJECT_SCAN_STATUSES = [
  "none",
  "queued",
  "running",
  "completed",
  "failed",
] as const;
export type ProjectScanStatus = (typeof PROJECT_SCAN_STATUSES)[number];

/** POST takes no options: the server scans the production URL and respects scans in flight. */
export const projectScanRequestSchema = z.object({}).strict();

/** Fixes in the answer; `openFixes` counts all of them. */
export const PROJECT_SCAN_FIXES = 5;

/**
 * What was found and how to fix it: scores, labels, counts and the fix-first
 * list. Never thresholds, weights or how a check decides.
 */
export const projectScanResponseSchema = z
  .object({
    projectId: z.string(),
    productionUrl: z.string(),
    status: z.enum(PROJECT_SCAN_STATUSES),
    /** When the latest completed scan finished; null before the first one. */
    scannedAt: z.string().nullable(),
    /** SEO, AEO, GEO, Agents; empty until a scan completes. */
    pillars: z.array(
      z
        .object({
          pillar: z.string(),
          name: z.string(),
          /** Whole number 0 to 100; null when no check applies. */
          score: z.number().nullable(),
          label: z.string().nullable(),
          counts: z
            .object({
              pass: z.number().int(),
              partial: z.number().int(),
              fail: z.number().int(),
              na: z.number().int(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
    /** The top fixes across pillars, most important first. */
    fixes: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            /** The first pillar it affects; `pillars` lists all of them. */
            pillar: z.string(),
            pillars: z.array(z.string()),
            status: z.enum(["fail", "partial"]),
            summary: z.string(),
            /** What to change, in plain language; null when there is nothing to change in code. */
            fix: z.string().nullable(),
            /** Autopilot can open and merge this fix on its own. */
            autopilot: z.boolean(),
          })
          .passthrough(),
      )
      .max(PROJECT_SCAN_FIXES),
    /** Every open fix of the latest scan, the ones above included. */
    openFixes: z.number().int(),
    dashboardUrl: z.string(),
    /** The domain is not verified: the fixes are queued as tasks that unlock once it is. */
    locked: z.boolean(),
    next: z
      .object({ id: z.string(), label: z.string(), command: z.string() })
      .passthrough()
      .nullable(),
    /** POST only: whether this call started a scan, and why not. */
    requested: z.boolean().optional(),
    reason: z.enum(["in_flight", "too_soon"]).optional(),
  })
  .passthrough();
export type CliProjectScan = z.infer<typeof projectScanResponseSchema>;

// ─── Project tasks: your own agent works them, or a background run ─────────

/**
 * Task statuses as a person sees them. `needs_you` is a draft or suggestion
 * that needs a person; `running` is claimed by a runner or started by an
 * agent; `live` is merged and confirmed on the production site.
 */
export const PROJECT_TASK_STATUSES = [
  "queued",
  "needs_you",
  "running",
  "pr_opened",
  "merged",
  "live",
  "failed",
  "skipped",
] as const;
export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];

/** Statuses counted as open (`status=open`); every other one is done. */
export const OPEN_PROJECT_TASK_STATUSES = [
  "queued",
  "needs_you",
  "running",
  "pr_opened",
] as const satisfies readonly ProjectTaskStatus[];

/**
 * `auto`: an agent can do it alone. `draft`: a prepared change a person
 * reviews. `suggestion`: an unscored suggestion a person decides on.
 */
export const PROJECT_TASK_MODES = ["auto", "draft", "suggestion"] as const;
export type ProjectTaskMode = (typeof PROJECT_TASK_MODES)[number];

/** Who started a running or finished task; null while it waits. */
export const TASK_STARTERS = ["runner", "agent"] as const;
export type TaskStarter = (typeof TASK_STARTERS)[number];

export const tasksQuerySchema = z.object({
  project: z.uuid().optional(),
  status: z.enum(["open", "all"]).default("open"),
});
export type TasksQuery = z.infer<typeof tasksQuerySchema>;

/**
 * Who does a setup step: `agent` (a coding agent, by running the command or
 * editing code) or `you` (it needs the person: a consent screen, a paid
 * plan, a Slack channel, merging a pull request).
 */
export const SETUP_WHO = ["agent", "you"] as const;
export type SetupWho = (typeof SETUP_WHO)[number];

/**
 * A project setup step (category `setup`): a connection or an install the
 * project still lacks. Absent on every other task and from older servers.
 */
export const projectTaskSetupSchema = z.object({
  /** Stable step key, e.g. `setup/ga4-tag`. */
  key: z.string(),
  /** One line: why it matters. */
  why: z.string(),
  who: z.enum(SETUP_WHO),
  /** The exact command to run, when there is one. */
  command: z.string().nullable(),
  /** Something a connection created that must go into the site's code; done first. */
  install: z.boolean(),
  /**
   * Another way the person can finish it themselves (e.g. "Or in Bing
   * Webmaster Tools: Import from Google Search Console"). Absent on older servers.
   */
  alternative: z
    .object({ text: z.string(), url: z.string() })
    .nullable()
    .optional(),
  /** Finished because the connection or install is in place, whoever did it. */
  done: z.boolean(),
});
export type ProjectTaskSetup = z.infer<typeof projectTaskSetupSchema>;

export const projectTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  risk: z.string(),
  status: z.enum(PROJECT_TASK_STATUSES),
  mode: z.enum(PROJECT_TASK_MODES),
  /** UTC day the task was planned, YYYY-MM-DD. */
  plannedFor: z.string(),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  /** Dashboard page of the issue the task fixes; null for reverts. */
  findingUrl: z.string().nullable(),
  startedBy: z.enum(TASK_STARTERS).nullable(),
  updatedAt: z.string(),
  /** Setup steps only; listed first, in a Setup group. */
  setup: projectTaskSetupSchema.nullable().optional(),
});
export type ProjectTask = z.infer<typeof projectTaskSchema>;

export const projectTaskCountsSchema = z.object({
  queued: z.number().int(),
  needsYou: z.number().int(),
  running: z.number().int(),
  /** queued + needs_you + running + pr_opened. */
  open: z.number().int(),
  /** Finished in the last 30 days. */
  done: z.number().int(),
});
export type ProjectTaskCounts = z.infer<typeof projectTaskCountsSchema>;

export const projectTasksSchema = z.object({
  project: z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    /** owner/name */
    repo: z.string(),
    /** False: the domain is not verified and its queued tasks are locked. */
    verified: z.boolean(),
    /** Whether scheduled background runs claim these tasks, and how far they go. */
    autopilot: z.object({ enabled: z.boolean(), level: autopilotLevel }),
  }),
  counts: projectTaskCountsSchema,
  /** Open tasks in the order to work them, then done ones (with status=all). */
  tasks: z.array(projectTaskSchema),
});
export type ProjectTasks = z.infer<typeof projectTasksSchema>;

/** GET /tasks?project=&status=open|all */
export const tasksResponseSchema = z.object({
  projects: z.array(projectTasksSchema),
});
export type TasksResponse = z.infer<typeof tasksResponseSchema>;

/** Hours a manual start holds a task for the calling user. */
export const MANUAL_LEASE_HOURS = 2;

/**
 * POST /tasks/<id>/start: the task, leased to the calling user so the
 * current agent works it in the person's own checkout. Never signed and
 * never carries repository contents.
 */
export const startTaskResponseSchema = z.object({
  task: z.object({
    id: z.string(),
    title: z.string(),
    instructions: z.string(),
    acceptance: z.array(z.string()),
    /** Glob patterns relative to the repository root. */
    allowedPaths: z.array(z.string()),
    diffBudget: diffBudgetSchema,
    category: z.string(),
    risk: z.string(),
    repo: z.object({
      owner: z.string(),
      name: z.string(),
      defaultBranch: z.string(),
      /** Empty for the repository root. */
      appRoot: z.string(),
    }),
    project: z.object({ id: z.string(), name: z.string(), url: z.string() }),
    findingUrl: z.string().nullable(),
    /** paradigma/<first 8 characters of the task id> */
    branch: z.string(),
    leaseExpiresAt: z.string(),
    /** The fix harness brief (docs/36 §5.1), when the server can build one. */
    brief: taskBriefSchema.optional(),
  }),
});
export type StartTaskResponse = z.infer<typeof startTaskResponseSchema>;
export type StartedTask = StartTaskResponse["task"];

export const TASK_REASON_MAX = 200;

/**
 * Why a finish reason is refused, or null when it is fine. A reason is a
 * short human note: never code (no fences) and at most 200 characters.
 */
export function taskReasonProblem(reason: string): string | null {
  if (reason.length > TASK_REASON_MAX)
    return `Keep the reason under ${TASK_REASON_MAX} characters.`;
  if (/```|~~~/.test(reason))
    return "Keep the reason a short note; never paste code.";
  return null;
}

/**
 * POST /tasks/<id>/finish. `done`: merged or committed without a pull
 * request. `pr_opened` needs `prUrl`, a github.com pull request of the
 * task's repository.
 */
export const FINISH_TASK_STATUSES = [
  "pr_opened",
  "done",
  "skipped",
  "failed",
] as const;
export type FinishTaskStatus = (typeof FINISH_TASK_STATUSES)[number];
export const finishTaskRequestSchema = z
  .object({
    status: z.enum(FINISH_TASK_STATUSES),
    prUrl: z.string().trim().min(1).max(500).optional(),
    /** Checked with taskReasonProblem, so the refusal can say why. */
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type FinishTaskRequest = z.infer<typeof finishTaskRequestSchema>;

/** Answer of finish and release: the task as `tasks` lists it. */
export const taskResponseSchema = z.object({ task: projectTaskSchema });
export type TaskResponse = z.infer<typeof taskResponseSchema>;

/** GET /projects/<id>/tasks/prompt: the text a person pastes into their coding agent. */
export const taskPromptResponseSchema = z.object({ prompt: z.string() });

/** Minutes a background run request waits for a runner. */
export const RUN_REQUEST_TTL_MINUTES = 60;

export const RUN_REQUEST_STATUSES = ["pending", "claimed", "expired"] as const;
export type RunRequestStatus = (typeof RUN_REQUEST_STATUSES)[number];

/** POST /projects/<id>/run-requests; without runnerId, the user's most recently seen runner. */
export const runRequestBodySchema = z
  .object({ runnerId: z.uuid().optional() })
  .strict();

export const runRequestResponseSchema = z.object({
  request: z.object({
    id: z.string(),
    projectId: z.string(),
    /** null: any runner of the user may take it. */
    runnerId: z.string().nullable(),
    status: z.enum(RUN_REQUEST_STATUSES),
    createdAt: z.string(),
  }),
});
export type RunRequestResponse = z.infer<typeof runRequestResponseSchema>;

/** GET /run-requests (runner token): pending requests for this runner or any runner of its user. */
export const runRequestsResponseSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      repoId: z.string(),
      /** owner/name */
      repo: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type RunRequestsResponse = z.infer<typeof runRequestsResponseSchema>;
export type PendingRunRequest = RunRequestsResponse["requests"][number];

/** POST /run-requests/<id>/claim; idempotent for the runner that claimed it. */
export const claimRunRequestResponseSchema = z.object({ ok: z.literal(true) });
