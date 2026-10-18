import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformCommand } from "./commands";
import { saveConfig } from "./config";
import {
  brandFromPackageName,
  chooseAppRoot,
  frameworkConfigUrl,
  inferSiteCandidates,
  layoutMetadata,
  productionOrigin,
} from "./detect";
import { hostAgent, installCursor, mcpAddCommand } from "./mcp-install";
import { PlatformClient, PlatformError } from "./platform";
import { fakeIo, fakeServer } from "./test/platform";

const SERVER = "https://app.paradigma.test";
const TOKEN = `pdg_rt_${"c".repeat(43)}`;
const SECRET = "sk-live-SECRET-0123456789abcdef";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const PROMPT = "44444444-4444-4444-8444-444444444444";

const project = {
  id: PROJECT,
  orgId: ORG,
  repoId: REPO,
  repoFullName: "acme/web",
  appRoot: "",
  name: "Acme",
  productionUrl: "https://acme.test",
  verified: true,
};
const projectsRoute = () => ({ body: { projects: [project] } });

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "paradigma-cmd-"));
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

/** A cwd outside any git repository, so project resolution uses the list. */
const cwd = () => root;

describe("PlatformClient", () => {
  it("sends the bearer token and maps error codes and messages", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": () => ({
        status: 403,
        body: {
          error: "billing_owner_required",
          message: "Only the owner can.",
        },
      }),
      "POST /api/cli/v1/projects": () => ({
        status: 400,
        body: {
          error: "invalid_request",
          issues: [{ path: "config.brandName", code: "too_small" }],
        },
      }),
      "GET /api/cli/v1/status": () => ({
        status: 401,
        body: { error: "invalid_token" },
      }),
    });
    const client = new PlatformClient({
      server: SERVER,
      token: TOKEN,
      fetch: server.fetch,
    });
    await expect(client.projects()).rejects.toMatchObject({
      code: "billing_owner_required",
      message: "Only the owner can.",
      status: 403,
    });
    expect(server.calls[0].authorization).toBe(`Bearer ${TOKEN}`);
    const invalid = await client
      .createProject({
        repoId: REPO,
        appRoot: "",
        config: {
          productionUrl: "https://a.test",
          brandName: "",
          category: "c",
          useCase: "u",
        },
      })
      .catch((error: PlatformError) => error);
    expect((invalid as PlatformError).message).toContain("config.brandName");
    await expect(client.status()).rejects.toMatchObject({
      code: "invalid_token",
      message: expect.stringContaining("paradigma-cli init"),
    });
  });

  it("never sends the setup exchange with a bearer token", async () => {
    const server = fakeServer({
      "POST /api/cli/v1/setup/exchange": () => ({
        status: 401,
        body: { error: "invalid_token" },
      }),
    });
    const client = new PlatformClient({
      server: SERVER,
      token: TOKEN,
      fetch: server.fetch,
    });
    await expect(
      client.exchangeSetupToken({
        token: "pdg_setup_x",
        runnerName: "cli",
        agents: [],
      }),
    ).rejects.toBeInstanceOf(PlatformError);
    expect(server.calls[0].authorization).toBeNull();
  });
});

