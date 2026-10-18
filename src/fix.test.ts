import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionTaskResponse } from "./contract/fix-action";
import { SECRET_FILE_GLOBS } from "./contract/guards";
import { type ExecOptions, run } from "./exec";
import {
  buildEnv,
  fixCommand,
  modelAccessFor,
  modelReason,
  runFix,
} from "./fix-command";
import { parseNumstatZ } from "./fix-github";
import { checkFixEdit, lineChanges } from "./fix-limits";
import {
  fixModelKey,
  maskCommand,
  modelErrorCategory,
  proxyErrorCategory,
} from "./fix-model";
import { FixWorkspace } from "./fix-tools";
import type { Io } from "./io";

const TASK_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "pdg_fx_eyJ2IjoxfQ.c2ln";
const SERVER = "https://paradigma.test";
const SECRET_LINE = "OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'";

const caps = {
  maxTurns: 8,
  maxInputTokens: 150_000,
  maxOutputTokens: 15_000,
  maxOutputPerTurn: 8_000,
  maxReadBytes: 64 * 1024,
  maxWriteChars: 256 * 1024,
  maxList: 500,
  maxMatches: 100,
};

const brief = {
  v: 1 as const,
  taskId: TASK_ID,
  framework: { id: "static" as const, label: "Plain HTML" },
  playbook: null,
  acceptance: [],
  evidence: [],
  untrusted: { nonce: "abcdefabcdef12", note: "data", blocks: [] },
  tools: {
    checkHtml: { path: "/api/autopilot/action/check", maxHtmlBytes: 2_097_152 },
  },
};

function task(overrides: Partial<ActionTaskResponse> = {}): ActionTaskResponse {
  return {
    v: 1,
    taskId: TASK_ID,
    repo: { fullName: "acme/site", defaultBranch: "main", appRoot: "" },
    title: "Add a meta description",
    category: "metadata",
    branch: `paradigma/fix-${TASK_ID}`,
    draft: false,
    pr: {
      title: "Add a meta description",
      body: "Paradigma fix",
      commitMessage: `Add a meta description\n\nParadigma-Task: ${TASK_ID}`,
    },
    allowedPaths: ["index.html", "public/**"],
    diffBudget: { maxFiles: 2, maxLines: 10 },
    secretGlobs: [...SECRET_FILE_GLOBS],
    system: "You are the Paradigma fix agent.",
    prompt: "Fix the description.",
    retryPrompt: "The check failed:\n{feedback}",
    brief,
    tools: [
      {
        name: "read_file",
        description: "Read",
        inputSchema: { $schema: "x", type: "object" },
      },
      {
        name: "write_file",
        description: "Write",
        inputSchema: { type: "object" },
      },
      {
        name: "finish_task",
        description: "Finish",
        inputSchema: { type: "object" },
      },
    ],
    caps,
    models: {
      anthropic: "claude-sonnet-5-5",
      openrouter: "anthropic/claude-sonnet-5.5",
    },
    needsBuild: false,
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "paradigma-fix-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const BASE_HTML = "<html>\n<head>\n<title>Acme</title>\n</head>\n</html>\n";
const FIXED_HTML =
  '<html>\n<head>\n<title>Acme</title>\n<meta name="description" content="Acme widgets">\n</head>\n</html>\n';

async function gitRepo(files: Record<string, string>) {
  const root = tempRepo(files);
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
    });
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  return root;
}

function workspace(root: string, overrides: Partial<ActionTaskResponse> = {}) {
  const t = task(overrides);
  return new FixWorkspace(
    root,
    {
      allowedPaths: t.allowedPaths,
      diffBudget: t.diffBudget,
      secretGlobs: t.secretGlobs,
      category: t.category,
    },
    t.caps,
    t.brief,
    async () => ({ passed: true }),
  );
}

