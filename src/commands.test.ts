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
