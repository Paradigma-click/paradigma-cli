import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandRunner,
  canAutoFix,
  deployDoctor,
  deployLine,
  deploySummary,
  doctorDeployCommand,
  renderDeploy,
  safeMessage,
} from "./deploy";
import type { ExecResult } from "./exec";
import { fakeIo } from "./test/platform";

const PROJECT = "prj_G7vSGkTTWhYue50VuPcW1JGLgtxj";
const TEAM = "team_NR3pfGJsV8RgGmDAaYvo6dXq";
const NOREPLY = "123134059+alifoo@users.noreply.github.com";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";

let root: string;

function write(path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function result(partial: Partial<ExecResult>): ExecResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    cancelled: false,
    durationMs: 1,
    ...partial,
  };
}

type FakeVercel = {
  installed?: boolean;
  /** `vercel api` exists (CLI 50+); older CLIs fall back to npx. */
  hasApi?: boolean;
  loggedIn?: boolean;
  link?: Record<string, unknown> | null;
  state?: string;
  connects?: boolean;
  authors?: string[];
};

/** Fake host CLIs and git: answers by argv, records every call. */
function fakeRunner(fake: FakeVercel = {}) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const state = { link: fake.link ?? null };
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (command === "git")
      return result({
        stdout: `${(fake.authors ?? ["dev@acme.test"]).join("\n")}\n`,
      });
    const argv = command === "npx" ? args.slice(2) : args;
    if (command === "vercel" && fake.installed === false)
      return result({ code: null, error: "spawn vercel ENOENT" });
    if (argv[0] === "api" && argv[1] === "--help")
      return result({
        stdout:
          fake.hasApi === false
            ? "▲ vercel [options] <command | path>\n"
            : "▲ vercel api [endpoint] [options]\nMake authenticated HTTP requests to the Vercel API\n",
      });
    if (argv[0] === "api") {
      if (fake.loggedIn === false)
        return result({
          code: 1,
          stderr:
            "Error: No existing credentials found. Please run `vercel login`.",
        });
      const path = argv[1] ?? "";
      if (path.startsWith(`/v9/projects/${PROJECT}`))
        return result({
          stdout: JSON.stringify({
            id: PROJECT,
            name: "paradigma",
            link: state.link,
            // Never surfaced, even if the API returned something token-like.
            env: [{ key: "SECRET", value: TOKEN }],
          }),
        });
      if (path.startsWith("/v7/deployments"))
        return result({
          stdout: JSON.stringify({
            deployments: [
              {
                uid: "dpl_1",
                readyState: fake.state ?? "READY",
                target: "production",
              },
            ],
          }),
        });
    }
    if (argv[0] === "git" && argv[1] === "connect") {
      if (!fake.connects)
        return result({
          code: 1,
          stderr: `Error: Failed to connect (token ${TOKEN})`,
        });
      state.link = {
        type: "github",
        org: "acme",
        repo: "web",
        productionBranch: "main",
      };
      return result({ stdout: "Connected GitHub repository acme/web!\n" });
    }
    return result({
      code: 1,
      stderr: `unexpected ${command} ${args.join(" ")}`,
    });
  };
  return { runner, calls };
}

