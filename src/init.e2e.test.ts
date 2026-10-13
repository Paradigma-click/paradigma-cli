import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadConfig } from "./config";
import { initCommand } from "./init";
import { ActionRequired } from "./io";
import { fakeIo, fakeServer } from "./test/platform";

const SERVER = "https://app.paradigma.test";
const SETUP_TOKEN = `pdg_setup_${"S".repeat(43)}`;
const RUNNER_TOKEN = `pdg_rt_${"R".repeat(43)}`;
const RUNNER_ID = "66666666-6666-4666-8666-666666666666";
const REPO = "33333333-3333-4333-8333-333333333333";
const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const VERIFY_CONTENTS = "paradigma-verification=tok123";
const FILE = "public/.well-known/paradigma-verification.txt";

let root: string;
let work: string;
let origin: string;
let stateDir: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function script(path: string, source: string) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

const server = {
  installed: false,
  projectId: null as string | null,
  verified: false,
  exchanged: 0,
};

function api() {
  return fakeServer({
    "POST /api/cli/v1/setup/exchange": (call) => {
      if (
        (call.body as { token?: string }).token !== SETUP_TOKEN ||
        server.exchanged++ > 0
      )
        return { status: 401, body: { error: "invalid_token" } };
      return {
        body: {
          runnerId: RUNNER_ID,
          runnerToken: RUNNER_TOKEN,
          publicKey: "p".repeat(43),
          server: SERVER,
        },
      };
    },
    "GET /api/cli/v1/status": () => ({
      body: {
        ready: server.installed && Boolean(server.projectId) && server.verified,
        next: null,
        steps: [],
        project: null,
        links: {
          installApp: "https://github.com/apps/paradigma/installations/new",
          searchConsole: server.verified
            ? `${SERVER}/dashboard/sites/${PROJECT}/connect/gsc`
            : null,
        },
        server: SERVER,
        mcpUrl: `${SERVER}/api/mcp`,
      },
    }),
    "GET /api/cli/v1/targets": () => {
      // The person installs the app while init waits.
      const visible = server.installed;
      server.installed = true;
      return {
        body: {
          repositories: visible
            ? [
                {
                  repoId: REPO,
                  orgId: ORG,
                  owner: "acme",
                  name: "web",
                  fullName: "acme/web",
                  enabled: true,
                  apps: [
                    {
                      appRoot: "",
                      router: "app",
                      projectId: server.projectId,
                      productionUrl: server.projectId
                        ? "https://acme.test"
                        : null,
                      verified: server.projectId ? server.verified : null,
                    },
                  ],
                },
              ]
            : [],
          installGithubAppUrl:
            "https://github.com/apps/paradigma/installations/new",
        },
      };
    },
    "POST /api/cli/v1/projects": () => {
      server.projectId = PROJECT;
      return {
        body: {
          projectId: PROJECT,
          created: true,
          verified: false,
          verification: null,
        },
      };
    },
    [`POST /api/cli/v1/projects/${PROJECT}/verify`]: () => ({
      body: {
        projectId: PROJECT,
        verified: server.verified,
        method: server.verified ? "file" : null,
        attempts: server.verified
          ? []
          : [{ method: "dns", ok: false, reason: "TXT record not found" }],
        instructions: server.verified
          ? null
          : {
              dns: { name: "_paradigma.acme.test", value: VERIFY_CONTENTS },
              file: {
                path: "/.well-known/paradigma-verification.txt",
                url: "https://acme.test/.well-known/paradigma-verification.txt",
                contents: VERIFY_CONTENTS,
                repoPath: FILE,
              },
              meta: { tag: "<meta>", nextjsMetadata: "" },
            },
      },
    }),
  });
}

function env(extra: Record<string, string> = {}) {
  const next: Record<string, string | undefined> = { ...process.env, ...extra };
  delete next.CLAUDECODE;
  delete next.CLAUDE_CODE_ENTRYPOINT;
  return next;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "paradigma-init-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  stateDir = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(stateDir);

  vi.stubEnv("HOME", join(root, "userhome"));
  vi.stubEnv("GIT_AUTHOR_NAME", "Test");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "test@example.com");
  vi.stubEnv("GIT_COMMITTER_NAME", "Test");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "test@example.com");
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("FAKE_STATE", stateDir);

  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, work], { stdio: "pipe" });
  mkdirSync(join(work, "app"));
  writeFileSync(
    join(work, "app", "layout.tsx"),
    'export const metadata = { metadataBase: new URL("https://acme.test"), title: "Acme" };\n',
  );
  writeFileSync(
    join(work, "package.json"),
    '{"name":"acme-web","private":true,"description":"Analytics for founders"}\n',
  );
  git(work, "add", ".");
  git(work, "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", "init");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(work, "remote", "set-url", "origin", "https://github.com/acme/web.git");
  git(
    work,
    "config",
    `url.${origin}.insteadOf`,
    "https://github.com/acme/web.git",
  );

  // Fake gh: logs argv; PRs are remembered in the state directory.
  script(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "$FAKE_STATE/gh.log"
case "$1 $2" in
  "auth status") exit \${FAKE_GH_AUTH:-0} ;;
  "pr list") [ -f "$FAKE_STATE/pr" ] && cat "$FAKE_STATE/pr"; exit 0 ;;
  "pr create") echo "https://github.com/acme/web/pull/7" > "$FAKE_STATE/pr"; echo "https://github.com/acme/web/pull/7"; exit 0 ;;
  "repo view") echo main; exit 0 ;;
