import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformCommand } from "./commands";
import { saveConfig } from "./config";
import { detectAiEnvKeys, missingOpenRouterEngines } from "./connect-ai";
import { ActionRequired } from "./io";
import { type Call, fakeIo, fakeServer } from "./test/platform";

const SERVER = "https://app.paradigma.test";
const TOKEN = `pdg_rt_${"c".repeat(43)}`;
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "55555555-5555-4555-8555-555555555555";
const ORG = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const REQUEST = "66666666-6666-4666-8666-666666666666";
const AUTH_URL =
  "https://openrouter.ai/auth?callback_url=https%3A%2F%2Fapp.paradigma.test%2Fdashboard%2Fconnect%2Fopenrouter%2Fcallback&code_challenge=abc&code_challenge_method=S256&state=xyz&key_label=Paradigma";

/** Distinctive fake key material; none of it may ever be printed. */
const KEYS = {
  OPENAI_API_KEY: "sk-proj-OPENAIsecretVALUE0123456789abcdef",
  ANTHROPIC_API_KEY: "sk-ant-ANTHROPICsecretVALUE0123456789",
  GOOGLE_API_KEY: "AIzaGOOGLEsecretVALUE0123456789abcd",
  PERPLEXITY_API_KEY: "pplx-PERPLEXITYsecretVALUE0123456789",
};
const SECRET_FRAGMENTS = [
  "secretVALUE",
  ...Object.values(KEYS),
  ...Object.values(KEYS).map((key) => key.slice(-8)),
];

const project = (id: string, name: string) => ({
  id,
  orgId: ORG,
  repoId: REPO,
  repoFullName: "acme/web",
  appRoot: "",
  name,
  productionUrl: "https://acme.test",
  verified: true,
});

