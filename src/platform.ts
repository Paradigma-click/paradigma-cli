import { z } from "zod";
import { normalizeServer } from "./api";
import {
  CLI_API_PREFIX,
  type CliVerificationMethod,
  type CreateProjectRequest,
  type CredentialRequest,
  cliErrorBodySchema,
  cliProjectsResponseSchema,
  cliStatusResponseSchema,
  cliTargetsResponseSchema,
  type SyncSource,
  type UpdateProjectRequest,
  verificationInstructionsSchema,
} from "./contract/cli-api";
import {
  type SetupExchangeRequest,
  setupExchangeResponseSchema,
} from "./contract/setup";
import type { FetchLike } from "./io";

/** Server error with its stable code (`invalid_token`, `not_found`, …). */
export class PlatformError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const loose = z.looseObject({});
export type Loose = z.infer<typeof loose>;

const operationResult = z.looseObject({
  projectId: z.string().optional(),
  operation: z
    .looseObject({ id: z.string().optional(), status: z.string().optional() })
    .nullish(),
});

const verifyResult = z.looseObject({
  projectId: z.string(),
  verified: z.boolean(),
  method: z.string().nullable().optional(),
  attempts: z
    .array(
      z.object({
        method: z.string(),
        ok: z.boolean(),
        reason: z.string().optional(),
      }),
    )
    .default([]),
  instructions: verificationInstructionsSchema.nullable().optional(),
});
export type VerifyResult = z.infer<typeof verifyResult>;

const projectWriteResult = z.looseObject({
  projectId: z.string(),
  verified: z.boolean(),
  verification: verificationInstructionsSchema.nullable().optional(),
});

const verificationResult = z.looseObject({
  projectId: z.string(),
  productionUrl: z.string(),
  verified: z.boolean(),
  instructions: verificationInstructionsSchema,
});

const destination = z.looseObject({ state: z.string(), url: z.string() });

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "The server rejected the request as invalid.",
  401: "The CLI credential was rejected. Run `npx paradigma-cli init` again.",
  403: "Permission denied.",
  404: "Not found.",
  409: "The request conflicts with the current state.",
  413: "The request is too large.",
  428: "Explicit confirmation is required.",
  503: "The service is temporarily unavailable. Retry shortly.",
};

/**
 * REST client for `/api/cli/v1/*`. Sends the CLI credential as a bearer
 * token, never follows redirects and never puts secrets in URLs.
 */
