import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentReportedError,
  buildAgentArgv,
  chooseAgent,
  customAgentCommand,
  extractAgentText,
  parseVersion,
} from "./agents";
import { overrideChecks, planChecks } from "./checks";
import { configPath, loadConfig, saveConfig } from "./config";
import { splitCommand } from "./exec";
import {
  commitMessage,
  parseGithubRemote,
  parseNumstatZ,
  parsePorcelainZ,
} from "./git";
import {
  buildEditPrompt,
  buildReviewPrompt,
  parseReviewVerdict,
} from "./prompt";
import {
  autoMergeArgs,
  buildPrBody,
  canonicalPrUrl,
  effectiveMode,
  parsePrUrl,
  prLevel,
} from "./publish";
import { parseRepoOverride } from "./repos";
import {
  isRunDue,
  launchdPlist,
  minuteFor,
  schtasksArgs,
  systemdService,
  systemdTimer,
} from "./schedule";
import { RUNNER_ID, taskPayload } from "./test/fixtures";
import { rotateTestSigningKey, signTask, testPublicKey } from "./test/signing";
import { verifyTask } from "./verify";
import { VERSION } from "./version";

describe("agent adapters", () => {
  const input = {
    prompt: "-p looks like a flag but is the prompt",
    promptFile: "/tmp/prompt.md",
    lastMessageFile: "/tmp/last.txt",
  };

  it("runs Claude Code without shell or web tools", () => {
    const edit = buildAgentArgv(
      { name: "claude", command: ["claude"] },
      { ...input, mode: "edit" },
    );
    expect(edit.command).toBe("claude");
    expect(edit.args.slice(0, 2)).toEqual(["-p", input.prompt]);
    expect(edit.args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
      ]),
    );
    const allowed = edit.args.indexOf("--allowedTools");
    expect(edit.args[allowed + 1]).toBe("Read,Edit,Write,Glob,Grep");
    expect(edit.args[edit.args.indexOf("--disallowedTools") + 1]).toBe(
      "Bash,WebFetch,WebSearch",
    );
    expect(allowed).toBeGreaterThan(edit.args.indexOf(input.prompt));
    const review = buildAgentArgv(
      { name: "claude", command: ["claude"] },
      { ...input, mode: "review" },
    );
    expect(review.args[review.args.indexOf("--allowedTools") + 1]).toBe(
      "Read,Glob,Grep",
    );
    expect(review.args[review.args.indexOf("--disallowedTools") + 1]).toContain(
      "Edit",
    );
  });

  it("runs Codex in a workspace-write sandbox with approvals off", () => {
    const edit = buildAgentArgv(
      { name: "codex", command: ["codex"] },
      { ...input, mode: "edit" },
    );
    expect(edit.args.slice(0, 2)).toEqual(["exec", input.prompt]);
    expect(edit.args).toEqual(
      expect.arrayContaining([
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
        "--output-last-message",
        "/tmp/last.txt",
      ]),
    );
    const review = buildAgentArgv(
      { name: "codex", command: ["codex"] },
      { ...input, mode: "review" },
    );
    expect(review.args[review.args.indexOf("--sandbox") + 1]).toBe("read-only");
  });

  it("runs Cursor in print mode, read-only for review", () => {
    const edit = buildAgentArgv(
      { name: "cursor", command: ["cursor-agent"] },
      { ...input, mode: "edit" },
    );
    expect(edit.command).toBe("cursor-agent");
    expect(edit.args.slice(0, 2)).toEqual(["-p", input.prompt]);
    expect(edit.args).not.toContain("--force");
    expect(edit.args).not.toContain("--mode");
    const review = buildAgentArgv(
      { name: "cursor", command: ["cursor-agent"] },
      { ...input, mode: "review" },
    );
    expect(review.args.slice(-2)).toEqual(["--mode", "ask"]);
  });

  it("passes the prompt file to a custom command", () => {
    const command = customAgentCommand({
      PARADIGMA_AGENT_COMMAND: 'node "/a b/agent.mjs" --x',
    });
    expect(command).toEqual(["node", "/a b/agent.mjs", "--x"]);
    const invocation = buildAgentArgv(
      { name: "custom", command: command ?? [] },
      { ...input, mode: "edit" },
    );
    expect(invocation).toEqual({
      command: "node",
      args: ["/a b/agent.mjs", "--x", "/tmp/prompt.md"],
    });
  });

  it("chooses by preference, then custom, claude, codex, cursor", () => {
    const detected = [
      { name: "cursor" as const, version: "1", command: ["cursor-agent"] },
      { name: "codex" as const, version: "1", command: ["codex"] },
    ];
    expect(chooseAgent(detected)?.name).toBe("codex");
    expect(chooseAgent(detected, "cursor")?.name).toBe("cursor");
    expect(chooseAgent(detected, "claude")).toBeNull();
  });

  it("parses versions and JSON results", () => {
    expect(parseVersion("2.1.296 (Claude Code)")).toBe("2.1.296");
    expect(parseVersion("codex-cli 0.162.1")).toBe("0.162.1");
    expect(parseVersion("2026.10.01-e373342")).toBe("2026.10.01-e373342");
    expect(
      extractAgentText(
        "claude",
        '{"type":"result","result":"done","is_error":false}',
      ),
    ).toBe("done");
    expect(agentReportedError("claude", '{"result":"x","is_error":true}')).toBe(
      true,
    );
    expect(extractAgentText("custom", "raw")).toBe("raw");
  });

  it("splits commands like a shell", () => {
    expect(splitCommand(`a 'b c' "d \\"e\\"" f\\ g ""`)).toEqual([
      "a",
      "b c",
      'd "e"',
      "f g",
      "",
    ]);
  });
});