type Transport = "direct" | "openrouter" | null;
const engines = (route: Transport, openRouter = false) => ({
  openRouter: openRouter ? { connectedAt: "2026-10-15T10:00:00.000Z" } : null,
  engines: [
    ...["gemini", "openai", "claude", "perplexity"].map((engine) => ({
      engine,
      transport: route,
      automaticSampling: route !== null,
    })),
    { engine: "google_ai_overview", transport: null, automaticSampling: false },
    { engine: "google_ai_mode", transport: null, automaticSampling: false },
  ],
});

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "paradigma-ai-"));
  vi.stubEnv("PARADIGMA_HOME", join(root, "home"));
  await saveConfig({
    server: SERVER,
    token: TOKEN,
    runnerId: "r",
    publicKey: "k".repeat(43),
    repos: {},
    repoNames: {},
    checks: {},
    paused: false,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

function expectNoKeyMaterial(text: string) {
  for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment);
}

describe("detectAiEnvKeys", () => {
  it("finds providers by variable name only, in preference order", () => {
    expect(
      detectAiEnvKeys({
        OPENAI_API_KEY: "x",
        GOOGLE_API_KEY: "g",
        GOOGLE_GENERATIVE_AI_API_KEY: "  ",
        GEMINI_API_KEY: "",
        PERPLEXITY_API_KEY: "p",
      }),
    ).toEqual([
      { provider: "openai", engine: "openai", variable: "OPENAI_API_KEY" },
      { provider: "gemini", engine: "gemini", variable: "GOOGLE_API_KEY" },
      {
        provider: "perplexity",
        engine: "perplexity",
        variable: "PERPLEXITY_API_KEY",
      },
    ]);
    expect(
      detectAiEnvKeys({ GEMINI_API_KEY: "a", GOOGLE_API_KEY: "b" })[0]
        ?.variable,
    ).toBe("GEMINI_API_KEY");
    expect(detectAiEnvKeys({})).toEqual([]);
  });

  it("lists the engines OpenRouter would still cover", () => {
    const state = engines(null).engines.map((row) =>
      row.engine === "openai" ? { ...row, transport: "direct" as const } : row,
    );
    expect(missingOpenRouterEngines(state)).toEqual([
      "gemini",
      "claude",
      "perplexity",
    ]);
    expect(missingOpenRouterEngines(engines("openrouter").engines)).toEqual([]);
  });
});

describe("paradigma connect ai", () => {
  it("uploads environment keys with --yes, prints only names and skips OpenRouter", async () => {
    let connected = false;
    const server = fakeServer({
      "GET /api/cli/v1/projects": () => ({
        body: { projects: [project(PROJECT, "Acme")] },
      }),
      [`POST /api/cli/v1/projects/${PROJECT}/credentials`]: (call) => {
        connected = true;
        return {
          body: {
            projectId: PROJECT,
            provider: (call.body as { provider: string }).provider,
            connected: true,
          },
        };
      },
      [`GET /api/cli/v1/projects/${PROJECT}/ai`]: () => ({
        body: { projectId: PROJECT, ...engines(connected ? "direct" : null) },
      }),
    });
    const t = fakeIo({
      cwd: root,
      env: { ...KEYS, PARADIGMA_HOME: join(root, "home") },
      fetch: server.fetch,
    });
    await platformCommand("connect", ["ai", "--yes"], t.io);
    const credentials = server.calls.filter((call) =>
      call.path.endsWith("/credentials"),
    );
    expect(
      credentials.map((call) => (call.body as { provider: string }).provider),
    ).toEqual(["openai", "anthropic", "gemini", "perplexity"]);
    // Each value goes once, in the body of its own credentials request.
    expect(
      credentials.map((call) => (call.body as { apiKey: string }).apiKey),
    ).toEqual([
      KEYS.OPENAI_API_KEY,
      KEYS.ANTHROPIC_API_KEY,
      KEYS.GOOGLE_API_KEY,
      KEYS.PERPLEXITY_API_KEY,
    ]);
    expect(
      server.calls.some((call) => call.path.includes("/ai/openrouter")),
    ).toBe(false);
    const output = t.stdout() + t.stderr();
    expect(output).toContain(
      "Found in your environment: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, PERPLEXITY_API_KEY",
    );
    expect(output).toContain(
      "Acme (11111111-1111-4111-8111-111111111111): Gemini (own key), OpenAI (own key)",
    );
    expectNoKeyMaterial(output);
    expectNoKeyMaterial(
      server.calls
        .filter((c) => !c.path.endsWith("/credentials"))
        .map((c) => c.rawBody + c.path)
        .join("\n"),
    );
  });

  it("never uploads without consent and never prints values in JSON either", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": () => ({
        body: { projects: [project(PROJECT, "Acme")] },
      }),
      [`GET /api/cli/v1/projects/${PROJECT}/ai`]: () => ({
        body: { projectId: PROJECT, ...engines("openrouter", true) },
      }),
    });
    const t = fakeIo({
      cwd: root,
      env: { ...KEYS, PARADIGMA_HOME: join(root, "home") },
      fetch: server.fetch,
    });
    await platformCommand("connect", ["ai", "--json"], t.io);
    expect(
      server.calls.some((call) => call.path.endsWith("/credentials")),
    ).toBe(false);
    const events = t.events();
    expect(events[0]).toEqual({
      event: "env_keys",
      variables: [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_API_KEY",
        "PERPLEXITY_API_KEY",
      ],
    });
    expect(events.at(-1)).toMatchObject({
      uploaded: 0,
      openRouter: "not_needed",
      projects: [{ projectId: PROJECT, openRouter: true }],
    });
    expectNoKeyMaterial(t.stdout() + t.stderr());
  });

  it("opens one OpenRouter consent for the workspace and waits until connected", async () => {
    let polls = 0;
    const server = fakeServer({
      "GET /api/cli/v1/projects": () => ({
        body: {
          projects: [project(PROJECT, "Acme"), project(OTHER, "Acme Docs")],
        },
      }),
      [`GET /api/cli/v1/projects/${PROJECT}/ai`]: () => ({
        body: {
          projectId: PROJECT,
          ...(polls >= 2 ? engines("openrouter", true) : engines(null)),
        },
      }),
      [`GET /api/cli/v1/projects/${OTHER}/ai`]: () => ({
        body: {
          projectId: OTHER,
          ...(polls >= 2 ? engines("openrouter", true) : engines(null)),
        },
      }),
      "POST /api/cli/v1/ai/openrouter": () => ({
        body: {
          requestId: REQUEST,
          authorizationUrl: AUTH_URL,
          expiresAt: "2026-10-15T10:10:00.000Z",
          projectIds: [PROJECT, OTHER],
        },
      }),
      [`GET /api/cli/v1/ai/openrouter/${REQUEST}`]: () => {
        polls++;
        return {
          body: {
            requestId: REQUEST,
            status: polls >= 2 ? "connected" : "pending",
            expiresAt: "2026-10-15T10:10:00.000Z",
            projectIds: [PROJECT, OTHER],
            connectedProjectIds: polls >= 2 ? [PROJECT, OTHER] : [],
          },
        };
      },
    });
    const t = fakeIo({
      cwd: root,
      interactive: true,
      env: { PARADIGMA_HOME: join(root, "home") },
      fetch: server.fetch,
    });
    await platformCommand("connect", ["ai", "--project", PROJECT], t.io);
    const start = server.calls.find(
      (call: Call) =>
        call.method === "POST" && call.path.endsWith("/ai/openrouter"),
    );
    expect(start?.body).toEqual({ projectId: PROJECT, scope: "project" });
    expect(t.opened).toEqual([AUTH_URL]);
    expect(polls).toBe(2);
    const output = t.stdout();
    expect(output).toContain(AUTH_URL);
    expect(output).toContain("✓ OpenRouter connected");
    expect(output).toContain(
      "Gemini (OpenRouter), OpenAI (OpenRouter), Claude (OpenRouter), Perplexity (OpenRouter), Google AI Overviews (not connected)",
    );
  });

  it("defaults to the workspace and exits with action required when the link expires", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": () => ({
        body: { projects: [project(PROJECT, "Acme")] },
      }),
      [`GET /api/cli/v1/projects/${PROJECT}/ai`]: () => ({
        body: { projectId: PROJECT, ...engines(null) },
      }),
      "POST /api/cli/v1/ai/openrouter": () => ({
        body: {
          requestId: REQUEST,
          authorizationUrl: AUTH_URL,
          expiresAt: "2026-10-15T10:10:00.000Z",
          projectIds: [PROJECT],
        },
      }),
      [`GET /api/cli/v1/ai/openrouter/${REQUEST}`]: () => ({
        body: {
          requestId: REQUEST,
          status: "expired",
          expiresAt: "2026-10-15T10:10:00.000Z",
          projectIds: [PROJECT],
          connectedProjectIds: [],
        },
      }),
    });
    const t = fakeIo({
      cwd: root,
      env: { PARADIGMA_HOME: join(root, "home") },
      fetch: server.fetch,
    });
    await expect(
      platformCommand("connect", ["ai"], t.io),
    ).rejects.toBeInstanceOf(ActionRequired);
    expect(
      server.calls.find((call) => call.path.endsWith("/ai/openrouter"))?.body,
    ).toEqual({ projectId: PROJECT, scope: "workspace" });
    // Non-interactive: the URL is printed for the person, not opened.
    expect(t.opened).toEqual([]);
    expect(t.stderr()).toContain("The OpenRouter link expired.");
  });

  it("gives up after 10 minutes of polling", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": () => ({
        body: { projects: [project(PROJECT, "Acme")] },
      }),
      [`GET /api/cli/v1/projects/${PROJECT}/ai`]: () => ({
        body: { projectId: PROJECT, ...engines(null) },
      }),
      "POST /api/cli/v1/ai/openrouter": () => ({
        body: {
          requestId: REQUEST,
          authorizationUrl: AUTH_URL,
          expiresAt: "2026-10-15T10:10:00.000Z",
          projectIds: [PROJECT],
        },
      }),
      [`GET /api/cli/v1/ai/openrouter/${REQUEST}`]: () => ({
        body: {
          requestId: REQUEST,
          status: "pending",
          expiresAt: "2026-10-15T10:10:00.000Z",
          projectIds: [PROJECT],
          connectedProjectIds: [],
        },
      }),
    });
    const t = fakeIo({
      cwd: root,
      env: { PARADIGMA_HOME: join(root, "home") },
      fetch: server.fetch,
    });
    await expect(
      platformCommand("connect", ["ai", "--all"], t.io),
    ).rejects.toBeInstanceOf(ActionRequired);
    const polls = server.calls.filter((call) =>
      call.path.includes(`/ai/openrouter/${REQUEST}`),
    );
    expect(polls).toHaveLength(120);
    expect(
      server.calls.find((call) => call.path.endsWith("/ai/openrouter"))?.body,
    ).toEqual({ projectId: PROJECT, scope: "all" });
  });

  const included = (activePrompts: number) => ({
    plan: "pro",
    promptsPerDay: 3,
    engines: ["gemini", "openai", "claude", "perplexity"],
    activePrompts,
    paused: null,
  });

  it("says AI visibility is included and connects nothing", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": () => ({
        body: {
          projects: [project(PROJECT, "Acme"), project(OTHER, "Docs")],
        },
      }),
      [`GET /api/cli/v1/projects/${PROJECT}/ai`]: () => ({
        body: { projectId: PROJECT, ...engines(null), included: included(3) },
      }),
      [`GET /api/cli/v1/projects/${OTHER}/ai`]: () => ({
        body: { projectId: OTHER, ...engines(null), included: included(0) },
      }),
    });
    const t = fakeIo({
      cwd: root,
      env: { ...KEYS, PARADIGMA_HOME: join(root, "home") },
      fetch: server.fetch,
    });
    await platformCommand("connect", ["ai", "--yes", "--all"], t.io);
    expect(
      server.calls.some(
        (call) =>
          call.path.endsWith("/credentials") ||
          call.path.includes("openrouter"),
      ),
    ).toBe(false);
    const output = t.stdout();
    expect(output).toContain(
      "Included in your Pro plan. No key or account needed.",
    );
    expect(output).toContain(
      "Acme (11111111-1111-4111-8111-111111111111): Gemini, OpenAI, Claude, Perplexity · 3 prompts a day",
    );
    expect(output).toContain("add prompts to start");
    expect(output).toContain("paradigma connect ai --own");
    expectNoKeyMaterial(output + t.stderr());
  });

  it("uses your own keys with --own even when included", async () => {
    let connected = false;
    const server = fakeServer({
      "GET /api/cli/v1/projects": () => ({
        body: { projects: [project(PROJECT, "Acme")] },
      }),
      [`POST /api/cli/v1/projects/${PROJECT}/credentials`]: (call) => {
        connected = true;
        return {
          body: {
            projectId: PROJECT,
            provider: (call.body as { provider: string }).provider,
            connected: true,
          },
        };
      },
      [`GET /api/cli/v1/projects/${PROJECT}/ai`]: () => ({
        body: {
          projectId: PROJECT,
          ...engines(connected ? "direct" : null),
          included: included(3),
        },
      }),
    });
    const t = fakeIo({
      cwd: root,
      env: { ...KEYS, PARADIGMA_HOME: join(root, "home") },
      fetch: server.fetch,
    });
    await platformCommand("connect", ["ai", "--yes", "--own"], t.io);
    expect(
      server.calls.filter((call) => call.path.endsWith("/credentials")),
    ).toHaveLength(4);
    expect(t.stdout()).not.toContain("Included in your");
  });
});
