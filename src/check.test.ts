import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_USAGE,
  checkCommand,
  exitCodeFor,
  renderCheck,
  renderRiskCheck,
} from "./check";
import { saveConfig } from "./config";
import {
  type PublicCheck,
  type PublicRiskCheck,
  publicCheckSchema,
  publicRiskCheckSchema,
} from "./contract/public-check";
import { ActionRequired, UsageError } from "./io";
import { renderProjectScan } from "./scan";
import { fakeIo, fakeServer } from "./test/platform";
import { pendingScan, sampleScan } from "./test/scan";

const SERVER = "https://app.paradigma.test";

const SAMPLE: PublicCheck = publicCheckSchema.parse({
  scoreContractVersion: "1",
  target: {
    input: "https://onsetprep.com/",
    origin: "https://onsetprep.com",
    host: "onsetprep.com",
  },
  pillars: [
    {
      pillar: "agents",
      score: 96.2,
      label: "Strong",
      pools: {
        essential: { earned: 76, max: 80, passed: 7, applicable: 8 },
        recommended: { earned: 17.2, max: 20, passed: 20, applicable: 26 },
        bonus: { earned: 3, cap: 5, passed: 3, applicable: 10 },
      },
      cap: null,
      counts: {
        checks: 67,
        pass: 29,
        partial: 6,
        fail: 10,
        na: 22,
        suggestions: 6,
      },
      fixFirst: [
        {
          checkId: "agents/read/markdown-negotiation-vary",
          title: "Pages that serve Markdown send Vary: Accept",
          status: "partial",
          summary: "7 of 7 pages that serve Markdown miss Vary: Accept",
          fix: {
            copy: "Send Vary: Accept on both responses.",
            prompt: "Add Vary: Accept",
            pr: "auto",
          },
        },
        {
          checkId: "agents/discover/link-headers",
          title: "The homepage sends Link headers",
          status: "fail",
          summary: "No Link header on the homepage",
        },
      ],
      suggestions: [
        { id: "agents/discover/llms-full-txt", status: "fail" },
        { id: "agents/read/x", status: "pass" },
      ],
    },
  ],
  teaser: [
    { pillar: "seo", issues: 0, checks: 30 },
    { pillar: "aeo", issues: 1, checks: 12 },
    { pillar: "geo", issues: 7, checks: 20 },
  ],
  tool: {
    pillar: "agents",
    name: "AI agent readiness checker",
    url: `${SERVER}/tools/agent-readiness-checker`,
    resultUrl: `${SERVER}/tools/agent-readiness-checker/r/onsetprep.com`,
    badgeUrl: `${SERVER}/tools/agent-readiness-checker/badge/onsetprep.com.svg`,
    methodologyUrl: `${SERVER}/tools/methodology`,
  },
  snapshot: {
    scannedAt: "2026-10-15T12:04:00.000Z",
    expiresAt: "2026-10-16T12:04:00.000Z",
    cached: true,
  },
});

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "paradigma-check-"));
  vi.stubEnv("PARADIGMA_HOME", join(root, "home"));
  vi.stubEnv("PARADIGMA_SERVER", "");
  process.exitCode = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("renderCheck", () => {
  it("prints score, label, the fix-first list, suggestions and the teaser", () => {
    const text = renderCheck(SAMPLE).join("\n");
    expect(text).toContain("AI agent readiness checker · onsetprep.com");
    expect(text).toContain("Score 96.2/100 · Strong");
    expect(text).not.toContain("Essential");
    expect(text).toContain("Fix these first (2):");
    expect(text).toContain("1. ! Pages that serve Markdown send Vary: Accept");
    expect(text).toContain("Fix: Send Vary: Accept on both responses.");
    expect(text).toContain("2. ✗ The homepage sends Link headers");
    expect(text).toContain("2 suggestions, not scored (1 open)");
    expect(text).toContain(
      "Other pillars: no SEO issues · 1 AEO issue · 7 GEO issues",
    );
    expect(text).toContain("Scanned 2026-10-15 12:04 UTC (cached)");
    expect(text).not.toContain("—");
  });

  it("caps the list", () => {
    const text = renderCheck(SAMPLE, 1).join("\n");
    expect(text).toContain("and 1 more");
  });
});