describe("prompts", () => {
  const task = taskPayload();
  it("includes the task, scope and strict rules", () => {
    const prompt = buildEditPrompt(task);
    expect(prompt).toContain(task.title);
    expect(prompt).toContain(task.instructions);
    expect(prompt).toContain("- app/**");
    expect(prompt).toContain("at most 3 files and 40 changed lines");
    expect(prompt).toContain("Do not run shell commands");
    expect(prompt).toContain("make no changes and say so");
    expect(prompt).not.toContain("Previous attempt");
    expect(
      buildEditPrompt(task, { previousRejection: ["Title is empty"] }),
    ).toContain("- Title is empty");
  });

  it("asks the reviewer for JSON only and truncates huge diffs", () => {
    const prompt = buildReviewPrompt(task, "+x\n");
    expect(prompt).toContain(task.acceptance[0]);
    expect(prompt).toContain('{"verdict":"approved"|"rejected"');
    expect(buildReviewPrompt(task, "x".repeat(200_000)).length).toBeLessThan(
      130_000,
    );
  });

  it("parses verdicts strictly; anything unclear is a rejection", () => {
    expect(
      parseReviewVerdict('{"verdict":"approved","reasons":["ok"]}'),
    ).toEqual({
      verdict: "approved",
      reasons: ["ok"],
    });
    expect(
      parseReviewVerdict(
        'Sure!\n```json\n{"verdict":"rejected","reasons":["no title"]}\n```',
      ),
    ).toEqual({ verdict: "rejected", reasons: ["no title"] });
    expect(
      parseReviewVerdict('Looks good. {"verdict":"approved","reasons":[]}'),
    ).toMatchObject({
      verdict: "approved",
    });
    expect(parseReviewVerdict("approved")).toMatchObject({
      verdict: "rejected",
    });
    expect(parseReviewVerdict('{"verdict":"yes"}')).toMatchObject({
      verdict: "rejected",
    });
    const long = parseReviewVerdict(
      JSON.stringify({
        verdict: "rejected",
        reasons: ["x".repeat(500), 3, ...Array(10).fill("r")],
      }),
    );
    expect(long.reasons[0]).toHaveLength(200);
    expect(long.reasons.length).toBeLessThanOrEqual(8);
  });
});