describe("connect", () => {
  it("reads the key from stdin, sends it only in the body and never prints it", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      "POST /api/cli/v1/projects/11111111-1111-4111-8111-111111111111/credentials":
        () => ({
          body: { projectId: PROJECT, provider: "gemini", connected: true },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd(), stdin: `${SECRET}\n` });
    await platformCommand("connect", ["gemini"], t.io);
    const credentialCall = server.calls.find((c) =>
      c.path.endsWith("/credentials"),
    );
    expect(credentialCall?.body).toEqual({
      provider: "gemini",
      apiKey: SECRET,
    });
    expect(server.calls.every((c) => !c.path.includes(SECRET))).toBe(true);
    expect(t.stdout()).toContain("Connected gemini");
    expect(t.stdout() + t.stderr()).not.toContain(SECRET);
  });

  it("supports --key-env and the DataForSEO login/locale flags", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      "POST /api/cli/v1/projects/11111111-1111-4111-8111-111111111111/credentials":
        () => ({
          body: { projectId: PROJECT, provider: "dataforseo", connected: true },
        }),
    });
    const t = fakeIo({
      fetch: server.fetch,
      cwd: cwd(),
      env: { ...process.env, DFS_PASSWORD: SECRET },
    });
    await platformCommand(
      "connect",
      [
        "dataforseo",
        "--login",
        "me@acme.test",
        "--key-env",
        "DFS_PASSWORD",
        "--location",
        "2076",
        "--language",
        "pt",
        "--json",
      ],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toEqual({
      provider: "dataforseo",
      login: "me@acme.test",
      password: SECRET,
      locationCode: 2076,
      languageCode: "pt",
    });
    expect(t.stdout()).not.toContain(SECRET);
  });

  it("refuses secrets in argv without echoing them or calling the server", async () => {
    const server = fakeServer({});
    for (const args of [
      ["bing", `--api-key=${SECRET}`],
      ["openai", "--key", SECRET],
      ["dataforseo", "--login", "x", `--password=${SECRET}`],
    ]) {
      const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
      const error = await platformCommand(
        "connect",
        [...args, "--json"],
        t.io,
      ).catch((e: Error) => e);
      expect((error as Error).message).toContain("never accepted as arguments");
      expect((error as Error).message + t.stdout()).not.toContain(SECRET);
    }
    expect(server.calls).toHaveLength(0);
  });
});