esac
exit 1
`,
  );
  // Fake Claude Code: version, and an MCP registry in the state directory.
  script(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi
if [ "$1 $2" = "mcp get" ]; then [ -f "$FAKE_STATE/claude-mcp" ] && cat "$FAKE_STATE/claude-mcp" && exit 0; exit 1; fi
if [ "$1 $2" = "mcp add" ]; then echo "$*" > "$FAKE_STATE/claude-mcp"; exit 0; fi
exit 1
`,
  );
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("PARADIGMA_HOME", mkdtempSync(join(root, "home-")));
  Object.assign(server, {
    installed: false,
    projectId: null,
    verified: false,
    exchanged: 0,
  });
  for (const name of ["pr", "claude-mcp", "gh.log"])
    rmSync(join(stateDir, name), { force: true });
});
afterEach(() => {
  process.exitCode = undefined;
});

describe("paradigma init", () => {
  it("runs the whole flow for an agent and resumes idempotently", async () => {
    const fake = api();
    const t = fakeIo({ fetch: fake.fetch, cwd: work, env: env() });
    const args = [
      "--token",
      SETUP_TOKEN,
      "--server",
      SERVER,
      "--json",
      "--yes",
      "--category",
      "Analytics software",
      "--use-case",
      "Track product usage",
      "--mcp",
      "claude",
    ];
    await initCommand(t.io, args);

    const events = t.events();
    const steps = events
      .filter((e) => e.event === "step")
      .map((e) => `${e.step}:${e.status}`);
    expect(steps).toEqual([
      "auth:done",
      "repository:done",
      "github_app:action_required",
      "github_app:done",
      "project:done",
      "domain:action_required",
      "mcp:done",
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({
      event: "done",
      ready: false,
      projectId: PROJECT,
      verified: false,
    });

    // Credential saved; the setup token went only to the exchange body.
    const config = loadConfig();
    expect(config).toMatchObject({
      token: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      defaultProjectId: PROJECT,
    });
    expect(t.stdout() + t.stderr()).not.toContain(SETUP_TOKEN);
    const exchange = fake.calls.find((c) => c.path.endsWith("/setup/exchange"));
    expect(exchange?.authorization).toBeNull();
    expect(exchange?.body).toMatchObject({
      token: SETUP_TOKEN,
      runnerName: expect.stringContaining(" on "),
      agents: expect.arrayContaining([{ name: "claude", version: "2.1.0" }]),
    });
    for (const call of fake.calls.filter(
      (c) => !c.path.endsWith("/setup/exchange"),
    ))
      expect(call.authorization).toBe(`Bearer ${RUNNER_TOKEN}`);

    // Project inferred from the repo (metadataBase + title) plus agent flags.
    expect(
      fake.calls.find(
        (c) => c.method === "POST" && c.path === "/api/cli/v1/projects",
      )?.body,
    ).toMatchObject({
      repoId: REPO,
      appRoot: "",
      config: {
        productionUrl: "https://acme.test",
        brandName: "Acme",
        category: "Analytics software",
        useCase: "Track product usage",
      },
    });

    // Verification file pushed on a branch with a PR; the checkout is untouched.
    const domain = events.find((e) => e.step === "domain");
    expect(domain).toMatchObject({
      file: {
        mode: "pr",
        url: "https://github.com/acme/web/pull/7",
        created: true,
      },
      reverify: `npx paradigma-cli verify --project ${PROJECT}`,
    });
    expect(git(origin, "show", `paradigma/domain-verification:${FILE}`)).toBe(
      VERIFY_CONTENTS,
    );
    expect(existsSync(join(work, FILE))).toBe(false);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(stateDir, "gh.log"), "utf8")).toContain(
      "pr create --repo acme/web --base main --head paradigma/domain-verification",
    );

    // MCP added through Claude Code's own command.
    expect(readFileSync(join(stateDir, "claude-mcp"), "utf8").trim()).toBe(
      `mcp add --transport http paradigma ${SERVER}/api/mcp`,
    );

    // Rerun with the same (now spent) token: nothing is created twice.
    const rerun = fakeIo({ fetch: fake.fetch, cwd: work, env: env() });
    await initCommand(rerun.io, args);
    const rerunEvents = rerun.events();
    expect(rerunEvents.find((e) => e.step === "auth")).toMatchObject({
      method: "saved_credential",
    });
    expect(rerunEvents.find((e) => e.step === "project")).toMatchObject({
      created: false,
    });
    expect(rerunEvents.find((e) => e.step === "domain")).toMatchObject({
      file: { mode: "pr", created: false },
    });
    expect(rerunEvents.find((e) => e.step === "mcp")).toMatchObject({
      status: "done",
      result: "already_configured",
    });
    expect(
      fake.calls.filter(
        (c) => c.method === "POST" && c.path === "/api/cli/v1/projects",
      ),
    ).toHaveLength(1);

    // After the deploy, verification succeeds and init reports ready.
    server.verified = true;
    const final = fakeIo({ fetch: fake.fetch, cwd: work, env: env() });
    await initCommand(final.io, ["--json", "--mcp", "none"]);
    expect(final.events().at(-1)).toMatchObject({
      event: "done",
      ready: true,
      verified: true,
    });
  });

  it("asks for missing fields with inferred candidates instead of guessing", async () => {
    server.installed = true;
    const fake = api();
    const t = fakeIo({ fetch: fake.fetch, cwd: work, env: env() });
    const error = await initCommand(t.io, [
      "--token",
      SETUP_TOKEN,
      "--server",
      SERVER,
      "--json",
    ]).catch((e: Error) => e);
    expect(error).toBeInstanceOf(ActionRequired);
    const needs = t.events().find((e) => e.event === "needs_input") as {
      fields: { flag: string; candidates: { value: string }[] }[];
    };
    expect(needs.fields.map((f) => f.flag)).toEqual([
      "--url",
      "--brand",
      "--category",
      "--use-case",
    ]);
    expect(needs.fields[0].candidates[0].value).toBe("https://acme.test");
    expect(needs.fields[3].candidates[0].value).toBe("Analytics for founders");
    expect(
      fake.calls.some(
        (c) => c.method === "POST" && c.path === "/api/cli/v1/projects",
      ),
    ).toBe(false);
  });

  it("leaves the file in the checkout when gh is unavailable", async () => {
    vi.stubEnv("FAKE_GH_AUTH", "1");
    try {
      server.installed = true;
      server.projectId = PROJECT;
      const fake = api();
      const t = fakeIo({
        fetch: fake.fetch,
        cwd: join(work, "app"),
        env: env(),
      });
      await initCommand(t.io, [
        "--token",
        SETUP_TOKEN,
        "--server",
        SERVER,
        "--mcp",
        "none",
      ]);
      expect(readFileSync(join(work, FILE), "utf8").trim()).toBe(
        VERIFY_CONTENTS,
      );
      expect(t.stdout()).toContain(`Wrote ${join(realpathSync(work), FILE)}`);
      expect(t.stdout()).toContain(
        `npx paradigma-cli verify --project ${PROJECT}`,
      );
      expect(t.stdout()).not.toContain(SETUP_TOKEN);
    } finally {
      rmSync(join(work, "public"), { recursive: true, force: true });
    }
  });

  it("times out waiting for the GitHub App with the install link", async () => {
    const base = api();
    const t = fakeIo({
      fetch: async (input, init) => {
        if (String(input).includes("/targets"))
          return new Response(
            JSON.stringify({
              repositories: [],
              installGithubAppUrl:
                "https://github.com/apps/paradigma/installations/new",
            }),
          );
        return base.fetch(input, init);
      },
      cwd: work,
      env: env(),
    });
    const error = await initCommand(t.io, [
      "--token",
      SETUP_TOKEN,
      "--server",
      SERVER,
      "--wait",
      "30",
    ]).catch((e: Error) => e);
    expect(error).toBeInstanceOf(ActionRequired);
    expect((error as Error).message).toContain("not installed on acme/web");
    expect(t.stdout()).toContain(
      "https://github.com/apps/paradigma/installations/new",
    );
  });

  it("rejects a malformed token without echoing it", async () => {
    const t = fakeIo({ fetch: api().fetch, cwd: work, env: env() });
    const bad = "sk-live-not-a-setup-token-123";
    const error = await initCommand(t.io, ["--token", bad]).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toContain("not a Paradigma setup token");
    expect((error as Error).message).not.toContain(bad);
  });
});