describe("schedule files", () => {
  const spec = {
    hour: 9,
    minute: 5,
    programArgs: [
      "/usr/bin/node",
      "/opt/paradigma & co/paradigma.mjs",
      "run",
      "--scheduled",
    ],
    logDir: "/home/me/.paradigma/logs",
    path: "/usr/local/bin:/usr/bin",
    home: "/home/me",
  };

  it("generates a launchd agent with a daily calendar interval", () => {
    const plist = launchdPlist(spec);
    expect(plist).toContain("<string>com.paradigma.autopilot</string>");
    expect(plist).toMatch(/<key>Hour<\/key>\s*<integer>9<\/integer>/);
    expect(plist).toMatch(/<key>Minute<\/key>\s*<integer>5<\/integer>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist).toContain(
      "<string>/opt/paradigma &amp; co/paradigma.mjs</string>",
    );
    expect(plist).toContain("<string>/usr/local/bin:/usr/bin</string>");
    expect(plist).toContain("/home/me/.paradigma/logs/autopilot.log");
  });

  it("generates a persistent systemd timer", () => {
    expect(systemdTimer(spec)).toContain("OnCalendar=*-*-* 09:05:00");
    expect(systemdTimer(spec)).toContain("Persistent=true");
    const service = systemdService(spec);
    expect(service).toContain(
      'ExecStart=/usr/bin/node "/opt/paradigma & co/paradigma.mjs" run --scheduled',
    );
    expect(service).toContain("Environment=PATH=/usr/local/bin:/usr/bin");
  });

  it("generates schtasks arguments", () => {
    const args = schtasksArgs(spec);
    expect(args).toEqual(
      expect.arrayContaining([
        "/SC",
        "DAILY",
        "/ST",
        "09:05",
        "/TN",
        "ParadigmaAutopilot",
      ]),
    );
    expect(args.at(-1)).toBe(
      '/usr/bin/node "/opt/paradigma & co/paradigma.mjs" run --scheduled',
    );
  });

  it("decides whether a scheduled run is due", () => {
    const at = (h: number, m = 0, dayOffset = 0) => {
      const date = new Date(2026, 9, 12 + dayOffset, h, m);
      return date;
    };
    expect(isRunDue(at(10), undefined, 9, 0)).toBe(true);
    expect(isRunDue(at(10), at(9, 5).toISOString(), 9, 0)).toBe(false);
    expect(isRunDue(at(10), at(9, 5, -1).toISOString(), 9, 0)).toBe(true);
    // Before today's slot: due only when yesterday's slot was missed.
    expect(isRunDue(at(8), at(9, 5, -1).toISOString(), 9, 0)).toBe(false);
    expect(isRunDue(at(8), at(9, 5, -3).toISOString(), 9, 0)).toBe(true);
    expect(minuteFor(RUNNER_ID)).toBe(minuteFor(RUNNER_ID));
    expect(minuteFor(RUNNER_ID)).toBeLessThan(60);
  });
});

