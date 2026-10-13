import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadConfig, saveConfig } from "./config";
import type {
  ReportRequest,
  SignedTask,
  TaskPayload,
} from "./contract/autopilot";
import { runAutopilot } from "./run";
import { REPO_ID, RUNNER_ID, taskPayload } from "./test/fixtures";
import { rotateTestSigningKey, signTask, testPublicKey } from "./test/signing";

const MARKER = "PARADIGMA_E2E_CONTENT_MARKER";
const TOKEN = `pdg_rt_${"t".repeat(43)}`;

let root: string;
let work: string;
let origin: string;
let server: Server;
let serverUrl: string;
let ghLog: string;

const state: {
  queue: SignedTask[];
  reports: ReportRequest[];
  heartbeats: string[][];
  cancel: string[];
  conflict: string[];
  authHeaders: string[];
} = {
  queue: [],
  reports: [],
  heartbeats: [],
  cancel: [],
  conflict: [],
  authHeaders: [],
};

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeScript(path: string, source: string) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function readBody(request: import("node:http").IncomingMessage) {
  return new Promise<unknown>((resolve) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => resolve(data ? JSON.parse(data) : undefined));
  });
}

beforeAll(async () => {
  rotateTestSigningKey();

  root = mkdtempSync(join(tmpdir(), "paradigma-e2e-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin);
  ghLog = join(root, "gh.log");

  vi.stubEnv("PARADIGMA_HOME", home);
  vi.stubEnv("GIT_AUTHOR_NAME", "Test");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "test@example.com");
  vi.stubEnv("GIT_COMMITTER_NAME", "Test");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "test@example.com");

  // Repository: bare origin, seeded with an app and a package.json.
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, work], { stdio: "pipe" });
  mkdirSync(join(work, "app"));
  writeFileSync(
    join(work, "app", "layout.tsx"),
    "export const metadata = {};\n",
  );
  writeFileSync(join(work, "package.json"), '{"name":"site","private":true}\n');
  writeFileSync(join(work, "README.md"), "# site\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", "init");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  // Looks like a GitHub clone; fetch/push are rewritten to the bare repo.
  git(work, "remote", "set-url", "origin", "https://github.com/acme/site.git");
  git(
    work,
    "config",
    `url.${origin}.insteadOf`,
    "https://github.com/acme/site.git",
  );

  // Agent: edits E2E_EDIT_PATH in edit mode, approves in review mode.
  const agent = join(root, "agent.mjs");
  writeScript(
    agent,
    `import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
const promptFile = process.argv.at(-1);
const prompt = readFileSync(promptFile, "utf8");
if (process.env.PARADIGMA_AGENT_MODE === "review") {
  console.log(JSON.stringify({ verdict: prompt.includes("${MARKER}") ? "approved" : "rejected", reasons: ["Meets the acceptance criteria"] }));
} else {
  const target = process.env.E2E_EDIT_PATH;
  if (process.env.E2E_SLEEP) await new Promise((r) => setTimeout(r, Number(process.env.E2E_SLEEP)));
  if (target) {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, (process.env.E2E_EDIT_LINE || "export const title = '${MARKER}';") + "\\n");
  }
  console.log("done");
}
`,
  );
  vi.stubEnv("PARADIGMA_AGENT_COMMAND", `${process.execPath} ${agent}`);

  // Fake gh on PATH.
  writeScript(
    join(bin, "gh"),
    `#!/bin/sh
echo "$@" >> "${ghLog}"
case "$1 $2" in
  "pr create") echo "https://github.com/acme/site/pull/42" ;;
  "pr merge") exit 0 ;;
  "pr view") printf '{"mergeCommit":{"oid":"%s"}}\\n' "$E2E_MERGE_SHA" ;;
  *) exit 1 ;;
esac
`,
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);

  server = createServer(async (request, response) => {
    const body = await readBody(request);
    state.authHeaders.push(String(request.headers.authorization ?? ""));
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`)
      return send(401, {});
    switch (`${request.method} ${request.url}`) {
      case "GET /api/autopilot/policy":
        return send(200, {
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
      case "POST /api/autopilot/claim": {
        const tasks = state.queue.splice(0);
        return send(
          200,
          tasks.length ? { tasks } : { tasks: [], reason: "no_tasks" },
        );
      }
      case "POST /api/autopilot/heartbeat": {
        const ids = (body as { taskIds: string[] }).taskIds;
        state.heartbeats.push(ids);
        if (ids.some((id) => state.conflict.includes(id))) return send(409, {});
        return send(200, {
          cancel: ids.filter((id) => state.cancel.includes(id)),
        });
      }
      case "POST /api/autopilot/report":
        state.reports.push(body as ReportRequest);
        return send(200, { ok: true });
      default:
        return send(404, {});
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await saveConfig({
    ...loadConfig(),
    server: serverUrl,
    runnerId: RUNNER_ID,
    token: TOKEN,
    publicKey: testPublicKey(),
    repos: { [REPO_ID]: work },
    checks: { [REPO_ID]: [`"${process.execPath}" -e "process.exit(0)"`] },
  });
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  vi.unstubAllEnvs();
  rotateTestSigningKey();
  if (root) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  state.queue = [];
  state.reports = [];
  state.heartbeats = [];
  state.cancel = [];
  state.conflict = [];
  vi.stubEnv("E2E_EDIT_PATH", "");
  vi.stubEnv("E2E_EDIT_LINE", "");
  vi.stubEnv("E2E_SLEEP", "");
});

let counter = 0;
function task(overrides: Partial<TaskPayload> = {}): TaskPayload {
  counter++;
  const id = String(counter).padStart(4, "0");
  return taskPayload({
    taskId: `aaaa${id}-0000-4000-8000-00000000${id}`,
    ...overrides,
  });
}

function run() {
  return runAutopilot({ once: true, log: () => {}, heartbeatMs: 100 });
}

function reportsFor(taskId: string) {
  return state.reports.filter((r) => r.taskId === taskId);
}

function expectCleanWorktrees(taskId: string) {
  const worktrees = join(process.env.PARADIGMA_HOME as string, "worktrees");
  expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
  expect(git(work, "worktree", "list")).not.toContain(taskId);
  expect(
    git(work, "branch", "--list", `paradigma/autopilot/${taskId.slice(0, 8)}`),
  ).toBe("");
}

describe("paradigma run (end to end)", { timeout: 60_000 }, () => {
  it("notify: saves the patch locally and reports metadata only", async () => {
    const payload = task({ mode: "notify" });
    const tampered = signTask(task({ mode: "notify" }));
    tampered.body = tampered.body.replace("app/**", "**");
    state.queue = [signTask(payload), tampered];
    vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");

    const summary = await run();

    expect(summary.outcomes).toEqual([
      expect.objectContaining({ taskId: payload.taskId, status: "notified" }),
    ]);
    const reports = reportsFor(payload.taskId);
    expect(reports.map((r) => r.status)).toEqual(["running", "notified"]);
    expect(reports[1].result).toMatchObject({
      agent: { name: "custom" },
      files: ["app/layout.tsx"],
      additions: 1,
      deletions: 0,
      checks: [expect.objectContaining({ status: "passed" })],
      // Agent-written reasons can quote code; only the verdict leaves.
      review: { verdict: "approved", reasons: [] },
    });
    expect(JSON.stringify(state.reports)).not.toContain(
      "Meets the acceptance criteria",
    );
    // Nothing from the repository content ever reaches the server.
    expect(JSON.stringify(state.reports)).not.toContain(MARKER);
    expect(JSON.stringify(state.reports)).not.toContain("export const");
    // The tampered task was ignored entirely.
    expect(state.reports.filter((r) => r.taskId !== payload.taskId)).toEqual(
      [],
    );

    const patch = readFileSync(
      join(
        process.env.PARADIGMA_HOME as string,
        "patches",
        `${payload.taskId}.patch`,
      ),
      "utf8",
    );
    expect(patch).toContain(`+export const title = '${MARKER}';`);
    expect(git(origin, "branch", "--list")).not.toContain("paradigma/");
    expect(state.authHeaders.every((h) => h === `Bearer ${TOKEN}`)).toBe(true);
    expectCleanWorktrees(payload.taskId);
  });

  it("pull_request: pushes the branch and opens a PR with gh", async () => {
    const payload = task({ mode: "pull_request" });
    state.queue = [signTask(payload)];
    vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");
    writeFileSync(ghLog, "");

    await run();

    const reports = reportsFor(payload.taskId);
    const branch = `paradigma/autopilot/${payload.taskId.slice(0, 8)}`;
    expect(reports.at(-1)).toMatchObject({
      status: "pr_opened",
      branch,
      prNumber: 42,
      prUrl: "https://github.com/acme/site/pull/42",
    });
    expect(JSON.stringify(state.reports)).not.toContain(MARKER);
    expect(git(origin, "branch", "--list", branch)).toContain(branch);
    const message = git(origin, "log", "-1", "--format=%B", branch);
    expect(message).toContain(`paradigma: ${payload.title}`);
    expect(message).toContain(`Paradigma-Task: ${payload.taskId}`);
    expect(git(origin, "show", `${branch}:app/layout.tsx`)).toContain(MARKER);
    const gh = readFileSync(ghLog, "utf8");
    expect(gh).toContain(
      `pr create --repo acme/site --base main --head ${branch}`,
    );
    expectCleanWorktrees(payload.taskId);
  });

  it("rejects edits outside the allowed paths before anything is pushed", async () => {
    const payload = task({ mode: "pull_request" });
    state.queue = [signTask(payload)];
    vi.stubEnv("E2E_EDIT_PATH", "lib/tracking.ts");

    await run();

    expect(reportsFor(payload.taskId).at(-1)).toMatchObject({
      status: "failed",
      result: { code: "guard:path_not_allowed" },
    });
    expect(
      git(
        origin,
        "branch",
        "--list",
        `paradigma/autopilot/${payload.taskId.slice(0, 8)}`,
      ),
    ).toBe("");
    expectCleanWorktrees(payload.taskId);
  });

  it("reports no_changes when the agent leaves the tree untouched", async () => {
    const payload = task();
    state.queue = [signTask(payload)];

    await run();

    expect(reportsFor(payload.taskId).at(-1)).toMatchObject({
      status: "skipped",
      result: { code: "no_changes" },
    });
    expectCleanWorktrees(payload.taskId);
  });

  it("stops the agent when the server cancels the task", async () => {
    const payload = task();
    state.queue = [signTask(payload)];
    state.cancel = [payload.taskId];
    vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");
    vi.stubEnv("E2E_SLEEP", "5000");

    const started = Date.now();
    await run();

    expect(Date.now() - started).toBeLessThan(4000);
    expect(state.heartbeats.length).toBeGreaterThan(0);
    expect(reportsFor(payload.taskId).at(-1)).toMatchObject({
      status: "skipped",
      result: { code: "cancelled" },
    });
    expectCleanWorktrees(payload.taskId);
  });

  it("auto_merge: requests a squash auto-merge for low-risk tasks", async () => {
    const payload = task({ mode: "auto_merge" });
    state.queue = [signTask(payload)];
    vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");
    writeFileSync(ghLog, "");

    await run();

    expect(reportsFor(payload.taskId).at(-1)).toMatchObject({
      status: "merge_requested",
      prNumber: 42,
    });
    expect(readFileSync(ghLog, "utf8")).toContain(
      "pr merge 42 --repo acme/site --auto --squash",
    );
    expectCleanWorktrees(payload.taskId);
  });

  describe("level 0 (full autopilot)", () => {
    const fullTask = (overrides: Partial<TaskPayload> = {}) =>
      task({
        mode: "auto_merge",
        level: 0,
        category: "content",
        risk: "medium",
        ...overrides,
      });

    async function withChecks(
      commands: string[],
      body: () => Promise<unknown>,
    ) {
      const previous = loadConfig().checks;
      await saveConfig({ ...loadConfig(), checks: { [REPO_ID]: commands } });
      try {
        await body();
      } finally {
        await saveConfig({ ...loadConfig(), checks: previous });
      }
    }

    function branchOf(payload: TaskPayload) {
      return `paradigma/autopilot/${payload.taskId.slice(0, 8)}`;
    }

    it("merges a medium-risk task through gh auto-merge, never with --admin", async () => {
      const payload = fullTask();
      state.queue = [signTask(payload)];
      vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");
      writeFileSync(ghLog, "");

      await run();

      expect(reportsFor(payload.taskId).at(-1)).toMatchObject({
        status: "merge_requested",
        prNumber: 42,
        result: {
          checks: [expect.objectContaining({ status: "passed" })],
          review: { verdict: "approved" },
        },
      });
      const gh = readFileSync(ghLog, "utf8");
      expect(gh).toContain("pr merge 42 --repo acme/site --auto --squash");
      expect(gh).not.toContain("--admin");
      expect(JSON.stringify(state.reports)).not.toContain(MARKER);
      expectCleanWorktrees(payload.taskId);
    });

    it("the same medium-risk task only opens a PR without level 0", async () => {
      const payload = fullTask({ level: 1 });
      state.queue = [signTask(payload)];
      vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");
      writeFileSync(ghLog, "");

      await run();

      expect(reportsFor(payload.taskId).at(-1)).toMatchObject({
        status: "pr_opened",
      });
      expect(readFileSync(ghLog, "utf8")).not.toContain("pr merge");
      expectCleanWorktrees(payload.taskId);
    });

    it("still blocks protected files before anything is pushed", async () => {
      const payload = fullTask({ allowedPaths: ["**"] });
      state.queue = [signTask(payload)];
      vi.stubEnv("E2E_EDIT_PATH", "package.json");
      writeFileSync(ghLog, "");

      await run();

      expect(reportsFor(payload.taskId).at(-1)).toMatchObject({
        status: "failed",
        result: { code: "guard:forbidden_path" },
      });
      expect(git(origin, "branch", "--list", branchOf(payload))).toBe("");
      expect(readFileSync(ghLog, "utf8")).toBe("");
      expectCleanWorktrees(payload.taskId);
    });

    it("still blocks secrets in the diff", async () => {
      const payload = fullTask();
      state.queue = [signTask(payload)];
      vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");
      vi.stubEnv("E2E_EDIT_LINE", `const key = "AKIA${"Q".repeat(16)}";`);
      writeFileSync(ghLog, "");

      await run();

      expect(reportsFor(payload.taskId).at(-1)).toMatchObject({
        status: "failed",
        result: { code: "guard:secret_detected" },
      });
      expect(JSON.stringify(state.reports)).not.toContain("AKIA");
      expect(git(origin, "branch", "--list", branchOf(payload))).toBe("");
      expect(readFileSync(ghLog, "utf8")).toBe("");
      expectCleanWorktrees(payload.taskId);
    });

    it("still stops when the repository checks fail", async () => {
      const check = join(root, "check-marker.mjs");
      writeFileSync(
        check,
        `import { readFileSync } from "node:fs";
process.exit(readFileSync("app/layout.tsx", "utf8").includes("${MARKER}") ? 1 : 0);
`,
      );
      const payload = fullTask();
      state.queue = [signTask(payload)];
      vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");
      writeFileSync(ghLog, "");

      await withChecks([`"${process.execPath}" "${check}"`], run);

      expect(reportsFor(payload.taskId).at(-1)).toMatchObject({
        status: "failed",
        result: { code: "checks_failed" },
      });
      expect(git(origin, "branch", "--list", branchOf(payload))).toBe("");
      expect(readFileSync(ghLog, "utf8")).toBe("");
      expectCleanWorktrees(payload.taskId);
    });

    it("opens a PR instead of merging when a check was only skipped", async () => {
      const payload = fullTask();
      state.queue = [signTask(payload)];
      vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");
      writeFileSync(ghLog, "");

      // Fails on the base commit too, so the runner marks it skipped.
      await withChecks([`"${process.execPath}" -e "process.exit(1)"`], run);

      const last = reportsFor(payload.taskId).at(-1);
      expect(last).toMatchObject({ status: "pr_opened" });
      expect(last?.result?.checks).toEqual([
        expect.objectContaining({ status: "skipped" }),
      ]);
      expect(readFileSync(ghLog, "utf8")).not.toContain("pr merge");
      expectCleanWorktrees(payload.taskId);
    });
  });

  it("revert: reverts the merge commit of the PR without asking the agent", async () => {
    writeFileSync(
      join(work, "app", "layout.tsx"),
      "export const metadata = { robots: 'noindex' };\n",
    );
    git(
      work,
      "commit",
      "--quiet",
      "--no-verify",
      "--no-gpg-sign",
      "-am",
      "regression (#7)",
    );
    git(work, "push", "--quiet", "origin", "HEAD:main");
    vi.stubEnv("E2E_MERGE_SHA", git(work, "rev-parse", "HEAD"));
    vi.stubEnv("E2E_EDIT_PATH", "app/should-not-exist.tsx");
    const payload = task({
      mode: "pull_request",
      category: "revert",
      revertsPrNumber: 7,
      title: "Revert #7",
    });
    state.queue = [signTask(payload)];

    await run();

    const last = reportsFor(payload.taskId).at(-1);
    expect(last).toMatchObject({
      status: "pr_opened",
      result: { files: ["app/layout.tsx"] },
    });
    expect(last?.result?.review).toBeUndefined();
    const branch = `paradigma/autopilot/${payload.taskId.slice(0, 8)}`;
    expect(git(origin, "show", `${branch}:app/layout.tsx`)).toBe(
      "export const metadata = {};",
    );
    expectCleanWorktrees(payload.taskId);
  });

  it("stops and cleans up when the heartbeat reports a lost lease (409)", async () => {
    const payload = task();
    state.queue = [signTask(payload)];
    state.conflict = [payload.taskId];
    vi.stubEnv("E2E_EDIT_PATH", "app/layout.tsx");
    vi.stubEnv("E2E_SLEEP", "5000");

    const summary = await run();

    expect(summary.outcomes).toEqual([
      { taskId: payload.taskId, status: "skipped", code: "lease_lost" },
    ]);
    expect(reportsFor(payload.taskId).map((r) => r.status)).toEqual([
      "running",
    ]);
    expectCleanWorktrees(payload.taskId);
  });
});
