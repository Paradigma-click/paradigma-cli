import { z } from "zod";
import { GEO_SAMPLE_ENGINES } from "./geo-engines";

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

export const promptsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  state: z.enum(["all", "active", "inactive"]).default("all"),
});

export const savePromptRequestSchema = z
  .object({
    text: z.string().min(5).max(500),
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
          router: z.string().nullable(),
          projectId: z.string().nullable(),
          productionUrl: z.string().nullable(),
          verified: z.boolean().nullable(),
        }),
      ),
    }),
  ),
  installGithubAppUrl: link,
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
