import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, normalizeServer } from "./api";
import { REPO_ID, RUNNER_ID } from "./test/fixtures";

const TOKEN = `pdg_rt_${"a".repeat(43)}`;
const TASK_ID = "33333333-3333-4333-8333-333333333333";

function mockFetch(status: number, body: unknown) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("ApiClient", () => {
  it("sends the bearer token and parses the policy", async () => {
    const fetch = mockFetch(200, {
      runnerId: RUNNER_ID,
      repos: [
        {
          repoId: REPO_ID,
          fullName: "acme/site",
          defaultBranch: "main",
          enabled: true,
          level: 2,
          paused: false,
          runHour: 9,
          timezone: "UTC",
        },
      ],
    });
    const api = new ApiClient({
      server: "https://example.com/",
      token: TOKEN,
      fetch,
    });
    const policy = await api.policy();
    expect(policy.repos[0].fullName).toBe("acme/site");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://example.com/api/autopilot/policy");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("does not send the token to pairing endpoints", async () => {
    const fetch = mockFetch(200, { status: "pending" });
    const api = new ApiClient({
      server: "https://example.com",
      token: TOKEN,
      fetch,
    });
    expect(await api.pairPoll("d".repeat(43))).toEqual({ status: "pending" });
    expect(
      (fetch.mock.calls[0][1]?.headers as Record<string, string>).authorization,
    ).toBeUndefined();
  });

  it("maps 401 to re-run setup and 404 to disabled", async () => {
    const unauthorized = new ApiClient({
      server: "https://example.com",
      token: TOKEN,
      fetch: mockFetch(401, {}),
    });
    await expect(unauthorized.policy()).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(unauthorized.policy()).rejects.toThrow(/paradigma setup/);
    const disabled = new ApiClient({
      server: "https://example.com",
      token: TOKEN,
      fetch: mockFetch(404, {}),
    });
    await expect(disabled.claim({})).rejects.toMatchObject({
      code: "disabled",
    });
  });

  it("maps 403, 409 and 422 to distinct codes", async () => {
    for (const [status, code] of [
      [403, "forbidden"],
      [409, "conflict"],
      [422, "invalid_request"],
    ] as const) {
      const api = new ApiClient({
        server: "https://example.com",
        token: TOKEN,
        fetch: mockFetch(status, {}),
      });
      await expect(api.heartbeat([TASK_ID])).rejects.toMatchObject({
        code,
        status,
      });
    }
  });

  it("rejects responses that do not match the contract", async () => {
    const api = new ApiClient({
      server: "https://example.com",
      token: TOKEN,
      fetch: mockFetch(200, { tasks: "nope" }),
    });
    const error = await api.claim({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_response");
  });

  it("validates reports as metadata-only before sending", async () => {
    const fetch = mockFetch(200, { ok: true });
    const api = new ApiClient({
      server: "https://example.com",
      token: TOKEN,
      fetch,
    });
    await api.report({
      taskId: TASK_ID,
      status: "skipped",
      result: { code: "no_changes" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      api.report({
        taskId: TASK_ID,
        status: "notified",
        // @ts-expect-error extra keys such as a diff are rejected
        result: { diff: "+secret" },
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports network failures and timeouts clearly", async () => {
    const failing = new ApiClient({
      server: "https://example.com",
      token: TOKEN,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(failing.policy()).rejects.toMatchObject({ code: "network" });
    const slow = new ApiClient({
      server: "https://example.com",
      token: TOKEN,
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    });
    await expect(slow.policy()).rejects.toMatchObject({ code: "timeout" });
  });

  it("requires https except on localhost", () => {
    expect(normalizeServer("https://example.com/x")).toBe(
      "https://example.com",
    );
    expect(normalizeServer("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(() => normalizeServer("http://example.com")).toThrow(/https/);
  });
});
