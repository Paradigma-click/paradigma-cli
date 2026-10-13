// Opt-in: REAL_AGENT=claude|codex pnpm exec vitest run cli/src/real-agent.e2e.test.ts
// Drives the locally installed agent (customer-paid) against a throwaway repo.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
    appendFileSync(target, "export const title = '${MARKER}';\\n");
  }
  console.log("done");
}
`,
  );
  vi.stubEnv("PARADIGMA_AGENT_COMMAND", "");

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
  return runAutopilot({
    once: true,
    log: (l) => console.log("[run]", l),
    heartbeatMs: 5000,
    agent: process.env.REAL_AGENT as "claude" | "codex",
  });
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

describe.skipIf(!process.env.REAL_AGENT)(
  "real agent end to end",
  { timeout: 900_000 },
  () => {
    it("applies a metadata task with the real agent and opens a PR", async () => {
      const payload = task({
        mode: "pull_request",
        title: "Describe the site in the root layout metadata",
        instructions:
          "The root layout exports an empty metadata object. Set metadata.title to 'Acme Site — Fast static hosting' and metadata.description to a one-sentence description of a static hosting product (under 160 characters). Keep the file's existing style.",
        acceptance: [
          "app/layout.tsx exports metadata with a non-empty title",
          "app/layout.tsx exports metadata with a description under 160 characters",
          "No other files change",
        ],
      });
      state.queue = [signTask(payload)];
      writeFileSync(ghLog, "");
      const summary = await run();
      console.log("SUMMARY", JSON.stringify(summary));
      console.log("REPORTS", JSON.stringify(state.reports, null, 2));
      const branch = `paradigma/autopilot/${payload.taskId.slice(0, 8)}`;
      console.log("FILE", git(origin, "show", `${branch}:app/layout.tsx`));
      expect(reportsFor(payload.taskId).at(-1)?.status).toBe("pr_opened");
      expect(JSON.stringify(state.reports)).not.toContain(
        "Fast static hosting",
      );
      expectCleanWorktrees(payload.taskId);
    });
  },
);