describe("check <pillar> <domain>", () => {
  it("calls the public API without a token and prints the compact report", async () => {
    const server = fakeServer({
      "GET /api/tools/v1/agents/onsetprep.com": () => ({ body: SAMPLE }),
    });
    const { io, stdout } = fakeIo({
      fetch: server.fetch,
      env: { PARADIGMA_SERVER: SERVER },
    });
    await checkCommand(io, ["agents", "onsetprep.com"]);
    expect(server.calls[0]?.authorization).toBeNull();
    expect(stdout()).toContain("Score 96.2/100 · Strong");
  });

  it("prints the API JSON with --json and rescans with POST", async () => {
    const server = fakeServer({
      "POST /api/tools/v1/seo/example.com": () => ({ body: SAMPLE }),
    });
    const { io, stdout } = fakeIo({
      fetch: server.fetch,
      env: { PARADIGMA_SERVER: SERVER },
    });
    await checkCommand(io, ["seo", "example.com", "--json", "--rescan"]);
    expect(JSON.parse(stdout())).toEqual(JSON.parse(JSON.stringify(SAMPLE)));
  });

  it("exits 3 when rate-limited and 2 on a bad domain", async () => {
    const server = fakeServer({
      "GET /api/tools/v1/geo/example.com": () => ({
        status: 429,
        body: {
          ok: false,
          error: "rate_limited",
          message: "You have run 10 new scans this hour. Try again in 12 min",
          retryAfterSeconds: 700,
        },
      }),
    });
    const { io, stderr } = fakeIo({
      fetch: server.fetch,
      env: { PARADIGMA_SERVER: SERVER },
    });
    await checkCommand(io, ["geo", "example.com"]);
    expect(stderr()).toContain("Try again in 12 min");
    expect(process.exitCode).toBe(3);
    expect(exitCodeFor("invalid_domain")).toBe(2);
    expect(exitCodeFor("unreachable")).toBe(1);
  });

  it("rejects unknown pillars", async () => {
    const { io } = fakeIo();
    await expect(checkCommand(io, ["speed", "example.com"])).rejects.toThrow(
      new UsageError(CHECK_USAGE),
    );
  });
});

const RISK: PublicRiskCheck = publicRiskCheckSchema.parse({
  kind: "penalty-risk",
  target: { host: "parsetprep.dev", origin: "https://parsetprep.dev" },
  scannedAt: "2026-10-17T12:00:00.000Z",
  level: "elevated",
  found: [
    {
      family: "machine-output",
      label: "Leftovers of generated text",
      level: "elevated",
      channels: ["google", "bing"],
      documented: true,
      policyUrl:
        "https://developers.google.com/search/docs/fundamentals/using-gen-ai-content",
      findings: [
        {
          check: "No leftovers of generated or template text are visible",
          evidence: "8 pages show unrendered markdown or leftover markers",
          fix: "Render or strip the markdown.",
          prompt: "Find where the flagged text comes from.",
          pages: [
            "https://parsetprep.dev/a",
            "https://parsetprep.dev/b",
            "https://parsetprep.dev/c",
            "https://parsetprep.dev/d",
          ],
          siteWide: false,
        },
      ],
      pages: [],
    },
  ],
  clean: [
    {
      family: "cloaking",
      label: "Crawlers and visitors get different pages",
      checked: ["x"],
    },
  ],
  notChecked: [
    { family: "interstitials", label: "Overlays that cover the content" },
  ],
  scan: { pagesRead: 25, requests: 60 },
  tool: {
    name: "Penalty risk checker",
    url: `${SERVER}/tools/penalty-risk-checker`,
    methodologyUrl: `${SERVER}/tools/methodology#penalty-risk`,
    signUpUrl: `${SERVER}/dashboard`,
    manualActionsUrl: "https://search.google.com/search-console/manual-actions",
  },
  private: true,
});

