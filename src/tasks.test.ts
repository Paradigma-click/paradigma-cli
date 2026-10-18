import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "./config";
import { ActionRequired, UsageError } from "./io";
import { PlatformError } from "./platform";
import {
  clipboardCommands,
  copyToClipboard,
  finishBody,
  formatStartedTask,
  formatTasks,
  hooks,
  parseTaskId,
  statusChip,
  tasksCommand,
  validatePrUrl,
  validateReason,
} from "./tasks";
import { startTaskResponseSchema, tasksResponseSchema } from "./tasks-api";
import { fakeIo, fakeServer } from "./test/platform";

const SERVER = "https://app.paradigma.test";
const TOKEN = `pdg_rt_${"c".repeat(43)}`;
const CREDENTIAL = "99999999-9999-4999-8999-999999999999";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "55555555-5555-4555-8555-555555555555";
const ORG = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";

const tasksBody = {
  projects: [
    {
      project: {
        id: PROJECT,
        name: "Acme",
        url: "https://acme.test",
        repo: "acme/web",
        verified: true,
        autopilot: { enabled: true, level: 2 },
        extra: "kept",
      },
      counts: { queued: 1, needsYou: 1, running: 0, open: 3, done: 4 },
      tasks: [
        {
          id: TASK,
          title: "Add a descriptive title",
          category: "metadata",
          risk: "low",
          status: "queued",
          mode: "draft",
          plannedFor: "2026-10-17T09:00:00.000Z",
          prUrl: null,
          prNumber: null,
          findingUrl: "https://app.paradigma.test/f/1",
          startedBy: null,
          updatedAt: "2026-10-16T09:00:00.000Z",
        },
        {
          id: "77777777-7777-4777-8777-777777777777",
          title: "Fix canonical tags",
          category: "indexing",
          risk: "medium",
          status: "pr_opened",
          mode: "auto",
          plannedFor: null,
          prUrl: "https://github.com/acme/web/pull/12",
          prNumber: 12,
          findingUrl: null,
          startedBy: "runner",
          updatedAt: "2026-10-16T10:00:00.000Z",
        },
        { title: "no id, dropped" },
      ],
    },
    {
      project: {
        id: OTHER,
        name: "Docs",
        url: "https://docs.acme.test",
        repo: { owner: "acme", name: "docs" },
        verified: false,
        autopilot: { enabled: false, level: null },
      },
      counts: { queued: 0, needsYou: 0, running: 0, open: 0, done: 0 },
      tasks: [],
    },
  ],
};

const startedTask = {
  id: TASK,
  title: "Add a descriptive title",
  instructions:
    "Set metadata.title in app/layout.tsx.\nKeep it under 60 characters.\u001b[31m",
  acceptance: ["app/layout.tsx exports a non-empty title"],
  allowedPaths: ["app/**"],
  diffBudget: { maxFiles: 2, maxLines: 30 },
  category: "metadata",
  risk: "low",
  repo: { owner: "acme", name: "web", defaultBranch: "main", appRoot: "" },
  project: { id: PROJECT, name: "Acme", url: "https://acme.test" },
  findingUrl: "https://app.paradigma.test/f/1",
  branch: "paradigma/task/44444444",
  leaseExpiresAt: "2026-10-16T11:00:00.000Z",
};

const projectsRoute = () => ({
  body: {
    projects: [
      {
        id: PROJECT,
        orgId: ORG,
        repoId: REPO,
        repoFullName: "acme/web",
        appRoot: "",
        name: "Acme",
        productionUrl: "https://acme.test",
        verified: true,
      },
    ],
  },
});