export class PlatformClient {
  readonly server: string;
  private readonly token?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: {
    server: string;
    token?: string;
    fetch?: FetchLike;
    timeoutMs?: number;
    userAgent?: string;
  }) {
    this.server = normalizeServer(options.server);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.userAgent = options.userAgent ?? "paradigma-cli";
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    schema: z.ZodType<T>,
    options: { body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const auth = options.auth ?? true;
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
    };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (auth) {
      if (!this.token)
        throw new PlatformError(
          "invalid_token",
          "Not signed in. Run `npx paradigma-cli init` first.",
        );
      headers.authorization = `Bearer ${this.token}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.server}${path}`, {
        method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError")
        throw new PlatformError("timeout", `${method} ${path} timed out.`);
      throw new PlatformError(
        "network",
        `Cannot reach ${this.server}: ${(error as Error)?.message ?? error}`,
      );
    }
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      if (response.ok)
        throw new PlatformError(
          "invalid_response",
          `${path} did not return JSON.`,
        );
    }
    if (!response.ok) {
      const parsed = cliErrorBodySchema.safeParse(data);
      const code = parsed.success ? parsed.data.error : "http";
      const issues = parsed.success
        ? (parsed.data.issues ?? []).map((issue) => issue.path || issue.code)
        : [];
      const message =
        (response.status === 401 ? DEFAULT_MESSAGES[401] : undefined) ??
        (parsed.success ? parsed.data.message : undefined) ??
        `${DEFAULT_MESSAGES[response.status] ?? `${method} ${path} failed with ${response.status}.`}${issues.length ? ` Check: ${[...new Set(issues)].join(", ")}.` : ""}`;
      throw new PlatformError(code, message.slice(0, 500), response.status);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new PlatformError(
        "invalid_response",
        `${path} returned an unexpected shape. Update the CLI (npx paradigma-cli@latest).`,
      );
    return parsed.data;
  }

  private path(...parts: string[]) {
    return `${CLI_API_PREFIX}/${parts.map(encodeURIComponent).join("/")}`;
  }

  exchangeSetupToken(input: SetupExchangeRequest) {
    return this.request(
      "POST",
      `${CLI_API_PREFIX}/setup/exchange`,
      setupExchangeResponseSchema,
      { body: input, auth: false },
    );
  }

  status() {
    return this.request("GET", this.path("status"), cliStatusResponseSchema);
  }

  links() {
    return this.request("GET", this.path("links"), loose);
  }

  projects() {
    return this.request(
      "GET",
      this.path("projects"),
      cliProjectsResponseSchema,
    );
  }

  targets() {
    return this.request("GET", this.path("targets"), cliTargetsResponseSchema);
  }

  createProject(input: CreateProjectRequest) {
    return this.request("POST", this.path("projects"), projectWriteResult, {
      body: input,
    });
  }

  updateProject(projectId: string, input: UpdateProjectRequest) {
    return this.request(
      "PATCH",
      this.path("projects", projectId),
      projectWriteResult,
      { body: input },
    );
  }

  verification(projectId: string) {
    return this.request(
      "GET",
      this.path("projects", projectId, "verification"),
      verificationResult,
    );
  }

  verify(
    projectId: string,
    input: { methods?: CliVerificationMethod[]; idempotencyKey?: string },
  ) {
    return this.request(
      "POST",
      this.path("projects", projectId, "verify"),
      verifyResult,
      { body: input },
    );
  }

  audit(projectId: string, idempotencyKey: string) {
    return this.request(
      "POST",
      this.path("projects", projectId, "audit"),
      operationResult,
      { body: { idempotencyKey } },
    );
  }

  sync(projectId: string, source: SyncSource, idempotencyKey: string) {
    return this.request(
      "POST",
      this.path("projects", projectId, "sync"),
      operationResult,
      { body: { source, idempotencyKey } },
    );
  }

  /** The body carries the secret; the response never does. */
  connect(projectId: string, input: CredentialRequest) {
    return this.request(
      "POST",
      this.path("projects", projectId, "credentials"),
      loose,
      { body: input },
    );
  }

  prompts(projectId: string, state: "all" | "active" | "inactive", page = 1) {
    return this.request(
      "GET",
      `${this.path("projects", projectId, "prompts")}?state=${state}&page=${page}`,
      z.looseObject({
        prompts: z
          .array(
            z.looseObject({
              id: z.string(),
              text: z.string(),
              source: z.string().optional(),
              active: z.boolean().optional(),
            }),
          )
          .default([]),
        nextPage: z.number().nullable().optional(),
      }),
    );
  }

  addPrompt(projectId: string, text: string, idempotencyKey: string) {
    return this.request(
      "POST",
      this.path("projects", projectId, "prompts"),
      operationResult,
      { body: { text, idempotencyKey } },
    );
  }

  geoSchedule(
    projectId: string,
    input: {
      engine: string;
      dailyLimit: number;
      enabled: boolean;
      acceptCharges: boolean;
      idempotencyKey: string;
    },
  ) {
    return this.request(
      "POST",
      this.path("projects", projectId, "geo", "schedule"),
      operationResult,
      { body: input },
    );
  }

  geoSample(
    projectId: string,
    input: {
      promptId: string;
      engine: string;
      acceptCharges: boolean;
      idempotencyKey: string;
    },
  ) {
    return this.request(
      "POST",
      this.path("projects", projectId, "geo", "sample"),
      operationResult,
      { body: input },
    );
  }

  alertBudget(orgId: string, weekly: number) {
    return this.request(
      "POST",
      this.path("orgs", orgId, "alerts", "budget"),
      loose,
      { body: { weekly } },
    );
  }

  checkout(orgId: string, plan: "pro" | "agency") {
    return this.request(
      "POST",
      this.path("orgs", orgId, "billing", "checkout"),
      destination,
      { body: { plan } },
    );
  }

  portal(orgId: string) {
    return this.request(
      "POST",
      this.path("orgs", orgId, "billing", "portal"),
      destination,
      { body: {} },
    );
  }

  autopilotPolicy(repoId: string, policy: Record<string, unknown>) {
    return this.request(
      "POST",
      this.path("repos", repoId, "autopilot", "policy"),
      loose,
      { body: policy },
    );
  }

  autopilotPause(repoId: string, reason?: string) {
    return this.request(
      "POST",
      this.path("repos", repoId, "autopilot", "pause"),
      loose,
      { body: reason ? { reason } : {} },
    );
  }

  autopilotResume(repoId: string) {
    return this.request(
      "POST",
      this.path("repos", repoId, "autopilot", "resume"),
      loose,
      { body: {} },
    );
  }
}