describe("check risk <domain>", () => {
  it("prints the level, each family with evidence, pages, fix and policy, and the CTA", () => {
    const text = renderRiskCheck(RISK).join("\n");
    expect(text).toContain("Penalty risk checker · parsetprep.dev");
    expect(text).toContain("Penalty risk: Elevated · 1 family found");
    expect(text).toContain("a clean result is not proof");
    expect(text).toContain("1. Leftovers of generated text");
    expect(text).toContain("Elevated · Documented · Google, Bing");
    expect(text).toContain("Pages: /a, /b, /c and 1 more");
    expect(text).toContain("Fix: Render or strip the markdown.");
    expect(text).toContain("Policy: https://developers.google.com/");
    expect(text).toContain("Checked and clean: 1 family");
    expect(text).toContain(
      "Needs a signed-in scan: Overlays that cover the content",
    );
    expect(text).toContain(
      `Verify your domain to watch this daily: ${SERVER}/dashboard`,
    );
    expect(text).not.toMatch(/machine-output|—/);
  });

  it("calls the risk API anonymously and prints the report", async () => {
    const server = fakeServer({
      "GET /api/tools/v1/risk/parsetprep.dev": () => ({ body: RISK }),
    });
    const { io, stdout } = fakeIo({
      fetch: server.fetch,
      env: { PARADIGMA_SERVER: SERVER },
    });
    await checkCommand(io, ["risk", "parsetprep.dev"]);
    expect(server.calls[0]?.authorization).toBeNull();
    expect(stdout()).toContain("Penalty risk: Elevated");
  });

  it("sends the saved token to the configured server, for the member limit on own projects", async () => {
    await saveConfig({
      server: SERVER,
      token: `pdg_rt_${"d".repeat(43)}`,
      repos: {},
      repoNames: {},
      checks: {},
      paused: false,
    });
    const server = fakeServer({
      "GET /api/tools/v1/risk/acme.test": () => ({ body: RISK }),
    });
    const { io, stdout } = fakeIo({
      fetch: server.fetch,
      env: { PARADIGMA_SERVER: SERVER },
    });
    await checkCommand(io, ["risk", "acme.test", "--json"]);
    expect(server.calls[0]?.authorization).toBe(
      `Bearer pdg_rt_${"d".repeat(43)}`,
    );
    expect(JSON.parse(stdout()).kind).toBe("penalty-risk");
  });

  it("exits 3 once the free check is used", async () => {
    const server = fakeServer({
      "GET /api/tools/v1/risk/example.com": () => ({
        status: 429,
        body: {
          ok: false,
          error: "already_used",
          message:
            "Your free check is used until 16 Nov 2026. Sign in to check your own projects any time",
          retryAfterSeconds: 3600,
        },
      }),
    });
    const { io, stderr } = fakeIo({
      fetch: server.fetch,
      env: { PARADIGMA_SERVER: SERVER },
    });
    await checkCommand(io, ["risk", "example.com"]);
    expect(stderr()).toContain("16 Nov 2026");
    expect(process.exitCode).toBe(3);
  });

  it("rejects --rescan and a missing domain", async () => {
    const { io } = fakeIo();
    await expect(
      checkCommand(io, ["risk", "example.com", "--rescan"]),
    ).rejects.toThrow(new UsageError(CHECK_USAGE));
    await expect(checkCommand(io, ["risk"])).rejects.toThrow(
      new UsageError(CHECK_USAGE),
    );
  });
});