let root: string;
async function writeConfig(paired: boolean) {
  await saveConfig({
    server: SERVER,
    token: TOKEN,
    ...(paired ? { runnerId: CREDENTIAL, publicKey: "k".repeat(43) } : {}),
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "paradigma-tasks-"));
  vi.stubEnv("PARADIGMA_HOME", join(root, "home"));
  await writeConfig(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** A cwd outside any git repository. */
const cwd = () => root;

function git(dir: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

describe("argument validation", () => {
  it("accepts task ids and rejects anything that could leave the path", () => {
    expect(parseTaskId(TASK, "usage")).toBe(TASK);
    expect(() => parseTaskId(undefined, "usage")).toThrow("usage");
    expect(() => parseTaskId("../x", "usage")).toThrow(UsageError);
    expect(() => parseTaskId("a/b", "usage")).toThrow(UsageError);
  });

  it("only accepts github.com pull request URLs", () => {
    expect(validatePrUrl("https://github.com/acme/web/pull/12/")).toBe(
      "https://github.com/acme/web/pull/12",
    );
    for (const bad of [
      "http://github.com/acme/web/pull/12",
      "https://gitlab.com/acme/web/merge_requests/1",
      "https://github.com/acme/web/issues/12",
      "https://github.com/acme/web/pull/12/files",
      "https://github.com.evil.test/acme/web/pull/1",
      "https://github.com/acme/web/pull/0",
    ])
      expect(() => validatePrUrl(bad), bad).toThrow(UsageError);
  });

  it("keeps reasons to one plain line of at most 200 characters", () => {
    expect(validateReason("  Already has a title  ")).toBe(
      "Already has a title",
    );
    expect(validateReason("x".repeat(200))).toHaveLength(200);
    expect(() => validateReason("x".repeat(201))).toThrow("at most 200");
    expect(() => validateReason("one\ntwo")).toThrow("single line");
    expect(() => validateReason("see ```code```")).toThrow("code fences");
    expect(() => validateReason("bell\u0007")).toThrow(UsageError);
    expect(() => validateReason("   ")).toThrow("empty");
  });

  it("builds the finish body from exactly one outcome", () => {
    expect(finishBody({ pr: "https://github.com/acme/web/pull/3" })).toEqual({
      status: "pr_opened",
      prUrl: "https://github.com/acme/web/pull/3",
    });
    expect(finishBody({ done: true })).toEqual({ status: "done" });
    expect(finishBody({ skip: true, reason: "Already fixed" })).toEqual({
      status: "skipped",
      reason: "Already fixed",
    });
    expect(finishBody({ failed: true, reason: "Build broke" })).toEqual({
      status: "failed",
      reason: "Build broke",
    });
    expect(() => finishBody({})).toThrow("exactly one");
    expect(() => finishBody({ done: true, skip: true })).toThrow("exactly one");
    expect(() => finishBody({ skip: true })).toThrow("--skip needs --reason");
    expect(() => finishBody({ failed: true })).toThrow(
      "--failed needs --reason",
    );
  });
});

describe("output formatting", () => {
  it("decodes tolerantly: unknown fields kept, unreadable tasks dropped", () => {
    const parsed = tasksResponseSchema.parse(tasksBody);
    expect(parsed.projects[0].tasks).toHaveLength(2);
    expect(parsed.projects[0].project.extra).toBe("kept");
    const odd = tasksResponseSchema.parse({
      projects: [
        {
          project: { id: PROJECT, name: "A", autopilot: "?" },
          counts: { queued: "x" },
          tasks: [{ id: TASK, title: "T", status: "brand_new" }],
        },
      ],
    });
    expect(odd.projects[0].counts.queued).toBe(0);
    expect(odd.projects[0].project.autopilot).toBeNull();
    expect(statusChip(odd.projects[0].tasks[0])).toBe("brand new");
  });

  it("shows each project with counts, status chips and PR links", () => {
    const lines = formatTasks(tasksResponseSchema.parse(tasksBody));
    const text = lines.join("\n");
    expect(lines[0]).toBe(
      "Acme  ·  https://acme.test  ·  acme/web  ·  Autopilot level 2",
    );
    expect(text).toContain("3 open: 1 queued, 1 need you, 0 running · 4 done");
    expect(text).toMatch(
      new RegExp(
        `queued +${TASK}  Add a descriptive title  \\(planned 2026-10-17\\)`,
      ),
    );
    expect(text).toMatch(
      /PR open +77777777-7777-4777-8777-777777777777 {2}Fix canonical tags {2}https:\/\/github\.com\/acme\/web\/pull\/12/,
    );
    expect(text).toContain(
      "Docs  ·  https://docs.acme.test  ·  acme/docs  ·  Autopilot off",
    );
    expect(text).toContain(
      `Locked until the domain is verified: paradigma verify --project ${OTHER}`,
    );
    expect(text).toContain("No open tasks.");
    expect(text).toContain("paradigma tasks start <task id>");
    expect(text).toContain(
      `paradigma tasks prompt --project ${PROJECT} --copy`,
    );
    expect(text).not.toContain("background");
    expect(text).not.toContain("—");
  });

  it("lists setup steps first with why and the command, or who does it", () => {
    const setupTask = (
      id: string,
      title: string,
      status: string,
      setup: Record<string, unknown>,
    ) => ({
      id,
      title,
      category: "setup",
      risk: "low",
      status,
      mode: setup.who === "you" ? "draft" : "auto",
      plannedFor: "2026-10-16",
      prUrl: null,
      prNumber: null,
      findingUrl: null,
      startedBy: null,
      updatedAt: "2026-10-16T09:00:00.000Z",
      setup: { install: false, done: false, command: null, ...setup },
    });
    const body = {
      projects: [
        {
          ...tasksBody.projects[0],
          tasks: [
            setupTask(
              "88888888-8888-4888-8888-888888888888",
              "Install the Google Analytics tag",
              "queued",
              {
                key: "setup/ga4-tag",
                who: "agent",
                install: true,
                why: "Counts visits so Paradigma can see which fixes bring traffic",
              },
            ),
            setupTask(
              "99999999-8888-4888-8888-888888888888",
              "Connect Bing Webmaster Tools",
              "needs_you",
              {
                key: "setup/bing",
                who: "you",
                why: "Adds Bing searches, clicks and indexing to your reports",
                command: `npx paradigma-cli connect bing --project ${PROJECT}`,
              },
            ),
            ...tasksBody.projects[0].tasks,
          ],
        },
      ],
    };
    const text = formatTasks(tasksResponseSchema.parse(body)).join("\n");
    expect(text).toContain("  Setup:");
    expect(text.indexOf("Install the Google Analytics tag")).toBeLessThan(
      text.indexOf("Connect Bing Webmaster Tools"),
    );
    expect(text).toContain("Agent can do this");
    expect(text).toContain(
      `You run: npx paradigma-cli connect bing --project ${PROJECT}`,
    );
    expect(text).toContain(
      "Counts visits so Paradigma can see which fixes bring traffic",
    );
    expect(text.indexOf("  Tasks:")).toBeLessThan(
      text.indexOf("Add a descriptive title"),
    );
    expect(text.indexOf("  Tasks:")).toBeGreaterThan(
      text.indexOf("Connect Bing Webmaster Tools"),
    );
  });

  it("marks tasks an agent is running", () => {
    expect(statusChip({ status: "running", startedBy: "agent" })).toBe(
      "running (agent)",
    );
    expect(statusChip({ status: "needs_you", startedBy: null })).toBe(
      "needs you",
    );
  });

  it("prints the brief with branch, paths, budget, acceptance and finish commands", () => {
    const { task } = startTaskResponseSchema.parse({ task: startedTask });
    const text = formatStartedTask(task).join("\n");
    expect(text).toContain("Task:      Add a descriptive title");
    expect(text).toContain("Project:   Acme  https://acme.test");
    expect(text).toContain("git fetch origin main");
    expect(text).toContain("git switch -c paradigma/task/44444444 origin/main");
    expect(text).toContain("   - app/**");
    expect(text).toContain("at most 2 file(s) and 30 changed line(s)");
    expect(text).toContain("   - app/layout.tsx exports a non-empty title");
    expect(text).toContain("  Keep it under 60 characters.");
    expect(text).not.toContain("\u001b");
    expect(text).toContain(
      `paradigma tasks finish ${TASK} --pr <pull request URL>`,
    );
    expect(text).toContain(`paradigma tasks finish ${TASK} --done`);
    expect(text).toContain(`paradigma tasks finish ${TASK} --skip --reason`);
    expect(text).toContain(`paradigma tasks finish ${TASK} --failed --reason`);
    expect(text).toContain(`paradigma tasks release ${TASK}`);
    expect(text).not.toContain("—");
  });
});

describe("clipboard", () => {
  it("chooses the tool for the platform", () => {
    expect(clipboardCommands("darwin", {})).toEqual([["pbcopy"]]);
    expect(
      clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0" })[0],
    ).toEqual(["wl-copy"]);
    expect(clipboardCommands("linux", {})[0]).toEqual([
      "xclip",
      "-selection",
      "clipboard",
    ]);
  });

  it("falls back through the tools and returns null when none works", async () => {
    const tried: string[] = [];
    const pipe = async (command: string[]) => {
      tried.push(command[0]);
      return command[0] === "wl-copy";
    };
    expect(
      await copyToClipboard("hi", { platform: "linux", env: {}, pipe }),
    ).toBe("wl-copy");
    expect(tried).toEqual(["xclip", "xsel", "wl-copy"]);
    expect(
      await copyToClipboard("hi", {
        platform: "linux",
        env: {},
        pipe: async () => false,
      }),
    ).toBeNull();
  });
});

describe("paradigma tasks", () => {
  it("lists every project's open tasks outside a repository", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/tasks": () => ({ body: tasksBody }),
    });
    const io = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(io.io, []);
    expect(server.calls.map((c) => c.path)).toEqual([
      "/api/cli/v1/tasks?status=open",
    ]);
    expect(io.stdout()).toContain("Acme  ·  https://acme.test");
    expect(io.stdout()).toContain("Add a descriptive title");
  });

  it("asks for one project with --project and everything with --all", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/tasks": () => ({ body: { projects: [] } }),
    });
    const io = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(io.io, ["--project", PROJECT, "--all"]);
    expect(server.calls[0].path).toBe(
      `/api/cli/v1/tasks?project=${PROJECT}&status=all`,
    );
    expect(io.stdout()).toContain("No projects yet");
    await expect(
      tasksCommand(fakeIo({ fetch: server.fetch }).io, ["--project", "acme"]),
    ).rejects.toThrow(UsageError);
  });

  it("filters by --repo", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/tasks": () => ({ body: tasksBody }),
    });
    const io = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(io.io, ["--repo", "ACME/docs", "--json"]);
    const printed = JSON.parse(io.stdout());
    expect(
      printed.projects.map((g: { project: { id: string } }) => g.project.id),
    ).toEqual([OTHER]);
  });

  it("defaults to this checkout's project", async () => {
    const clone = join(root, "web");
    mkdirSync(clone);
    git(clone, "init", "--quiet");
    git(clone, "remote", "add", "origin", "https://github.com/acme/web.git");
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      "GET /api/cli/v1/tasks": () => ({ body: tasksBody }),
    });
    const io = fakeIo({ fetch: server.fetch, cwd: clone });
    await tasksCommand(io.io, []);
    expect(server.calls.at(-1)?.path).toBe(
      `/api/cli/v1/tasks?project=${PROJECT}&status=open`,
    );
  });

  it("--json prints the API response as it came", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/tasks": () => ({ body: tasksBody }),
    });
    const io = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(io.io, ["--json"]);
    const printed = JSON.parse(io.stdout());
    expect(printed.projects[0].project).toEqual(tasksBody.projects[0].project);
    expect(printed.projects[0].counts).toEqual(tasksBody.projects[0].counts);
    expect(printed.projects[0].tasks).toEqual(
      tasksBody.projects[0].tasks.slice(0, 2),
    );
  });

  it("start prints the brief and the JSON carries the commands", async () => {
    const server = fakeServer({
      "POST /api/cli/v1/tasks/44444444-4444-4444-8444-444444444444/start":
        () => ({ body: { task: startedTask } }),
    });
    const human = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(human.io, ["start", TASK]);
    expect(human.stdout()).toContain("Instructions:");
    expect(human.stdout()).toContain("git switch -c paradigma/task/44444444");
    const json = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(json.io, ["start", TASK, "--json"]);
    const printed = JSON.parse(json.stdout());
    expect(printed.task.branch).toBe("paradigma/task/44444444");
    expect(printed.commands.branch).toEqual([
      "git fetch origin main",
      "git switch -c paradigma/task/44444444 origin/main",
    ]);
    expect(printed.commands.release).toBe(`paradigma tasks release ${TASK}`);
  });

  it("start explains a locked project (exit 3) and a task already running", async () => {
    const server = fakeServer({
      [`POST /api/cli/v1/tasks/${TASK}/start`]: () => ({
        status: 403,
        body: { error: "unverified", message: "Verify acme.test first." },
      }),
      [`POST /api/cli/v1/tasks/${OTHER}/start`]: () => ({
        status: 409,
        body: { error: "conflict", message: "The task is running." },
      }),
    });
    const io = fakeIo({ fetch: server.fetch, cwd: cwd() });
    const locked = await tasksCommand(io.io, ["start", TASK]).catch(
      (error) => error,
    );
    expect(locked).toBeInstanceOf(ActionRequired);
    expect(locked.message).toContain("Verify acme.test first.");
    expect(locked.message).toContain("paradigma verify");
    const busy = await tasksCommand(io.io, ["start", OTHER]).catch(
      (error) => error,
    );
    expect(busy).toBeInstanceOf(PlatformError);
    expect(busy.message).toContain("already running");
  });

  it("start --checkout creates the branch in a clean clone of the repository", async () => {
    const origin = join(root, "origin.git");
    const clone = join(root, "clone");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "--quiet", origin, clone], {
      stdio: "pipe",
    });
    writeFileSync(join(clone, "README.md"), "# web\n");
    const env = [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
    ];
    git(clone, "add", ".");
    git(clone, ...env, "commit", "--quiet", "--no-verify", "-m", "init");
    git(clone, "push", "--quiet", "origin", "HEAD:main");
    git(
      clone,
      "remote",
      "set-url",
      "origin",
      "https://github.com/acme/web.git",
    );
    git(
      clone,
      "config",
      `url.${origin}.insteadOf`,
      "https://github.com/acme/web.git",
    );
    const server = fakeServer({
      [`POST /api/cli/v1/tasks/${TASK}/start`]: () => ({
        body: { task: startedTask },
      }),
    });

    writeFileSync(join(clone, "dirty.txt"), "x\n");
    const dirty = fakeIo({ fetch: server.fetch, cwd: clone });
    await tasksCommand(dirty.io, ["start", TASK, "--checkout", "--json"]);
    expect(JSON.parse(dirty.stdout()).checkout).toEqual({
      ok: false,
      branch: "paradigma/task/44444444",
      problem: "the working tree has uncommitted changes",
    });
    rmSync(join(clone, "dirty.txt"));

    const io = fakeIo({ fetch: server.fetch, cwd: clone });
    await tasksCommand(io.io, ["start", TASK, "--checkout"]);
    expect(git(clone, "branch", "--show-current")).toBe(
      "paradigma/task/44444444",
    );
    expect(io.stdout()).toContain(
      "1. Branch: switched to paradigma/task/44444444 (from origin/main).",
    );

    const elsewhere = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(elsewhere.io, ["start", TASK, "--checkout"]);
    expect(elsewhere.stdout()).toContain(
      "(--checkout did not run: this directory is not a clone of acme/web)",
    );
  });

  it("finish sends the outcome and validates before calling the server", async () => {
    const server = fakeServer({
      [`POST /api/cli/v1/tasks/${TASK}/finish`]: () => ({ body: { ok: true } }),
    });
    const io = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(io.io, [
      "finish",
      TASK,
      "--pr",
      "https://github.com/acme/web/pull/7",
    ]);
    expect(server.calls[0].body).toEqual({
      status: "pr_opened",
      prUrl: "https://github.com/acme/web/pull/7",
    });
    expect(io.stdout()).toContain(`Task ${TASK}: PR opened.`);
    await tasksCommand(io.io, [
      "finish",
      TASK,
      "--skip",
      "--reason",
      "The title is already set",
    ]);
    expect(server.calls[1].body).toEqual({
      status: "skipped",
      reason: "The title is already set",
    });
    await expect(
      tasksCommand(io.io, [
        "finish",
        TASK,
        "--pr",
        "https://example.com/pull/1",
      ]),
    ).rejects.toThrow(UsageError);
    await expect(
      tasksCommand(io.io, ["finish", TASK, "--failed", "--reason", "a\nb"]),
    ).rejects.toThrow("single line");
    expect(server.calls).toHaveLength(2);
  });

  it("release gives the task back", async () => {
    const server = fakeServer({
      [`POST /api/cli/v1/tasks/${TASK}/release`]: () => ({
        body: { ok: true },
      }),
    });
    const io = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(io.io, ["release", TASK, "--json"]);
    expect(server.calls[0].method).toBe("POST");
    expect(JSON.parse(io.stdout())).toMatchObject({ ok: true, taskId: TASK });
  });

  it("prompt prints the server's prompt and --copy uses the clipboard", async () => {
    const server = fakeServer({
      "GET /api/cli/v1/projects": projectsRoute,
      [`GET /api/cli/v1/projects/${PROJECT}/tasks/prompt`]: () => ({
        body: { prompt: "Work through the open Paradigma tasks." },
      }),
    });
    const plain = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(plain.io, ["prompt"]);
    expect(plain.stdout()).toBe("Work through the open Paradigma tasks.\n");

    const copy = vi.spyOn(hooks, "copy").mockResolvedValue("pbcopy");
    const copied = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(copied.io, ["prompt", "--copy"]);
    expect(copy).toHaveBeenCalledWith(
      "Work through the open Paradigma tasks.",
      expect.anything(),
    );
    expect(copied.stdout()).toContain(
      "Copied the tasks prompt to the clipboard (pbcopy)",
    );

    copy.mockResolvedValue(null);
    const fallback = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(fallback.io, ["prompt", "--copy"]);
    expect(fallback.stdout()).toContain(
      "Work through the open Paradigma tasks.",
    );
    expect(fallback.stderr()).toContain("No clipboard tool found");

    const json = fakeIo({ fetch: server.fetch, cwd: cwd() });
    await tasksCommand(json.io, ["prompt", "--copy", "--json"]);
    expect(JSON.parse(json.stdout())).toEqual({
      prompt: "Work through the open Paradigma tasks.",
      copied: null,
    });
  });
});
