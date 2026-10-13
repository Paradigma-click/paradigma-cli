import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "./checks";
import { ensurePrivateDir, homePath } from "./config";
import type { TaskPayload } from "./contract/autopilot";
import { LOW_RISK_CATEGORIES } from "./contract/autopilot";
import { runOk } from "./exec";
import type { ReviewVerdict } from "./prompt";

const GH_TIMEOUT = 2 * 60_000;

/** Writes the patch under ~/.paradigma/patches. It never leaves the machine. */
export async function savePatch(taskId: string, diff: string) {
  const dir = ensurePrivateDir(homePath("patches"));
  const file = join(dir, `${taskId}.patch`);
  await writeFile(file, diff, { mode: 0o600 });
  return file;
}

function escapeCell(text: string) {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Pure: PR body from the task, checks and self-review. No secrets, no diff. */
export function buildPrBody(input: {
  task: TaskPayload;
  checks: readonly CheckResult[];
  review?: ReviewVerdict;
  agent?: { name: string; version: string | null };
  level: 0 | 1 | 2;
}): string {
  const { task } = input;
  const lines = [
    `## ${task.title}`,
    "",
    task.revertsPrNumber
      ? `Reverts #${task.revertsPrNumber}.`
      : `Category: \`${task.category}\` · Risk: \`${task.risk}\``,
    "",
    "### Acceptance criteria",
    ...task.acceptance.map((item) => `- [ ] ${item}`),
    "",
    "### Checks",
  ];
  if (input.checks.length) {
    lines.push("| Check | Result | Duration |", "| --- | --- | --- |");
    for (const check of input.checks)
      lines.push(
        `| ${escapeCell(check.name)} | ${check.status} | ${formatDuration(check.durationMs)} |`,
      );
  } else {
    lines.push("No checks were run.");
  }
  if (input.review) {
    lines.push("", "### Self-review", `Verdict: **${input.review.verdict}**`);
    for (const reason of input.review.reasons) lines.push(`- ${reason}`);
  }
  lines.push("");
  if (input.agent)
    lines.push(
      `Written by ${input.agent.name}${input.agent.version ? ` ${input.agent.version}` : ""} on the author's machine.`,
    );
  lines.push(
    input.level === 0
      ? "Opened by Paradigma Autopilot (level 0, Full autopilot: merges without human review)."
      : `Opened by Paradigma Autopilot (level ${input.level}).`,
    "",
    `Paradigma-Task: ${task.taskId}`,
  );
  return lines.join("\n");
}

/** The PR URL and number from `gh pr create` output. */
export function parsePrUrl(
  output: string,
): { prUrl: string; prNumber: number } | null {
  const match = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/.exec(
    output,
  );
  if (!match) return null;
  return { prUrl: match[0], prNumber: Number(match[1]) };
}

/**
 * The server only accepts https://github.com/<owner>/<name>/pull/<n> for the
 * task's repository. GitHub names are case-insensitive, so normalize to the
 * task's spelling; any other repository is rejected (null).
 */
export function canonicalPrUrl(url: string, task: TaskPayload): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(
    url,
  );
  if (!match) return null;
  const same =
    match[1].toLowerCase() === task.repo.owner.toLowerCase() &&
    match[2].toLowerCase() === task.repo.name.toLowerCase();
  return same
    ? `https://github.com/${task.repo.owner}/${task.repo.name}/pull/${match[3]}`
    : null;
}

/**
 * auto_merge needs checks that ran and an approved self-review. Low-risk
 * categories merge on that alone. Anything else merges only when the signed
 * task says the policy acted at level 0 (full autopilot) and every check
 * passed outright: a check skipped because it also fails on the base commit
 * verifies nothing, so the task opens a PR instead. The guards (paths,
 * protected files, diff budget, secrets) already ran for every level.
 */
export function effectiveMode(
  task: TaskPayload,
  context: {
    checksSkipped: boolean;
    reviewApproved: boolean;
    checks?: readonly CheckResult[];
  },
): TaskPayload["mode"] {
  if (task.mode !== "auto_merge") return task.mode;
  if (context.checksSkipped || !context.reviewApproved) return "pull_request";
  const lowRisk =
    task.risk === "low" && LOW_RISK_CATEGORIES.includes(task.category);
  if (lowRisk) return "auto_merge";
  const checks = context.checks ?? [];
  const allPassed =
    checks.length > 0 && checks.every((check) => check.status === "passed");
  return task.level === 0 && allPassed ? "auto_merge" : "pull_request";
}

/** The level shown in the PR body for the mode actually used. */
export function prLevel(
  task: TaskPayload,
  mode: TaskPayload["mode"],
): 0 | 1 | 2 {
  if (mode !== "auto_merge") return 2;
  return task.level === 0 ? 0 : 1;
}

export async function createPullRequest(input: {
  cwd: string;
  task: TaskPayload;
  branch: string;
  bodyFile: string;
}) {
  const repo = `${input.task.repo.owner}/${input.task.repo.name}`;
  const output = await runOk(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      input.task.repo.defaultBranch,
      "--head",
      input.branch,
      "--title",
      input.task.title,
      "--body-file",
      input.bodyFile,
    ],
    { cwd: input.cwd, timeoutMs: GH_TIMEOUT },
  );
  const parsed = parsePrUrl(output);
  if (!parsed) throw new Error("gh pr create did not print a PR URL");
  const canonical = canonicalPrUrl(parsed.prUrl, input.task);
  if (!canonical)
    throw new Error(`gh opened a PR outside ${repo}: ${parsed.prUrl}`);
  return { prUrl: canonical, prNumber: parsed.prNumber };
}

/**
 * Squash auto-merge through GitHub, so branch protection (required checks
 * and reviews) still decides. Never pass --admin or any bypass flag.
 */
export function autoMergeArgs(task: TaskPayload, prNumber: number): string[] {
  return [
    "pr",
    "merge",
    String(prNumber),
    "--repo",
    `${task.repo.owner}/${task.repo.name}`,
    "--auto",
    "--squash",
  ];
}

export async function requestAutoMerge(
  cwd: string,
  task: TaskPayload,
  prNumber: number,
) {
  await runOk("gh", autoMergeArgs(task, prNumber), {
    cwd,
    timeoutMs: GH_TIMEOUT,
  });
}

/** Merge commit of a merged PR, for revert tasks. */
export async function mergeCommitOf(
  cwd: string,
  task: TaskPayload,
  prNumber: number,
): Promise<string> {
  const output = await runOk(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      `${task.repo.owner}/${task.repo.name}`,
      "--json",
      "mergeCommit",
    ],
    { cwd, timeoutMs: GH_TIMEOUT },
  );
  const data = JSON.parse(output) as { mergeCommit?: { oid?: unknown } };
  const sha = data?.mergeCommit?.oid;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
    throw new Error(`PR #${prNumber} has no merge commit`);
  return sha;
}