describe("config", () => {
  beforeEach(() => {
    vi.stubEnv(
      "PARADIGMA_HOME",
      join(mkdtempSync(join(tmpdir(), "paradigma-cfg-")), "home"),
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("writes the config 0600 inside a 0700 directory", async () => {
    expect(loadConfig().repos).toEqual({});
    await saveConfig({
      ...loadConfig(),
      token: "pdg_rt_secret",
      repos: { a: "/x" },
    });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(configPath(), "..")).mode & 0o777).toBe(0o700);
    expect(loadConfig()).toMatchObject({
      token: "pdg_rt_secret",
      repos: { a: "/x" },
      paused: false,
    });
  });
});

describe("git parsing", () => {
  it("parses porcelain -z with renames and untracked files", () => {
    const output = [
      " M app/layout.tsx",
      "?? app/new file.tsx",
      "R  app/b.tsx",
      "lib/a.tsx",
      "",
    ].join("\0");
    expect(parsePorcelainZ(output)).toEqual([
      "app/layout.tsx",
      "app/new file.tsx",
      "app/b.tsx",
      "lib/a.tsx",
    ]);
  });

  it("parses numstat -z, binary files as zero lines", () => {
    expect(parseNumstatZ("3\t1\tapp/a.tsx\0-\t-\tpublic/og.png\0")).toEqual([
      { path: "app/a.tsx", additions: 3, deletions: 1 },
      { path: "public/og.png", additions: 0, deletions: 0 },
    ]);
  });

  it("parses GitHub remotes", () => {
    expect(parseGithubRemote("https://github.com/acme/site.git")).toBe(
      "acme/site",
    );
    expect(
      parseGithubRemote("https://x-access-token:abc@github.com/acme/site"),
    ).toBe("acme/site");
    expect(parseGithubRemote("git@github.com:acme/my.site.git\n")).toBe(
      "acme/my.site",
    );
    expect(parseGithubRemote("ssh://git@github.com/acme/site.git")).toBe(
      "acme/site",
    );
    expect(parseGithubRemote("https://gitlab.com/acme/site.git")).toBeNull();
  });

  it("formats the commit message with the task trailer", () => {
    expect(commitMessage("Fix  title\n", "t-1")).toBe(
      "paradigma: Fix title\n\nParadigma-Task: t-1\n",
    );
  });

  it("parses --repo overrides", () => {
    expect(parseRepoOverride("acme/site=/code/site")).toEqual({
      fullName: "acme/site",
      path: "/code/site",
    });
    expect(parseRepoOverride("nope")).toBeNull();
  });
});

describe("checks", () => {
  it("plans lint, typecheck, test and build in order when present", () => {
    expect(
      planChecks(
        { build: "next build", lint: "biome check", dev: "next dev" },
        "pnpm",
      ),
    ).toEqual([
      { name: "lint", command: "pnpm", args: ["run", "lint"] },
      { name: "build", command: "pnpm", args: ["run", "build"] },
    ]);
    expect(overrideChecks(["make test"])).toEqual([
      { name: "custom-1", command: "make test", args: [], shell: true },
    ]);
  });
});

describe("publishing", () => {
  const task = taskPayload({ mode: "pull_request" });
  it("builds a PR body without diffs", () => {
    const body = buildPrBody({
      task,
      checks: [{ name: "lint", status: "passed", durationMs: 1200 }],
      review: { verdict: "approved", reasons: ["Meets the criteria"] },
      agent: { name: "claude", version: "2.1.0" },
      level: 2,
    });
    expect(body).toContain(`## ${task.title}`);
    expect(body).toContain(`- [ ] ${task.acceptance[0]}`);
    expect(body).toContain("| lint | passed | 1s |");
    expect(body).toContain("Verdict: **approved**");
    expect(body).toContain("Opened by Paradigma Autopilot (level 2).");
  });

  it("parses gh output", () => {
    expect(
      parsePrUrl(
        "Creating pull request\nhttps://github.com/acme/site/pull/42\n",
      ),
    ).toEqual({
      prUrl: "https://github.com/acme/site/pull/42",
      prNumber: 42,
    });
    expect(parsePrUrl("nothing")).toBeNull();
  });

  it("accepts only the task repository's canonical PR URL", () => {
    expect(canonicalPrUrl("https://github.com/Acme/Site/pull/7", task)).toBe(
      "https://github.com/acme/site/pull/7",
    );
    expect(
      canonicalPrUrl("https://github.com/evil/site/pull/7", task),
    ).toBeNull();
    expect(
      canonicalPrUrl("https://github.com/acme/site/pull/7/files", task),
    ).toBeNull();
  });

  it("only auto-merges low-risk tasks with checks and an approved review", () => {
    const auto = taskPayload({ mode: "auto_merge" });
    const clean = { checksSkipped: false, reviewApproved: true };
    expect(effectiveMode(auto, clean)).toBe("auto_merge");
    expect(effectiveMode({ ...auto, category: "content" }, clean)).toBe(
      "pull_request",
    );
    expect(effectiveMode({ ...auto, risk: "medium" }, clean)).toBe(
      "pull_request",
    );
    expect(effectiveMode(auto, { ...clean, checksSkipped: true })).toBe(
      "pull_request",
    );
    expect(effectiveMode(task, clean)).toBe("pull_request");
  });

  it("merges any category and risk only for signed level-0 tasks with every check passed", () => {
    const passed = [{ name: "lint", status: "passed" as const, durationMs: 1 }];
    const clean = {
      checksSkipped: false,
      reviewApproved: true,
      checks: passed,
    };
    const full = taskPayload({
      mode: "auto_merge",
      level: 0,
      category: "content",
      risk: "medium",
    });
    expect(effectiveMode(full, clean)).toBe("auto_merge");
    expect(
      effectiveMode({ ...full, category: "routes", risk: "high" }, clean),
    ).toBe("auto_merge");
    // Not level 0 (or an older server without the field): low-risk rule.
    expect(effectiveMode({ ...full, level: 1 }, clean)).toBe("pull_request");
    expect(effectiveMode({ ...full, level: undefined }, clean)).toBe(
      "pull_request",
    );
    // The hard requirements still apply at level 0.
    expect(effectiveMode(full, { ...clean, reviewApproved: false })).toBe(
      "pull_request",
    );
    expect(effectiveMode(full, { ...clean, checksSkipped: true })).toBe(
      "pull_request",
    );
    expect(effectiveMode(full, { ...clean, checks: [] })).toBe("pull_request");
    // A check that also fails on the base commit verifies nothing.
    expect(
      effectiveMode(full, {
        ...clean,
        checks: [...passed, { name: "test", status: "skipped", durationMs: 1 }],
      }),
    ).toBe("pull_request");
    // A server mode below auto_merge is never upgraded.
    expect(effectiveMode({ ...full, mode: "pull_request" }, clean)).toBe(
      "pull_request",
    );
    expect(effectiveMode({ ...full, mode: "notify" }, clean)).toBe("notify");
  });

  it("labels the PR with the level actually used", () => {
    const full = taskPayload({ mode: "auto_merge", level: 0 });
    expect(prLevel(full, "auto_merge")).toBe(0);
    expect(prLevel(full, "pull_request")).toBe(2);
    expect(prLevel({ ...full, level: 1 }, "auto_merge")).toBe(1);
    expect(buildPrBody({ task: full, checks: [], level: 0 })).toContain(
      "level 0, Full autopilot: merges without human review",
    );
  });

  it("merges through GitHub auto-merge without bypassing branch protection", () => {
    const args = autoMergeArgs(
      taskPayload({ mode: "auto_merge", level: 0 }),
      7,
    );
    expect(args).toEqual([
      "pr",
      "merge",
      "7",
      "--repo",
      "acme/site",
      "--auto",
      "--squash",
    ]);
    expect(args.join(" ")).not.toMatch(/--admin|bypass/);
  });
});

describe("task verification", () => {
  beforeEach(() => {
    rotateTestSigningKey();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rotateTestSigningKey();
  });

  it("accepts a valid task and rejects tampering, other runners and expiry", () => {
    const publicKey = testPublicKey();
    const expected = { publicKey, runnerId: RUNNER_ID };
    const signed = signTask(taskPayload());
    expect(verifyTask(signed, expected)).toMatchObject({ ok: true });

    const tampered = { ...signed, body: signed.body.replace("app/**", "**") };
    expect(verifyTask(tampered, expected)).toEqual({
      ok: false,
      reason: "bad_signature",
    });

    const otherRunner = signTask(
      taskPayload({ runnerId: "44444444-4444-4444-8444-444444444444" }),
    );
    expect(verifyTask(otherRunner, expected)).toEqual({
      ok: false,
      reason: "wrong_runner",
    });

    const expired = signTask(
      taskPayload({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(verifyTask(expired, expected)).toMatchObject({
      ok: false,
      reason: "expired",
    });

    rotateTestSigningKey();
    expect(verifyTask(signTask(taskPayload()), expected)).toEqual({
      ok: false,
      reason: "bad_signature",
    });

    const invalid = signTask({ ...taskPayload(), title: "" });
    expect(
      verifyTask(invalid, { ...expected, publicKey: testPublicKey() }),
    ).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
  });
});

it("keeps VERSION in sync with cli/package.json", () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  );
  expect(pkg.version).toBe(VERSION);
  expect(pkg.bin.paradigma).toBe("dist/paradigma.mjs");
});