describe("GEO, billing and Autopilot guards", () => {
  it("geo sample needs --accept-charges before any request", async () => {
    const server = fakeServer({});
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await expect(
      platformCommand(
        "geo",
        ["sample", "--engine", "gemini", "--prompt", PROMPT],
        t.io,
      ),
    ).rejects.toThrow(/--accept-charges/);
    expect(server.calls).toHaveLength(0);
  });

  it("geo sample sends explicit consent and prints the operation", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      "POST /api/cli/v1/projects/11111111-1111-4111-8111-111111111111/geo/sample":
        () => ({
          body: {
            projectId: PROJECT,
            operation: {
              id: "op-9",
              status: "queued",
              dashboardPath: "/dashboard/x",
            },
          },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand(
      "geo",
      ["sample", "--engine", "gemini", "--prompt", PROMPT, "--accept-charges"],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toMatchObject({
      promptId: PROMPT,
      engine: "gemini",
      acceptCharges: true,
      idempotencyKey: expect.stringMatching(/^cli_/),
    });
    expect(t.stdout()).toContain("queued (operation op-9)");
    expect(t.stdout()).toContain(`${SERVER}/dashboard/x`);
  });

  it("geo schedule requires consent unless turning it off", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      "POST /api/cli/v1/projects/11111111-1111-4111-8111-111111111111/geo/schedule":
        () => ({
          body: {
            projectId: PROJECT,
            operation: { id: "op", status: "succeeded" },
          },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await expect(
      platformCommand(
        "geo",
        ["schedule", "--engine", "openai", "--daily", "3"],
        t.io,
      ),
    ).rejects.toThrow(/accept-charges/);
    await platformCommand(
      "geo",
      ["schedule", "--engine", "openai", "--daily", "3", "--off"],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toMatchObject({
      enabled: false,
      dailyLimit: 3,
    });
    await expect(
      platformCommand(
        "geo",
        ["schedule", "--engine", "openai", "--every", "7", "--off"],
        t.io,
      ),
    ).rejects.toThrow(/google_ai_mode/);
    await platformCommand(
      "geo",
      [
        "schedule",
        "--engine",
        "google_ai_mode",
        "--daily",
        "3",
        "--every",
        "1",
        "--accept-charges",
      ],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toMatchObject({
      engine: "google_ai_mode",
      enabled: true,
      dailyLimit: 3,
      intervalDays: 1,
    });
  });

  it("autopilot level 0 needs --confirm-full-autopilot", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/targets": () => ({
        body: {
          repositories: [
            {
              repoId: REPO,
              orgId: ORG,
              owner: "acme",
              name: "web",
              fullName: "acme/web",
              enabled: true,
              apps: [],
            },
          ],
          installGithubAppUrl: null,
        },
      }),
      "POST /api/cli/v1/repos/33333333-3333-4333-8333-333333333333/autopilot/policy":
        () => ({
          body: { repoId: REPO, policy: { level: 0 } },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await expect(
      platformCommand("autopilot", ["level", "0", "--repo", "acme/web"], t.io),
    ).rejects.toThrow(/confirm-full-autopilot/);
    expect(server.calls).toHaveLength(0);
    await platformCommand(
      "autopilot",
      ["level", "0", "--repo", "acme/web", "--confirm-full-autopilot"],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toEqual({
      enabled: true,
      level: 0,
      confirmFullAutopilot: true,
    });
  });

  const targetsRoute = () => ({
    body: {
      repositories: [
        {
          repoId: REPO,
          orgId: ORG,
          owner: "acme",
          name: "web",
          fullName: "acme/web",
          enabled: true,
          apps: [],
        },
      ],
      installGithubAppUrl: null,
    },
  });

  it("autopilot level says when it overrides the workspace default", async () => {
    let workspaceDefault: unknown = null;
    const server = fakeServer({
      "GET /api/cli/v1/targets": targetsRoute,
      "POST /api/cli/v1/repos/33333333-3333-4333-8333-333333333333/autopilot/policy":
        () => ({
          body: {
            repoId: REPO,
            policy: { enabled: true, level: 2, inherits: false },
            workspaceDefault,
          },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand(
      "autopilot",
      ["level", "2", "--repo", "acme/web"],
      t.io,
    );
    expect(t.stdout()).toContain(
      "Autopilot on at level 2 (Open PR) for repository acme/web.",
    );
    workspaceDefault = { orgId: ORG, enabled: true, level: 0 };
    await platformCommand(
      "autopilot",
      ["level", "2", "--repo", "acme/web"],
      t.io,
    );
    expect(t.stdout()).toContain(
      "Autopilot on at level 2 (Open PR) for repository acme/web (overrides the workspace default).",
    );
  });

  it("autopilot default sets the workspace default for the repository's org", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/targets": targetsRoute,
      "POST /api/cli/v1/orgs/22222222-2222-4222-8222-222222222222/autopilot/default":
        () => ({
          body: {
            orgId: ORG,
            workspaceDefault: { orgId: ORG, enabled: true, level: 0 },
            updated: 2,
            inserted: 1,
          },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await expect(
      platformCommand("autopilot", ["default", "0"], t.io),
    ).rejects.toThrow(/confirm-full-autopilot/);
    await expect(
      platformCommand("autopilot", ["default", "5"], t.io),
    ).rejects.toThrow(/0, 1, 2, 3 or off/);
    expect(server.calls).toHaveLength(0);
    await platformCommand(
      "autopilot",
      ["default", "0", "--confirm-full-autopilot"],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toEqual({
      level: 0,
      enabled: true,
      confirmFullAutopilot: true,
    });
    expect(t.stdout()).toContain(
      `Workspace default set to level 0 (Full autopilot) for organization ${ORG}.`,
    );
    expect(t.stdout()).toContain("3 repositories follow it (1 new).");
    await platformCommand("autopilot", ["default", "off", "--org", ORG], t.io);
    expect(server.calls.at(-1)?.body).toEqual({ level: 3, enabled: false });
    await expect(
      platformCommand("autopilot", ["default", "1", "--org", "acme"], t.io),
    ).rejects.toThrow(/--org must be/);
  });

  it("autopilot follow-default switches a repository back to the default", async () => {
    let workspaceDefault: unknown = { orgId: ORG, enabled: true, level: 1 };
    const server = fakeServer({
      "GET /api/cli/v1/targets": targetsRoute,
      "POST /api/cli/v1/repos/33333333-3333-4333-8333-333333333333/autopilot/follow-default":
        () => ({
          body: {
            repoId: REPO,
            policy: workspaceDefault
              ? { enabled: true, level: 1, inherits: true }
              : { enabled: false, level: 3, inherits: true },
            workspaceDefault,
          },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand(
      "autopilot",
      ["follow-default", "--repo", "acme/web"],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toEqual({});
    expect(t.stdout()).toContain(
      "acme/web now follows the workspace default: level 1 (Autopilot).",
    );
    workspaceDefault = null;
    await platformCommand(
      "autopilot",
      ["follow-default", "--repo", "acme/web", "--confirm-full-autopilot"],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toEqual({ confirmFullAutopilot: true });
    expect(t.stdout()).toContain(
      "No workspace default yet: acme/web is back on the built-in default (off, level 3 (Notify))",
    );
  });

  it("billing checkout prints and optionally opens the hosted URL", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      "POST /api/cli/v1/orgs/22222222-2222-4222-8222-222222222222/billing/checkout":
        () => ({
          body: {
            state: "checkout",
            url: "https://checkout.stripe.com/c/pay/cs_1",
          },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand(
      "billing",
      ["checkout", "--plan", "pro", "--open"],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toEqual({ plan: "pro" });
    expect(t.stdout()).toContain("https://checkout.stripe.com/c/pay/cs_1");
    expect(t.opened).toEqual(["https://checkout.stripe.com/c/pay/cs_1"]);
  });

  it("alerts budget validates the value and resolves the org from the project", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      "POST /api/cli/v1/orgs/22222222-2222-4222-8222-222222222222/alerts/budget":
        () => ({
          body: { orgId: ORG, weekly: 1 },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await expect(
      platformCommand("alerts", ["budget", "7"], t.io),
    ).rejects.toThrow(/0\|1\|2\|3/);
    await platformCommand("alerts", ["budget", "1"], t.io);
    expect(server.calls.at(-1)?.body).toEqual({ weekly: 1 });
  });
});

describe("verify, sync and JSON errors", () => {
  it("verify exits 3 with instructions while the domain is unverified", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      "POST /api/cli/v1/projects/11111111-1111-4111-8111-111111111111/verify":
        () => ({
          body: {
            projectId: PROJECT,
            verified: false,
            method: null,
            attempts: [
              { method: "file", ok: false, reason: "File returned HTTP 404" },
            ],
            instructions: {
              dns: {
                name: "_paradigma.acme.test",
                value: "paradigma-verification=t",
              },
              file: {
                path: "/.well-known/paradigma-verification.txt",
                url: "https://acme.test/.well-known/paradigma-verification.txt",
                contents: "paradigma-verification=t",
                repoPath: "public/.well-known/paradigma-verification.txt",
              },
              meta: {
                tag: '<meta name="paradigma-verification" content="t">',
                nextjsMetadata: "",
              },
            },
          },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand("verify", ["--method", "file"], t.io);
    expect(process.exitCode).toBe(3);
    expect(server.calls.at(-1)?.body).toMatchObject({ methods: ["file"] });
    expect(t.stdout()).toContain("File returned HTTP 404");
    expect(t.stdout()).toContain(
      `npx paradigma-cli verify --project ${PROJECT}`,
    );
  });

  it("google waits for consent, then shows the PR and the GA4 tag", async () => {
    const pending = {
      projectId: PROJECT,
      verified: true,
      started: false,
      done: false,
      startUrl: `${SERVER}/dashboard/sites/${PROJECT}/connect/google`,
      searchConsole: {
        status: "not_started",
        property: null,
        file: null,
        pullUrl: null,
      },
      analytics: {
        status: "not_started",
        propertyId: null,
        measurementId: null,
        accounts: [],
        createAccountUrl: null,
        tagInstructions: null,
      },
      lastError: null,
    };
    const started = {
      ...pending,
      started: true,
      searchConsole: {
        status: "awaiting_deploy",
        property: "https://acme.test/",
        file: {
          name: "google0123456789abcdef.html",
          repoPath: "public/google0123456789abcdef.html",
          url: "https://acme.test/google0123456789abcdef.html",
          contents: "google-site-verification: google0123456789abcdef.html",
        },
        pullUrl: "https://github.com/acme/web/pull/7",
      },
      analytics: {
        ...pending.analytics,
        status: "created",
        propertyId: "123",
        measurementId: "G-ABC123",
        tagInstructions:
          "Add the Google Analytics 4 tag with measurement ID G-ABC123.",
      },
    };
    let polls = 0;
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`GET /api/cli/v1/projects/${PROJECT}/google`]: () => ({
        body: polls++ < 2 ? pending : started,
      }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd(), interactive: true });
    await platformCommand("google", [], t.io);
    expect(t.opened).toEqual([pending.startUrl]);
    expect(t.stdout()).toContain("public/google0123456789abcdef.html");
    expect(t.stdout()).toContain("https://github.com/acme/web/pull/7");
    expect(t.stdout()).toContain("G-ABC123");
    expect(process.exitCode).toBe(3);
  });

  const indexNow = (overrides: Record<string, unknown> = {}) => ({
    projectId: PROJECT,
    productionUrl: "https://acme.test",
    state: "active",
    keyFilePath: "public/0123456789abcdef0123456789abcdef.txt",
    keyFileUrl: "https://acme.test/0123456789abcdef0123456789abcdef.txt",
    pullRequestUrl: "https://github.com/acme/web/pull/9",
    recentDeploys: [
      {
        urlCount: 3,
        outcome: "submitted",
        httpStatus: 202,
        submittedAt: "2026-10-14T10:05:00.000Z",
      },
      {
        urlCount: 0,
        outcome: "nothing_changed",
        httpStatus: null,
        submittedAt: "2026-10-13T09:00:00.000Z",
      },
    ],
    settingsUrl: `${SERVER}/dashboard/sites/${PROJECT}/settings#indexnow`,
    ...overrides,
  });

  it("indexnow shows the state and recent deploys", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`GET /api/cli/v1/projects/${PROJECT}/indexnow`]: () => ({
        body: indexNow(),
      }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand("indexnow", [], t.io);
    const out = t.stdout();
    expect(out).toContain("IndexNow          on");
    expect(out).toContain("public/0123456789abcdef0123456789abcdef.txt");
    expect(out).toContain("2026-10-14 10:05  submitted  3 URLs  (HTTP 202)");
    expect(out).toContain("2026-10-13 09:00  nothing changed  0 URLs");
    expect(out).toContain("Google does not take part");
    expect(process.exitCode).toBeUndefined();
  });

  it("indexnow status exits 3 until the key file is live, and --json is the payload", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`GET /api/cli/v1/projects/${PROJECT}/indexnow`]: () => ({
        body: indexNow({ state: "waiting", recentDeploys: [] }),
      }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand("indexnow", ["status", "--json"], t.io);
    expect(JSON.parse(t.stdout())).toMatchObject({ state: "waiting" });
    expect(process.exitCode).toBe(3);
  });

  it("indexnow setup opens the pull request and waits for the deploy", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`POST /api/cli/v1/projects/${PROJECT}/indexnow/setup`]: () => ({
        body: indexNow({
          result: "started",
          state: "waiting",
          recentDeploys: [],
        }),
      }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand("indexnow", ["setup", "--project", PROJECT], t.io);
    expect(server.calls.at(-1)).toMatchObject({ method: "POST", body: {} });
    expect(t.stdout()).toContain("Opened the key file pull request");
    expect(t.stdout()).toContain("https://github.com/acme/web/pull/9");
    expect(process.exitCode).toBe(3);
  });

  it("indexnow setup reports a conflicting file as a failure", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`POST /api/cli/v1/projects/${PROJECT}/indexnow/setup`]: () => ({
        body: indexNow({ result: "conflict", state: "not_started" }),
      }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand("indexnow", ["setup"], t.io);
    expect(t.stderr()).toContain("A different file already exists");
    expect(process.exitCode).toBe(1);
  });

  it("indexnow on|off posts the switch; errors keep their server message", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`POST /api/cli/v1/projects/${PROJECT}/indexnow/enabled`]: (call) =>
        (call.body as { enabled: boolean }).enabled
          ? {
              status: 409,
              body: {
                error: "unverified",
                message:
                  "IndexNow is not set up for this production URL yet. Set it up first.",
              },
            }
          : { body: indexNow({ state: "off", enabled: false }) },
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand("indexnow", ["off"], t.io);
    expect(server.calls.at(-1)?.body).toEqual({ enabled: false });
    expect(t.stdout()).toContain("IndexNow submissions paused");
    await expect(
      platformCommand("indexnow", ["on"], t.io),
    ).rejects.toMatchObject({
      code: "unverified",
      message: expect.stringContaining("Set it up first"),
    });
    await expect(platformCommand("indexnow", ["toggle"], t.io)).rejects.toThrow(
      /Usage: paradigma indexnow/,
    );
  });

  const coverage = (overrides: Record<string, unknown> = {}) => ({
    projectId: PROJECT,
    productionUrl: "https://acme.test",
    connected: true,
    property: "sc-domain:acme.test",
    access: "read_only",
    candidates: 120,
    checked: 80,
    indexed: 34,
    notChecked: 40,
    coverage: 0.425,
    change: 5,
    byReason: {
      indexed: 34,
      discovered_not_indexed: 30,
      noindex: 16,
      not_checked: 40,
    },
    lastCheckAt: "2026-10-16T08:00:00.000Z",
    running: false,
    budget: { daily: 200, usedToday: 80 },
    requests: {
      day: "2026-10-16",
      items: [
        {
          url: "https://acme.test/pricing",
          reason: "discovered_not_indexed",
          reasonLabel: "Discovered, not indexed",
          inspectUrl:
            "https://search.google.com/search-console/inspect?resource_id=sc-domain%3Aacme.test&id=https%3A%2F%2Facme.test%2Fpricing",
          requested: false,
          requestedAt: null,
          outcome: null,
        },
        {
          url: "https://acme.test/docs",
          reason: "discovered_not_indexed",
          reasonLabel: "Discovered, not indexed",
          inspectUrl: "https://search.google.com/search-console/inspect?x",
          requested: true,
          requestedAt: "2026-10-16T09:00:00.000Z",
          outcome: "waiting",
        },
      ],
    },
    wins: [
      {
        url: "https://acme.test/blog",
        requestedAt: "2026-10-10T09:00:00.000Z",
        indexedAt: "2026-10-13T08:00:00.000Z",
      },
    ],
    sitemap: {
      read: true,
      roots: ["https://acme.test/sitemap.xml"],
      canSubmit: false,
      submittedAt: null,
      submitError: null,
      report: [],
    },
    dashboardUrl: `${SERVER}/dashboard/sites/${PROJECT}#indexing`,
    reconnectUrl: `${SERVER}/dashboard/sites/${PROJECT}/connect/gsc?access=sitemaps`,
    ...overrides,
  });

  it("index shows coverage, reasons and today's links, and exits 3 while some are left", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`GET /api/cli/v1/projects/${PROJECT}/index`]: () => ({
        body: coverage(),
      }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand("index", [], t.io);
    const out = t.stdout();
    expect(out).toContain(
      "Indexed           34 of 80 checked pages (+5 since yesterday)",
    );
    expect(out).toContain("Not checked yet 40 of 120 candidates");
    expect(out).toContain("   30  Discovered, not indexed");
    expect(out).toContain("   16  Excluded by noindex");
    expect(out).toContain(
      "[ ] https://acme.test/pricing  Discovered, not indexed",
    );
    expect(out).toContain(
      "https://search.google.com/search-console/inspect?resource_id=sc-domain%3Aacme.test",
    );
    expect(out).toContain("[x] https://acme.test/docs");
    expect(out).toContain("agent with browser access");
    expect(out).toContain("https://acme.test/blog  2026-10-13");
    expect(out).toContain("resubmission off (read-only Google access)");
    expect(out).toContain("connect/gsc?access=sitemaps");
    expect(process.exitCode).toBe(3);
  });

  it("index --json is the payload; nothing left means exit 0", async () => {
    const done = coverage({ requests: { day: "2026-10-16", items: [] } });
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`GET /api/cli/v1/projects/${PROJECT}/index`]: () => ({ body: done }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand("index", ["--json"], t.io);
    expect(JSON.parse(t.stdout())).toMatchObject({ indexed: 34 });
    expect(process.exitCode).toBeUndefined();
  });

  it("index requested posts the URLs and reports unknown ones", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`POST /api/cli/v1/projects/${PROJECT}/index/requested`]: () => ({
        body: {
          projectId: PROJECT,
          marked: ["https://acme.test/pricing"],
          unknown: ["https://other.test/x"],
          requests: coverage().requests,
        },
      }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand(
      "index",
      ["requested", "https://acme.test/pricing/", "https://other.test/x"],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toEqual({
      urls: ["https://acme.test/pricing/", "https://other.test/x"],
      requested: true,
    });
    expect(t.stdout()).toContain("Marked as requested: 1 page.");
    expect(t.stderr()).toContain("Not one of this project's checked pages");
    expect(process.exitCode).toBe(1);
    await expect(platformCommand("index", ["requested"], t.io)).rejects.toThrow(
      /1 to 20 URLs/,
    );
    await expect(platformCommand("index", ["submit"], t.io)).rejects.toThrow(
      /Usage: paradigma index/,
    );
  });

  it("index check starts the batch or says one is running", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`POST /api/cli/v1/projects/${PROJECT}/index/check`]: () => ({
        status: 202,
        body: {
          projectId: PROJECT,
          requested: true,
          budget: { daily: 200, usedToday: 12 },
        },
      }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await platformCommand("index", ["check"], t.io);
    expect(server.calls.at(-1)).toMatchObject({ method: "POST", body: {} });
    expect(t.stdout()).toContain(
      "Checking now (12/200 inspections used today)",
    );
  });

  it("google account validates the id and posts the choice", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`POST /api/cli/v1/projects/${PROJECT}/google/analytics-account`]:
        () => ({
          body: {
            projectId: PROJECT,
            verified: true,
            started: true,
            done: true,
            startUrl: "x",
            searchConsole: {
              status: "connected",
              property: "sc-domain:acme.test",
              file: null,
              pullUrl: null,
            },
            analytics: {
              status: "created",
              propertyId: "9",
              measurementId: "G-XYZ999",
              accounts: [],
              createAccountUrl: null,
              tagInstructions: null,
            },
            lastError: null,
          },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await expect(
      platformCommand("google", ["account", "abc"], t.io),
    ).rejects.toThrow(/Usage/);
    await platformCommand(
      "google",
      ["account", "42", "--time-zone", "Europe/Berlin"],
      t.io,
    );
    expect(server.calls.at(-1)?.body).toEqual({
      accountId: "42",
      timeZone: "Europe/Berlin",
    });
    expect(t.stdout()).toContain("G-XYZ999");
    expect(process.exitCode).toBeUndefined();
  });

  it("sync rejects unknown sources and --json failures are parseable", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      "POST /api/cli/v1/projects/11111111-1111-4111-8111-111111111111/sync":
        () => ({
          status: 503,
          body: {
            error: "unavailable",
            message: "Check the Search Console connection.",
          },
        }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await expect(platformCommand("sync", ["ftp"], t.io)).rejects.toThrow(
      /Usage/,
    );
    await expect(
      platformCommand("sync", ["gsc", "--json"], t.io),
    ).rejects.toThrow();
    expect(t.events().at(-1)).toEqual({
      ok: false,
      error: "unavailable",
      message: "Check the Search Console connection.",
    });
  });

  it("asks for --project when several projects exist outside a checkout", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": () => ({
        body: { projects: [project, { ...project, id: PROMPT, name: "Docs" }] },
      }),
    });
    const t = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await expect(platformCommand("audit", [], t.io)).rejects.toThrow(
      /--project/,
    );
  });
});

describe("detection", () => {
  it("chooses the app root containing the working directory", () => {
    expect(chooseAppRoot(["", "apps/docs"], "apps/docs/src")).toBe("apps/docs");
    expect(chooseAppRoot(["", "apps/docs"], "")).toBe("");
    expect(chooseAppRoot(["apps/web", "apps/docs"], "")).toBeNull();
    expect(chooseAppRoot(["apps/web"], "packages/ui")).toBe("apps/web");
    expect(chooseAppRoot([], "")).toBeNull();
  });

  it("reads brand and URL candidates without guessing from noise", () => {
    expect(brandFromPackageName("@acme/web")).toBe("Acme");
    expect(brandFromPackageName("acme-cloud")).toBe("Acme Cloud");
    expect(productionOrigin("http://acme.test")).toBeNull();
    expect(productionOrigin("https://acme.test/pricing")).toBe(
      "https://acme.test",
    );
    expect(
      layoutMetadata(`export const metadata = {
        metadataBase: new URL(process.env.SITE_URL ?? "https://acme.test"),
        title: { default: "Acme — Analytics for founders", template: "%s | Acme" },
        description: "Product analytics",
      };`),
    ).toEqual({
      metadataBase: "https://acme.test",
      title: "Acme",
      description: "Product analytics",
    });

    const repo = join(root, "repo");
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(
      join(repo, "app", "layout.tsx"),
      'export const metadata = { metadataBase: new URL("https://www.acme.test"), openGraph: { siteName: "Acme Cloud" } };',
    );
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "acme-web",
        homepage: "https://github.com/acme/web",
        description: "Analytics",
      }),
    );
    writeFileSync(
      join(repo, "README.md"),
      "# Acme\n[![ci](https://img.shields.io/x)](https://github.com/acme)\nLive at https://acme.test\n",
    );
    const candidates = inferSiteCandidates(repo, "");
    expect(candidates.urls.map((c) => c.value)).toEqual([
      "https://www.acme.test",
      "https://acme.test",
    ]);
    expect(candidates.brands[0]).toEqual({
      value: "Acme Cloud",
      source: "openGraph.siteName",
    });
    expect(candidates.descriptions[0].value).toBe("Analytics");
  });
});

describe("mcp install", () => {
  it("uses each agent's own add command", () => {
    expect(mcpAddCommand("claude", `${SERVER}/api/mcp`)).toEqual([
      "claude",
      "mcp",
      "add",
      "--transport",
      "http",
      "paradigma",
      `${SERVER}/api/mcp`,
    ]);
    expect(mcpAddCommand("codex", `${SERVER}/api/mcp`)).toEqual([
      "codex",
      "mcp",
      "add",
      "paradigma",
      "--url",
      `${SERVER}/api/mcp`,
    ]);
    expect(hostAgent({ CLAUDECODE: "1" })).toBe("claude");
    expect(hostAgent({})).toBeNull();
  });

  it("merges into Cursor's config with a backup and never clobbers invalid JSON", async () => {
    const home = join(root, "cursor-home");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const file = join(home, ".cursor", "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: 1 }),
    );
    const first = await installCursor(`${SERVER}/api/mcp`, home);
    expect(first.status).toBe("installed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      keep: 1,
      mcpServers: {
        other: { command: "x" },
        paradigma: { url: `${SERVER}/api/mcp` },
      },
    });
    expect(first.action).toMatch(/backup: .*mcp\.json\.bak-/);
    expect((await installCursor(`${SERVER}/api/mcp`, home)).status).toBe(
      "already_configured",
    );

    writeFileSync(file, "{ not json");
    const broken = await installCursor(`${SERVER}/api/mcp`, home);
    expect(broken.status).toBe("failed");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("frameworkConfigUrl", () => {
  it("reads the production URL other frameworks declare, without running them", () => {
    expect(
      frameworkConfigUrl(
        "astro.config.mjs",
        'export default defineConfig({ site: "https://acme.dev", integrations: [] })',
      ),
    ).toEqual({ url: "https://acme.dev", label: "astro.config site" });
    expect(
      frameworkConfigUrl(
        "hugo.toml",
        'title = "Acme"\nbaseURL = "https://acme.dev/"\n',
      )?.url,
    ).toBe("https://acme.dev/");
    expect(
      frameworkConfigUrl("hugo.yaml", "baseURL: https://docs.acme.dev\n")?.url,
    ).toBe("https://docs.acme.dev");
    expect(
      frameworkConfigUrl(
        "_config.yml",
        'title: Blog\nurl: "https://blog.acme.dev"\n',
      )?.url,
    ).toBe("https://blog.acme.dev");
    expect(
      frameworkConfigUrl(
        "gatsby-config.js",
        "siteMetadata: { siteUrl: `https://acme.dev` }",
      )?.url,
    ).toBe("https://acme.dev");
    expect(
      frameworkConfigUrl("astro.config.mjs", "site: process.env.SITE"),
    ).toBeNull();
    expect(
      frameworkConfigUrl("package.json", '{"homepage":"https://x"}'),
    ).toBeNull();
  });
});