describe("check all", () => {
  it("needs sign-in", async () => {
    const { io } = fakeIo();
    await expect(checkCommand(io, ["all"])).rejects.toThrow(/Not signed in/);
  });

  const project = "11111111-1111-4111-8111-111111111111";
  const scanPath = `/api/cli/v1/projects/${project}/scan`;
  const signIn = () =>
    saveConfig({
      server: SERVER,
      token: `pdg_rt_${"c".repeat(43)}`,
      repos: {},
      repoNames: {},
      checks: {},
      paused: false,
    });
  const projects = () => ({
    body: {
      projects: [
        {
          id: project,
          orgId: "22222222-2222-4222-8222-222222222222",
          repoId: "33333333-3333-4333-8333-333333333333",
          repoFullName: "acme/web",
          appRoot: "",
          name: "Acme",
          productionUrl: "https://acme.test",
          verified: false,
        },
      ],
    },
  });

  it("prints the latest completed scan without requesting a new one", async () => {
    await signIn();
    const server = fakeServer({
      "GET /api/cli/v1/projects": projects,
      [`GET ${scanPath}`]: () => ({ body: sampleScan(project) }),
    });
    const { io, stdout } = fakeIo({ fetch: server.fetch, cwd: root });
    await checkCommand(io, ["all"]);
    const text = stdout();
    expect(text).toContain("Four-pillar scan · acme.test");
    expect(text).toContain("Scanned 2026-10-16 09:12 UTC");
    expect(text).toMatch(/SEO {5}92\/100 · Strong/);
    expect(text).toContain(
      "28 passed · 2 partial · 1 failed · 4 not applicable",
    );
    expect(text).toContain("Agents  96/100 · Strong");
    expect(text).toContain("Fix these first (4 of 9):");
    expect(text).toContain(
      "1. ✗ AI crawlers may read your pages (GEO, Agents)",
    );
    expect(text).toContain(
      "Fix: Allow GPTBot, ClaudeBot and PerplexityBot in robots.txt.",
    );
    expect(text).toContain("Autopilot can ship this fix.");
    expect(text).toContain("and 5 more in the dashboard");
    expect(text).toContain(
      "Locked until you verify the domain: these fixes are queued as tasks.",
    );
    expect(text).toContain(
      `Verify: npx paradigma-cli verify --project ${project}`,
    );
    expect(text).toContain(
      `Full report: https://app.paradigma.test/dashboard/sites/${project}`,
    );
    expect(text).not.toMatch(/pool|weight|essential|points/i);
    expect(server.calls.some((c) => c.method === "POST")).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it("requests a scan when none completed, polls and prints JSON with --json", async () => {
    await signIn();
    // The onboarding scan failed; the new one runs for two reads.
    let posted = false;
    let reads = 0;
    const server = fakeServer({
      "GET /api/cli/v1/projects": projects,
      [`GET ${scanPath}`]: () => ({
        body: !posted
          ? pendingScan(project, "failed")
          : reads++ < 2
            ? pendingScan(project, "running")
            : sampleScan(project),
      }),
      [`POST ${scanPath}`]: () => {
        posted = true;
        return {
          status: 202,
          body: { ...pendingScan(project, "queued"), requested: true },
        };
      },
    });
    const { io, stdout } = fakeIo({ fetch: server.fetch, cwd: root });
    await checkCommand(io, ["all", "--project", project, "--json"]);
    expect(JSON.parse(stdout())).toEqual(
      JSON.parse(JSON.stringify(sampleScan(project))),
    );
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/cli/v1/projects",
      `GET ${scanPath}`,
      `POST ${scanPath}`,
      `GET ${scanPath}`,
      `GET ${scanPath}`,
      `GET ${scanPath}`,
    ]);
  });

  it("stops at --wait with exit 3 and the command to check later", async () => {
    await signIn();
    const server = fakeServer({
      "GET /api/cli/v1/projects": projects,
      [`GET ${scanPath}`]: () => ({ body: pendingScan(project, "running") }),
    });
    const { io, stderr } = fakeIo({ fetch: server.fetch, cwd: root });
    const error = await checkCommand(io, ["all", "--wait", "12"]).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(ActionRequired);
    expect((error as ActionRequired).message).toContain("still running");
    expect((error as ActionRequired).detail).toEqual({
      projectId: project,
      scan: { status: "running" },
      check: `npx paradigma-cli check all --project ${project}`,
    });
    expect(stderr()).toContain("Scanning https://acme.test");
    // The first read, then one every 5 s until 12 s: 5, 10, 12.
    expect(server.calls.filter((c) => c.path === scanPath)).toHaveLength(4);
    expect(server.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("exits 1 when the scan fails and 3 when a new one may not start yet", async () => {
    await signIn();
    let post: Record<string, unknown> = {
      ...pendingScan(project, "queued"),
      requested: true,
    };
    const server = fakeServer({
      "GET /api/cli/v1/projects": projects,
      [`GET ${scanPath}`]: () => ({ body: pendingScan(project, "failed") }),
      [`POST ${scanPath}`]: () => ({ status: 202, body: post }),
    });
    const failed = fakeIo({ fetch: server.fetch, cwd: root });
    await checkCommand(failed.io, ["all"]);
    expect(failed.stderr()).toContain("The scan of https://acme.test failed");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    post = {
      ...pendingScan(project, "failed"),
      requested: false,
      reason: "too_soon",
    };
    const soon = fakeIo({ fetch: server.fetch, cwd: root });
    const error = await checkCommand(soon.io, ["all"]).catch((e) => e);
    expect(error).toBeInstanceOf(ActionRequired);
    expect((error as Error).message).toContain("Try again in a few minutes");
  });

  it("rejects a domain after all and a bad --wait", async () => {
    const { io } = fakeIo();
    await expect(checkCommand(io, ["all", "acme.test"])).rejects.toThrow(
      new UsageError(CHECK_USAGE),
    );
    await expect(checkCommand(io, ["all", "--wait", "-1"])).rejects.toThrow(
      /--wait/,
    );
  });
});

describe("renderProjectScan", () => {
  it("says when a newer scan is running and leaves the lock out once verified", () => {
    const text = renderProjectScan(
      sampleScan("p", { status: "running", locked: false, next: null }),
    ).join("\n");
    expect(text).toContain("(a new scan is running)");
    expect(text).not.toContain("Locked");
    expect(text).not.toContain("—");
  });

  it("prints nothing to fix when every check passed", () => {
    const text = renderProjectScan(
      sampleScan("p", { fixes: [], openFixes: 0 }),
    ).join("\n");
    expect(text).toContain("Fix these first: nothing");
  });
});