function linkVercel() {
  write(
    ".vercel/project.json",
    JSON.stringify({
      projectId: PROJECT,
      orgId: TEAM,
      projectName: "paradigma",
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paradigma-deploy-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("deployDoctor (Vercel)", () => {
  it("reports a CLI-only project and the exact fix", async () => {
    linkVercel();
    write("vercel.json", "{}");
    const fake = fakeRunner({
      link: null,
      authors: [NOREPLY, "dev@acme.test"],
    });
    const report = await deployDoctor({ repoRoot: root, runner: fake.runner });
    expect(report).toMatchObject({
      host: "vercel",
      evidence: [".vercel/project.json", "vercel.json"],
      project: { id: PROJECT, name: "paradigma", orgId: TEAM },
      gitConnected: false,
      deploysOnMerge: false,
      blocked: false,
      noreplyAuthor: NOREPLY,
      cli: { name: "vercel", available: true, loggedIn: true },
      fix: "vercel git connect",
    });
    expect(report.fixes.map((f) => f.id)).toEqual([
      "vercel_git_connect",
      "vercel_commit_author",
    ]);
    expect(canAutoFix(report)).toBe(true);
    // Explicit team scope, read-only API calls, never a token argument.
    const api = fake.calls.filter(
      (c) => c.args[0] === "api" && c.args[1] !== "--help",
    );
    expect(api.map((c) => c.args[1])).toEqual([
      `/v9/projects/${PROJECT}?teamId=${TEAM}`,
      `/v7/deployments?projectId=${PROJECT}&target=production&limit=1&teamId=${TEAM}`,
    ]);
    for (const call of fake.calls) {
      expect(call.args.join(" ")).not.toMatch(/--token|-t\b/);
    }
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(deployLine(report)).toBe(
      "✗ Vercel is not connected to Git, so merged fixes never go live. Fix: vercel git connect",
    );
  });

  it("passes a Git-connected project and flags a BLOCKED production deploy", async () => {
    linkVercel();
    const fake = fakeRunner({
      link: {
        type: "github",
        org: "acme",
        repo: "web",
        productionBranch: "main",
      },
      state: "BLOCKED",
    });
    const report = await deployDoctor({ repoRoot: root, runner: fake.runner });
    expect(report).toMatchObject({
      gitConnected: true,
      gitRepo: { repo: "acme/web", branch: "main" },
      deploysOnMerge: true,
      blocked: true,
      fix: "https://vercel.com/account/settings/authentication",
    });
    expect(renderDeploy(report)).toEqual([
      "Deploy: Vercel (.vercel/project.json)",
      "✓ Vercel project paradigma deploys from GitHub (acme/web, branch main)",
      "✗ The latest production deployment is BLOCKED: Vercel did not recognize the commit author.",
      "  Fix: Connect GitHub in Vercel Account › Settings › Authentication so Vercel recognizes the commit author (https://vercel.com/account/settings/authentication)",
    ]);
    expect(deploySummary(report)).toEqual({
      host: "vercel",
      gitConnected: true,
      deploysOnMerge: true,
      blocked: true,
      fix: "https://vercel.com/account/settings/authentication",
    });
  });

  it("asks for a login instead of guessing", async () => {
    linkVercel();
    const report = await deployDoctor({
      repoRoot: root,
      runner: fakeRunner({ loggedIn: false }).runner,
    });
    expect(report).toMatchObject({
      gitConnected: null,
      deploysOnMerge: null,
      cli: { available: true, loggedIn: false },
      fix: "vercel login",
    });
  });

  it("falls back to npx vercel@latest when the installed CLI has no `vercel api`", async () => {
    linkVercel();
    const fake = fakeRunner({ hasApi: false, link: null });
    const report = await deployDoctor({ repoRoot: root, runner: fake.runner });
    expect(report.gitConnected).toBe(false);
    const api = fake.calls.filter((c) => c.args.includes("--raw"));
    expect(api.every((c) => c.command === "npx")).toBe(true);
    expect(api[0]?.args.slice(0, 3)).toEqual(["--yes", "vercel@latest", "api"]);
    // The old CLI never received an unknown subcommand other than the --help probe.
    expect(
      fake.calls.filter((c) => c.command === "vercel").map((c) => c.args),
    ).toEqual([["api", "--help"]]);
  });

  it("gives generic guidance without the CLI or a link", async () => {
    linkVercel();
    const missing = await deployDoctor({
      repoRoot: root,
      runner: fakeRunner({ installed: false }).runner,
    });
    expect(missing).toMatchObject({
      cli: { name: "vercel", available: false },
      gitConnected: null,
      fix: "npx vercel@latest git connect",
    });
    rmSync(join(root, ".vercel"), { recursive: true });
    write("vercel.json", "{}");
    const unlinked = await deployDoctor({
      repoRoot: root,
      runner: fakeRunner().runner,
    });
    expect(unlinked).toMatchObject({
      host: "vercel",
      project: null,
      gitConnected: null,
      fix: "vercel link && vercel git connect",
    });
  });

  it("treats a deploy workflow on push as deploying merges", async () => {
    linkVercel();
    write(
      ".github/workflows/deploy.yml",
      "on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - run: vercel deploy --prod\n",
    );
    const report = await deployDoctor({
      repoRoot: root,
      runner: fakeRunner({ link: null }).runner,
    });
    expect(report).toMatchObject({
      gitConnected: false,
      workflow: { path: ".github/workflows/deploy.yml", onPush: true },
      deploysOnMerge: true,
      fix: null,
    });
  });

  it("picks the app's project from a monorepo link", async () => {
    write(
      ".vercel/repo.json",
      JSON.stringify({
        orgId: TEAM,
        projects: [
          { id: "prj_other", name: "docs", directory: "apps/docs" },
          { id: PROJECT, name: "paradigma", directory: "apps/web" },
        ],
      }),
    );
    const report = await deployDoctor({
      repoRoot: root,
      appRoot: "apps/web",
      runner: fakeRunner({ link: null }).runner,
    });
    expect(report.project).toMatchObject({ id: PROJECT, orgId: TEAM });
    expect(report.gitConnected).toBe(false);
  });
});

describe("deployDoctor (other hosts)", () => {
  it("checks a Netlify site with the Netlify CLI", async () => {
    write(".netlify/state.json", JSON.stringify({ siteId: "site-1" }));
    write("netlify.toml", "[build]\n");
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      return result({
        stdout: JSON.stringify({ name: "acme", build_settings: {} }),
      });
    };
    const report = await deployDoctor({ repoRoot: root, runner });
    expect(report).toMatchObject({
      host: "netlify",
      project: { id: "site-1", name: "acme" },
      gitConnected: false,
      fix: "netlify init",
    });
    expect(calls[0]).toEqual([
      "netlify",
      "api",
      "getSite",
      "--data",
      '{"site_id":"site-1"}',
    ]);
  });

  it("prints Cloudflare guidance and the check command", async () => {
    write("wrangler.toml", 'name = "acme"\n');
    const report = await deployDoctor({
      repoRoot: root,
      runner: async () => result({ code: null, error: "ENOENT" }),
    });
    expect(report).toMatchObject({
      host: "cloudflare",
      gitConnected: null,
      cli: { name: "wrangler", available: false },
      checks: ["npx wrangler pages project list"],
    });
    expect(report.fixes[0]?.id).toBe("cloudflare_git_connect");
  });

  it("finds GitHub Pages from its workflow", async () => {
    write(
      ".github/workflows/pages.yml",
      "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - uses: actions/deploy-pages@v4\n",
    );
    const report = await deployDoctor({
      repoRoot: root,
      runner: fakeRunner().runner,
    });
    expect(report).toMatchObject({
      host: "github-pages",
      label: "GitHub Pages",
      deploysOnMerge: true,
      fix: null,
    });
  });

  it("stays silent on unknown hosts beyond generic guidance", async () => {
    const report = await deployDoctor({
      repoRoot: root,
      runner: fakeRunner().runner,
    });
    expect(report.host).toBeNull();
    expect(report.deploysOnMerge).toBeNull();
    expect(renderDeploy(report)[0]).toContain("host not detected");
  });
});

describe("paradigma doctor deploy", () => {
  it("prints the human report and exits 3 when merges do not deploy", async () => {
    linkVercel();
    const t = fakeIo({ cwd: root });
    await doctorDeployCommand(t.io, [], fakeRunner({ link: null }).runner);
    expect(t.stdout()).toBe(
      [
        "Deploy: Vercel (.vercel/project.json)",
        "✗ Vercel project paradigma is not connected to Git: merged PRs never reach the live site.",
        "  Fix: Connect the Vercel project to its GitHub repository so every merge deploys: vercel git connect",
        "  Or run: npx paradigma-cli doctor deploy --fix",
        "",
      ].join("\n"),
    );
    expect(process.exitCode).toBe(3);
  });

  it("prints JSON for agents and runs the fix only with --fix --yes", async () => {
    linkVercel();
    const fake = fakeRunner({ link: null, connects: true });
    const dry = fakeIo({ cwd: root });
    await doctorDeployCommand(dry.io, ["--json", "--fix"], fake.runner);
    expect(JSON.parse(dry.stdout())).toMatchObject({
      ok: true,
      host: "vercel",
      gitConnected: false,
      fixed: false,
      problem: "Pass --yes to run `vercel git connect`.",
    });
    expect(fake.calls.some((c) => c.args[0] === "git")).toBe(false);
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;

    const t = fakeIo({ cwd: root });
    await doctorDeployCommand(t.io, ["--json", "--fix", "--yes"], fake.runner);
    const report = JSON.parse(t.stdout());
    expect(report).toMatchObject({
      ok: true,
      gitConnected: true,
      deploysOnMerge: true,
      fixed: true,
      gitRepo: { repo: "acme/web", branch: "main" },
    });
    const connect = fake.calls.find((c) => c.args[0] === "git");
    expect(connect).toEqual({
      command: "vercel",
      args: ["git", "connect", "--yes", "--project", PROJECT, "--scope", TEAM],
      cwd: root,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("asks before running the fix in a terminal and reports failures without secrets", async () => {
    linkVercel();
    const fake = fakeRunner({ link: null, connects: false });
    const t = fakeIo({ cwd: root, interactive: true, answers: ["y"] });
    await doctorDeployCommand(t.io, ["--fix"], fake.runner);
    expect(t.stdout()).toContain("Running vercel git connect…");
    expect(t.stdout()).toContain(
      "! vercel git connect: Error: Failed to connect (token [redacted])",
    );
    expect(t.stdout()).not.toContain(TOKEN);
    expect(process.exitCode).toBe(3);
  });
});

it("redacts token-shaped strings from host CLI messages", () => {
  expect(safeMessage(`line 1\nError: bad ${TOKEN} here`)).toBe(
    "Error: bad [redacted] here",
  );
  expect(safeMessage("Authorization: Bearer abc.def")).toBe(
    "Authorization [redacted]",
  );
  expect(safeMessage(`project ${PROJECT}`)).toBe(`project ${PROJECT}`);
});