describe("fix limits", () => {
  it("counts lines like a pull request", () => {
    expect(lineChanges("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("refuses forbidden, secret, out-of-scope, oversized and secret-bearing edits", () => {
    const limits = {
      allowedPaths: ["**"],
      diffBudget: { maxFiles: 3, maxLines: 4 },
      secretGlobs: [...SECRET_FILE_GLOBS],
      category: "metadata",
    };
    const edit = (path: string, content: string, before?: string) =>
      checkFixEdit(
        new Map([[path, before]]),
        new Map([[path, content]]),
        limits,
      );
    expect(edit("package.json", "{}")).toMatchObject({
      ok: false,
      reason: "forbidden_path",
    });
    expect(edit("config/.env.local", "A=1")).toMatchObject({
      ok: false,
      reason: "forbidden_path",
    });
    expect(edit("keys/server.pem", "x")).toMatchObject({
      ok: false,
      reason: "secret_file",
    });
    expect(edit("a.txt", "1\n2\n3\n4\n5\n")).toMatchObject({
      ok: false,
      reason: "too_many_lines",
    });
    expect(edit("a.txt", SECRET_LINE)).toMatchObject({
      ok: false,
      reason: "secret_detected",
    });
    expect(
      checkFixEdit(
        new Map([["new.html", undefined]]),
        new Map([["new.html", "x"]]),
        {
          ...limits,
          category: "policy_cleanup",
        },
      ),
    ).toMatchObject({ ok: false, reason: "cleanup_scope" });
    expect(edit("a.txt", "fine", "old")).toMatchObject({ ok: true, lines: 2 });
  });
});

describe("FixWorkspace", () => {
  it("never lists or reads secret files, .git or node_modules", async () => {
    const root = tempRepo({
      "index.html": BASE_HTML,
      ".env": "SECRET=1",
      "node_modules/x/index.js": "x",
      ".git/config": "[core]",
      "public/robots.txt": "User-agent: *",
    });
    const ws = workspace(root);
    expect((await ws.list_files({})).files).toEqual([
      "index.html",
      "public/robots.txt",
    ]);
    expect(await ws.read_file({ path: ".env" })).toMatchObject({ ok: false });
    expect(await ws.read_file({ path: "../etc/passwd" })).toMatchObject({
      ok: false,
    });
    expect(await ws.read_file({ path: "index.html" })).toMatchObject({
      ok: true,
      totalLines: 6,
    });
    expect((await ws.search({ query: "User-agent" })).matches).toEqual([
      { path: "public/robots.txt", line: 1, text: "User-agent: *" },
    ]);
  });

  it("refuses writes outside the limits and keeps the disk untouched", async () => {
    const root = tempRepo({ "index.html": BASE_HTML, "about.html": "x" });
    const ws = workspace(root);
    expect(
      await ws.write_file({ path: "about.html", content: "y" }),
    ).toMatchObject({
      ok: false,
      reason: "path_not_allowed",
    });
    expect(
      await ws.write_file({ path: "public/.env", content: "A=1" }),
    ).toMatchObject({
      ok: false,
      reason: "forbidden_path",
    });
    expect(
      await ws.write_file({
        path: "index.html",
        content: `${BASE_HTML}${"x\n".repeat(20)}`,
      }),
    ).toMatchObject({ ok: false, reason: "too_many_lines" });
    expect(
      await ws.write_file({ path: "public/key.js", content: SECRET_LINE }),
    ).toMatchObject({ ok: false, reason: "secret_detected" });
    expect(readFileSync(join(root, "about.html"), "utf8")).toBe("x");
    expect(ws.rejected).toHaveLength(4);
    const ok = await ws.write_file({ path: "index.html", content: FIXED_HTML });
    expect(ok).toMatchObject({ ok: true, additions: 1, deletions: 0 });
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(FIXED_HTML);
    expect(ws.changedFiles()).toEqual([
      { path: "index.html", content: FIXED_HTML },
    ]);
  });

  it("never follows a symlink out of the repository", async () => {
    const outside = tempRepo({ "secret.txt": "outside" });
    const root = tempRepo({ "index.html": BASE_HTML });
    symlinkSync(outside, join(root, "public"));
    const ws = workspace(root);
    expect(await ws.read_file({ path: "public/secret.txt" })).toMatchObject({
      ok: false,
    });
    expect(
      await ws.write_file({ path: "public/x.txt", content: "y" }),
    ).toMatchObject({
      ok: false,
    });
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
  });
});

describe("helpers", () => {
  it("parses numstat -z and picks the key Anthropic first", () => {
    expect(parseNumstatZ("1\t0\tindex.html\0-\t-\tlogo.png\0")).toEqual([
      { path: "index.html", additions: 1, deletions: 0 },
      { path: "logo.png", additions: 1, deletions: 1 },
    ]);
    expect(
      fixModelKey({ OPENROUTER_API_KEY: "o", ANTHROPIC_API_KEY: "a" }),
    ).toEqual({
      provider: "anthropic",
      key: "a",
    });
    expect(fixModelKey({ OPENROUTER_API_KEY: " o " })).toEqual({
      provider: "openrouter",
      key: "o",
    });
    expect(fixModelKey({})).toBeNull();
    expect(modelErrorCategory(401)).toBe("no_model_key");
    expect(modelErrorCategory(429)).toBe("rate_limited");
    expect(modelErrorCategory(500)).toBe("provider_error");
  });

  it("hides model keys and tokens from the build", () => {
    expect(
      buildEnv({
        PATH: "/bin",
        ANTHROPIC_API_KEY: "k",
        GITHUB_TOKEN: "t",
        PARADIGMA_FIX_TASK: "x",
      }),
    ).toEqual({ PATH: "/bin" });
  });
});

// ─── End to end with fakes ──────────────────────────────────────────────────

type ModelStep = { calls: { name: string; input: unknown }[] };

interface Harness {
  requests: { url: string; body: unknown; headers: Record<string, string> }[];
  reports: Record<string, unknown>[];
  checks: Record<string, unknown>[];
  execs: { command: string; args: string[]; env?: ExecOptions["env"] }[];
  stdout: string[];
  stderr: string[];
  /** stdout lines already written when the first model call went out. */
  stdoutAtFirstModel: number | null;
}

function harness(input: {
  root: string;
  task?: ActionTaskResponse;
  steps: ModelStep[];
  provider?: "anthropic" | "openrouter";
  env?: Record<string, string>;
  checkPassed?: (index: number) => boolean;
  prStatus?: number;
  buildCode?: number;
  taskStatus?: number;
  /** The model proxy answers this error instead of a turn. */
  proxyError?: { status: number; error: string };
}) {
  const h: Harness = {
    requests: [],
    reports: [],
    checks: [],
    execs: [],
    stdout: [],
    stderr: [],
    stdoutAtFirstModel: null,
  };
  let step = 0;
  let checkIndex = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchFake = async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const isModel =
      url.includes("anthropic.test") ||
      url.includes("openrouter.test") ||
      url.endsWith("/api/autopilot/action/model");
    if (isModel && h.stdoutAtFirstModel === null)
      h.stdoutAtFirstModel = h.stdout.length;
    h.requests.push({
      url,
      body,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    if (url === `${SERVER}/api/autopilot/action/task`)
      return input.taskStatus
        ? json({ error: "x" }, input.taskStatus)
        : json(input.task ?? task());
    if (url === `${SERVER}/api/autopilot/action/check`) {
      h.checks.push(body);
      const passed = input.checkPassed ? input.checkPassed(checkIndex++) : true;
      return json({
        mode: body.files ? "static" : "html",
        passed,
        results: [
          {
            id: "metadata.description",
            status: passed ? "pass" : "fail",
            checks: "Description",
            summary: passed ? "Present" : "Missing",
            evidence: [],
          },
        ],
        feedback: passed ? [] : ["The description is missing."],
      });
    }
    if (url === `${SERVER}/api/autopilot/action/report`) {
      h.reports.push(body);
      return json({ ok: true });
    }
    if (url === `${SERVER}/api/autopilot/action/model`) {
      if (input.proxyError)
        return json({ error: input.proxyError.error }, input.proxyError.status);
      const current = input.steps[step++] ?? { calls: [] };
      return json({
        model: "anthropic/claude-sonnet-5.5",
        text: "",
        toolCalls: current.calls.map((call, i) => ({
          id: `px_${step}_${i}`,
          name: call.name,
          input: call.input,
        })),
        usage: { input: 800, output: 80 },
      });
    }
    if (url === "https://api.anthropic.test/v1/messages") {
      const current = input.steps[step++] ?? { calls: [] };
      return json({
        content: [
          { type: "text", text: "working" },
          ...current.calls.map((call, i) => ({
            type: "tool_use",
            id: `tu_${step}_${i}`,
            name: call.name,
            input: call.input,
          })),
        ],
        usage: { input_tokens: 1000, output_tokens: 100 },
      });
    }
    if (url === "https://openrouter.test/chat/completions") {
      const current = input.steps[step++] ?? { calls: [] };
      return json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: current.calls.map((call, i) => ({
                id: `call_${step}_${i}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 90 },
      });
    }
    if (url === "https://api.github.test/repos/acme/site/pulls") {
      const status = input.prStatus ?? 201;
      return status === 201
        ? json(
            { html_url: "https://github.com/acme/site/pull/7", number: 7 },
            201,
          )
        : json({ message: "nope" }, status);
    }
    return json({ error: "unexpected" }, 500);
  };
  const exec = async (
    command: string,
    args: string[],
    options: ExecOptions = {},
  ) => {
    h.execs.push({ command, args, env: options.env });
    if (command === "bash")
      return {
        code: input.buildCode ?? 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: false,
        durationMs: 12,
      };
    if (command === "git" && args.includes("push"))
      return {
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: false,
        durationMs: 1,
      };
    return run(command, args, options);
  };
  const keyEnv =
    input.provider === "openrouter"
      ? { OPENROUTER_API_KEY: "or-key" }
      : input.provider === undefined
        ? { ANTHROPIC_API_KEY: "ant-key" }
        : {};
  const io: Io = {
    stdout: (text) => h.stdout.push(text),
    stderr: (text) => h.stderr.push(text),
    env: {
      GITHUB_REPOSITORY: "acme/site",
      GITHUB_TOKEN: "ghs_workflowtoken",
      GITHUB_API_URL: "https://api.github.test",
      ...keyEnv,
      ...input.env,
    },
    cwd: input.root,
    interactive: false,
    stdinIsTTY: false,
    readStdin: async () => "",
    ask: async () => "",
    askHidden: async () => "",
    openUrl: () => {},
    sleep: async () => {},
    now: () => 0,
  };
  const deps = {
    io,
    fetch: fetchFake,
    exec,
    root: input.root,
    sleep: async () => {},
    providerUrls: {
      anthropicUrl: "https://api.anthropic.test",
      openrouterUrl: "https://openrouter.test",
    },
  };
  return { h, deps, io };
}

const FIX_STEPS: ModelStep[] = [
  { calls: [{ name: "read_file", input: { path: "index.html" } }] },
  {
    calls: [
      {
        name: "write_file",
        input: { path: "index.html", content: FIXED_HTML },
      },
    ],
  },
  { calls: [{ name: "check_html", input: {} }] },
  {
    calls: [
      { name: "finish_task", input: { outcome: "fixed", reason: "Added it." } },
    ],
  },
];

const OPTIONS = { token: TOKEN, server: SERVER, build: null, test: null };

function noContents(h: Harness) {
  const report = JSON.stringify(h.reports);
  expect(report).not.toContain("Acme widgets");
  expect(report).not.toContain("<meta");
  expect(report).not.toContain("ant-key");
}

describe("runFix", () => {
  it("fixes, commits to the task branch, opens the PR and reports metadata only", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({ root, steps: FIX_STEPS });
    const result = await runFix(deps, OPTIONS);
    expect(result).toMatchObject({
      outcome: "pr_opened",
      prUrl: "https://github.com/acme/site/pull/7",
      reported: true,
    });
    // The server check got the changed file; the final one is marked final.
    expect(h.checks.at(-1)).toEqual({
      files: [{ path: "index.html", content: FIXED_HTML }],
      final: true,
    });
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      outcome: "pr_opened",
      reason: null,
      agentOutcome: "fixed",
      prUrl: "https://github.com/acme/site/pull/7",
      changedPaths: ["index.html"],
      lines: 1,
      model: "claude-sonnet-5-5",
      tokens: { input: 4000, output: 400 },
    });
    expect(h.reports[0].sha).toMatch(/^[0-9a-f]{40}$/);
    noContents(h);
    // Every call to Paradigma carried the task token; the model got the tool schemas.
    for (const request of h.requests.filter((r) => r.url.startsWith(SERVER)))
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const model = h.requests.find((r) => r.url.includes("anthropic"))?.body as {
      tools: { input_schema: Record<string, unknown> }[];
      system: string;
    };
    expect(model.system).toBe("You are the Paradigma fix agent.");
    expect(model.tools[0].input_schema).toEqual({ type: "object" });
    const pr = h.requests.find((r) => r.url.endsWith("/pulls"))?.body;
    expect(pr).toMatchObject({
      head: `paradigma/fix-${TASK_ID}`,
      base: "main",
      draft: false,
    });
    const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
    });
    expect(branch.stdout.trim()).toBe(`paradigma/fix-${TASK_ID}`);
    const log = await run("git", ["log", "-1", "--format=%an <%ae>%n%B"], {
      cwd: root,
    });
    expect(log.stdout).toContain("Paradigma <bot@paradigma.click>");
    expect(log.stdout).toContain(`Paradigma-Task: ${TASK_ID}`);
    expect(h.stdout.join("")).not.toContain(TOKEN);
  });

  it("speaks OpenRouter's format and opens a draft for a cleanup", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: FIX_STEPS,
      provider: "openrouter",
      task: task({ draft: true, category: "policy_cleanup" }),
    });
    const result = await runFix(deps, OPTIONS);
    expect(result.outcome).toBe("pr_opened");
    expect(h.reports[0]).toMatchObject({
      model: "anthropic/claude-sonnet-5.5",
    });
    expect(
      h.requests.find((r) => r.url.endsWith("/pulls"))?.body,
    ).toMatchObject({
      draft: true,
    });
    const second = h.requests.filter((r) => r.url.includes("openrouter"))[1]
      ?.body as {
      messages: { role: string }[];
    };
    expect(second.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("runs the build without secrets, retries once on a failed check, then reports the failure", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: [...FIX_STEPS, ...FIX_STEPS.slice(2)],
      checkPassed: () => false,
    });
    const result = await runFix(deps, { ...OPTIONS, build: "npm run build" });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "pre_pr_failed",
    });
    const builds = h.execs.filter((e) => e.command === "bash");
    expect(builds).toHaveLength(2);
    expect(builds[0].env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(builds[0].env).not.toHaveProperty("GITHUB_TOKEN");
    // The second attempt starts fresh with the feedback appended.
    const prompts = h.requests
      .filter((r) => r.url.includes("anthropic"))
      .map(
        (r) =>
          (r.body as { messages: { content: unknown }[] }).messages[0].content,
      );
    expect(prompts.at(-1)).toContain("- The description is missing.");
    expect(h.reports[0]).toMatchObject({
      outcome: "failed",
      checks: [
        { name: "build", status: "passed", durationMs: 12 },
        { name: "build", status: "passed", durationMs: 12 },
      ],
    });
    expect(h.execs.some((e) => e.args.includes("commit"))).toBe(false);
    noContents(h);
  });

  it("passes on the second attempt after a failed build", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    let builds = 0;
    const { h, deps } = harness({ root, steps: [...FIX_STEPS, FIX_STEPS[3]] });
    const exec = deps.exec;
    deps.exec = async (command, args, options) => {
      if (command === "bash") {
        builds++;
        const result = await exec(command, args, options);
        return { ...result, code: builds === 1 ? 1 : 0 };
      }
      return exec(command, args, options);
    };
    const result = await runFix(deps, { ...OPTIONS, test: "npm test" });
    expect(result.outcome).toBe("pr_opened");
    expect(h.reports[0].checks).toEqual([
      { name: "test", status: "failed", durationMs: 12 },
      { name: "test", status: "passed", durationMs: 12 },
    ]);
  });

  it("reports no_model_key without calling a model", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: FIX_STEPS,
      provider: "none" as never,
    });
    const result = await runFix(deps, OPTIONS);
    expect(result).toMatchObject({ outcome: "failed", reason: "no_model_key" });
    expect(h.stderr.join("")).toContain(
      "ANTHROPIC_API_KEY or OPENROUTER_API_KEY",
    );
    expect(h.requests.some((r) => r.url.includes("anthropic"))).toBe(false);
    expect(h.reports[0]).toMatchObject({
      outcome: "failed",
      reason: "no_model_key",
    });
  });

  it("explains the Actions setting when GitHub refuses the pull request", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({ root, steps: FIX_STEPS, prStatus: 403 });
    const result = await runFix(deps, OPTIONS);
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "pr_permission",
    });
    expect(h.stderr.join("")).toContain(
      "Allow GitHub Actions to create and approve pull requests",
    );
    expect(h.reports[0]).toMatchObject({
      reason: "pr_permission",
      changedPaths: ["index.html"],
    });
  });

  it("reports a skip when the agent skips without changes", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: [
        {
          calls: [
            {
              name: "finish_task",
              input: { outcome: "skipped", reason: "n/a" },
            },
          ],
        },
      ],
    });
    expect(await runFix(deps, OPTIONS)).toMatchObject({
      outcome: "skipped",
      reason: "agent_skipped",
    });
    expect(h.reports[0]).toMatchObject({
      agentOutcome: "skipped",
      changedPaths: [],
    });
  });

  it("refuses to run in another repository than the task's", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: FIX_STEPS,
      env: { GITHUB_REPOSITORY: "evil/fork" },
    });
    expect(await runFix(deps, OPTIONS)).toMatchObject({
      outcome: "failed",
      reason: "internal_error",
    });
    expect(h.requests.some((r) => r.url.includes("anthropic"))).toBe(false);
  });

  it("stops without a report when the token is no longer valid", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({ root, steps: FIX_STEPS, taskStatus: 401 });
    expect(await runFix(deps, OPTIONS)).toMatchObject({
      outcome: "failed",
      reason: "token_expired",
      reported: false,
    });
    expect(h.reports).toHaveLength(0);
  });
});

describe("runFix with the Paradigma model", () => {
  const PARADIGMA = task({ modelAccess: { source: "paradigma" } });

  it("calls the model proxy with the task token, ignores model secrets and sends no system prompt or tools", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: FIX_STEPS,
      task: PARADIGMA,
      env: { OPENROUTER_API_KEY: "or-key" },
    });
    const result = await runFix(deps, OPTIONS);
    expect(result.outcome).toBe("pr_opened");
    expect(
      h.requests.some(
        (r) => r.url.includes("anthropic.test") || r.url.includes("openrouter"),
      ),
    ).toBe(false);
    const proxied = h.requests.filter((r) =>
      r.url.endsWith("/api/autopilot/action/model"),
    );
    expect(proxied).toHaveLength(4);
    for (const request of proxied)
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const second = proxied[1]?.body as {
      messages: { role: string; results?: { name: string }[] }[];
      maxTokens: number;
      system?: unknown;
      tools?: unknown;
    };
    expect(second.system).toBeUndefined();
    expect(second.tools).toBeUndefined();
    expect(second.maxTokens).toBe(8_000);
    expect(second.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(second.messages[2]?.results?.[0]?.name).toBe("read_file");
    expect(h.reports[0]).toMatchObject({
      outcome: "pr_opened",
      model: "anthropic/claude-sonnet-5.5",
      tokens: { input: 3200, output: 320 },
    });
    // No key exists on this path, so nothing is masked and no secret is printed.
    expect(h.stdout.join("")).not.toContain("::add-mask::");
    expect(h.stdout.join("")).not.toContain("or-key");
    noContents(h);
  });

  it("stops at the server's caps and reports caps", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: FIX_STEPS,
      task: PARADIGMA,
      proxyError: { status: 429, error: "caps" },
    });
    expect(await runFix(deps, OPTIONS)).toMatchObject({
      outcome: "failed",
      reason: "caps",
    });
    // A spent cap is not retried.
    expect(
      h.requests.filter((r) => r.url.endsWith("/action/model")),
    ).toHaveLength(2);
    expect(h.reports[0]).toMatchObject({ reason: "caps" });
  });

  it("reports model_unavailable when the Paradigma model is down", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: FIX_STEPS,
      task: PARADIGMA,
      proxyError: { status: 503, error: "model_unavailable" },
    });
    expect(await runFix(deps, OPTIONS)).toMatchObject({
      outcome: "failed",
      reason: "model_unavailable",
    });
    expect(
      h.requests.filter((r) => r.url.endsWith("/action/model")),
    ).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ reason: "model_unavailable" });
  });
});

describe("runFix with Use my own key", () => {
  it("masks the customer's key before any model call and uses the named provider", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: FIX_STEPS,
      provider: "none" as never,
      env: { ANTHROPIC_API_KEY: "ant-key", OPENROUTER_API_KEY: "or-key" },
      task: task({ modelAccess: { source: "own", provider: "openrouter" } }),
    });
    const result = await runFix(deps, OPTIONS);
    expect(result.outcome).toBe("pr_opened");
    const mask = h.stdout.indexOf("::add-mask::or-key\n");
    expect(mask).toBeGreaterThanOrEqual(0);
    expect(h.stdoutAtFirstModel).not.toBeNull();
    expect(mask).toBeLessThan(h.stdoutAtFirstModel ?? 0);
    expect(h.requests.some((r) => r.url.includes("openrouter"))).toBe(true);
    expect(h.requests.some((r) => r.url.includes("anthropic.test"))).toBe(
      false,
    );
    expect(h.requests.some((r) => r.url.endsWith("/action/model"))).toBe(false);
    // The key appears only in the mask command, never in another line or the report.
    expect(h.stdout.filter((line) => line.includes("or-key"))).toHaveLength(1);
    expect(JSON.stringify(h.reports)).not.toContain("or-key");
  });

  it("fails with no_model_key when the setting is on and no secret reached the step", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps } = harness({
      root,
      steps: FIX_STEPS,
      provider: "none" as never,
      task: task({ modelAccess: { source: "own", provider: null } }),
    });
    expect(await runFix(deps, OPTIONS)).toMatchObject({
      outcome: "failed",
      reason: "no_model_key",
    });
    expect(h.stderr.join("")).toContain("Use my own key");
    expect(h.requests.some((r) => r.url.endsWith("/action/model"))).toBe(false);
  });

  it("chooses the model from the task's setting", () => {
    const models = task().models;
    const env = { ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" };
    expect(
      modelAccessFor({ models, modelAccess: { source: "paradigma" } }, env),
    ).toEqual({ provider: "paradigma", model: "anthropic/claude-sonnet-5.5" });
    expect(
      modelAccessFor(
        { models, modelAccess: { source: "own", provider: null } },
        env,
      ),
    ).toEqual({ provider: "anthropic", key: "a", model: "claude-sonnet-5-5" });
    expect(
      modelAccessFor(
        { models, modelAccess: { source: "own", provider: "openrouter" } },
        { ANTHROPIC_API_KEY: "a" },
      ),
    ).toBeNull();
    // An older server sends no setting: the customer's key, as before.
    expect(modelAccessFor({ models }, { OPENROUTER_API_KEY: "o" })).toEqual({
      provider: "openrouter",
      key: "o",
      model: "anthropic/claude-sonnet-5.5",
    });
  });

  it("escapes the mask command and maps proxy errors", () => {
    expect(maskCommand("a%b\nc")).toBe("::add-mask::a%25b%0Ac\n");
    expect(proxyErrorCategory(429, "caps")).toBe("caps");
    expect(proxyErrorCategory(429, "rate_limited")).toBe("rate_limited");
    expect(proxyErrorCategory(503, null)).toBe("model_unavailable");
    expect(proxyErrorCategory(410, "task_closed")).toBe("token_expired");
    expect(proxyErrorCategory(502, "timeout")).toBe("provider_error");
    expect(modelReason("caps")).toBe("caps");
    expect(modelReason("provider_error")).toBe("provider_error");
  });
});

describe("fixCommand", () => {
  it("reads the token from env, defaults the server and returns the exit code", async () => {
    const root = await gitRepo({ "index.html": BASE_HTML });
    const { h, deps, io } = harness({
      root,
      steps: FIX_STEPS,
      env: {
        PARADIGMA_FIX_TASK: TOKEN,
        PARADIGMA_API_URL: `${SERVER}/ignored/path`,
      },
    });
    expect(await fixCommand(io, [], deps)).toBe(0);
    expect(h.reports[0]).toMatchObject({ outcome: "pr_opened" });
  });

  it("rejects a missing token and an insecure server", async () => {
    const root = tempRepo({});
    const { io } = harness({ root, steps: [] });
    await expect(fixCommand(io, [])).rejects.toThrow(/--task/);
    await expect(
      fixCommand(io, ["--task", TOKEN, "--api-url", "http://paradigma.test"]),
    ).rejects.toThrow(/https/);
  });
});
