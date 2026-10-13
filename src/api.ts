import { z } from "zod";
import {
  type ClaimRequest,
  claimRequestSchema,
  claimResponseSchema,
  heartbeatResponseSchema,
  pairPollResponseSchema,
  pairStartResponseSchema,
  policyResponseSchema,
  type ReportRequest,
  reportRequestSchema,
} from "./contract/autopilot";

export type ApiErrorCode =
  | "unauthorized"
  | "disabled"
  | "http"
  | "network"
  | "timeout"
  | "invalid_response"
  | "forbidden"
  | "conflict"
  | "invalid_request";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  server: string;
  token?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  userAgent?: string;
};

const publicKeyResponseSchema = z.object({ publicKey: z.string().min(40) });

export function normalizeServer(server: string): string {
  const url = new URL(server);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("The server must use https (http only for localhost).");
  return url.origin;
}

/**
 * REST client for the Autopilot API. Every response is parsed with the shared
 * contract, and every report is validated as metadata-only before sending.
 */
export class ApiClient {
  readonly server: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;

  constructor(options: ApiClientOptions) {
    this.server = normalizeServer(options.server);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent ?? "paradigma-cli";
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    auth = true,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!this.token)
        throw new ApiError(
          "unauthorized",
          "Not paired. Run `paradigma setup`.",
        );
      headers.authorization = `Bearer ${this.token}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.server}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError")
        throw new ApiError("timeout", `${path} timed out`);
      throw new ApiError(
        "network",
        `Cannot reach ${this.server}: ${(error as Error)?.message ?? error}`,
      );
    }
    if (response.status === 401)
      throw new ApiError(
        "unauthorized",
        "The runner token was rejected. Run `paradigma setup` again.",
        401,
      );
    if (response.status === 403)
      throw new ApiError(
        "forbidden",
        "The server refused access (403): repository access may have been removed.",
        403,
      );
    if (response.status === 404)
      throw new ApiError(
        "disabled",
        path.startsWith("/api/autopilot/report") ||
          path.startsWith("/api/autopilot/heartbeat")
          ? "The server does not know this task (404)."
          : "Autopilot is not enabled on this server (404).",
        404,
      );
    if (response.status === 409)
      throw new ApiError(
        "conflict",
        "The task lease expired or the transition is invalid (409).",
        409,
      );
    if (response.status === 422)
      throw new ApiError(
        "invalid_request",
        "The server rejected the request as invalid (422).",
        422,
      );
    if (!response.ok) {
      let detail = "";
      try {
        const data = (await response.json()) as { error?: unknown };
        if (typeof data?.error === "string") detail = `: ${data.error}`;
      } catch {}
      throw new ApiError(
        "http",
        `${method} ${path} failed with ${response.status}${detail.slice(0, 200)}`,
        response.status,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("invalid_response", `${path} did not return JSON`);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new ApiError(
        "invalid_response",
        `${path} returned an unexpected shape`,
      );
    return parsed.data;
  }

  pairStart(machineName: string, platform: string) {
    return this.request(
      "POST",
      "/api/autopilot/pair",
      pairStartResponseSchema,
      {
        machineName: machineName.slice(0, 100),
        platform: platform.slice(0, 40),
      },
      false,
    );
  }

  pairPoll(deviceCode: string) {
    return this.request(
      "POST",
      "/api/autopilot/pair/poll",
      pairPollResponseSchema,
      { deviceCode },
      false,
    );
  }

  publicKey() {
    return this.request(
      "GET",
      "/api/autopilot/public-key",
      publicKeyResponseSchema,
      undefined,
      false,
    );
  }

  policy() {
    return this.request("GET", "/api/autopilot/policy", policyResponseSchema);
  }

  claim(request: Partial<ClaimRequest>) {
    return this.request(
      "POST",
      "/api/autopilot/claim",
      claimResponseSchema,
      claimRequestSchema.parse(request),
    );
  }

  heartbeat(taskIds: string[]) {
    return this.request(
      "POST",
      "/api/autopilot/heartbeat",
      heartbeatResponseSchema,
      { taskIds },
    );
  }

  /** Throws before sending if the report is not metadata-only. */
  async report(request: ReportRequest) {
    const body = reportRequestSchema.parse(request);
    return this.request("POST", "/api/autopilot/report", z.unknown(), body);
  }
}
