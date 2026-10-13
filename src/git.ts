import { existsSync } from "node:fs";
import { type ExecOptions, run, runOk } from "./exec";
import type { ChangedFile } from "./guards";

const GIT_TIMEOUT = 5 * 60_000;

function git(cwd: string, args: string[], options: ExecOptions = {}) {
  return runOk("git", args, {
    cwd,
    timeoutMs: GIT_TIMEOUT,
    ...options,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
  });
}

/** owner/name from an https, ssh or scp-style GitHub remote URL. */
export function parseGithubRemote(url: string): string | null {
  const trimmed = url.trim();
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      trimmed,
    );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export async function originFullName(repoPath: string): Promise<string | null> {
  // Raw config value: `git remote get-url` would expand insteadOf rewrites.
  const result = await run("git", ["config", "--get", "remote.origin.url"], {
    cwd: repoPath,
    timeoutMs: 10_000,
  });
  if (result.code !== 0) return null;
  return parseGithubRemote(result.stdout);
}

export function isGitRepo(path: string) {
  return existsSync(`${path}/.git`);
}

export function autopilotBranch(taskId: string) {
  return `paradigma/autopilot/${taskId.slice(0, 8)}`;
}

export async function fetchBase(repoPath: string, branch: string) {
  await git(repoPath, [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  return (await git(repoPath, ["rev-parse", `origin/${branch}`])).trim();
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseSha: string,
) {
  await git(repoPath, ["worktree", "add", "-B", branch, worktreePath, baseSha]);
}

/** Detached worktree used to re-run a failing check on the base commit. */
export async function addDetachedWorktree(
  repoPath: string,
  worktreePath: string,
  baseSha: string,
) {
  await git(repoPath, ["worktree", "add", "--detach", worktreePath, baseSha]);
}

/** Best effort: removes the worktree and the local task branch. */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch?: string,
) {
  await run("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoPath,
    timeoutMs: 60_000,
  });
  await run("git", ["worktree", "prune"], { cwd: repoPath, timeoutMs: 60_000 });
  if (branch)
    await run("git", ["branch", "-D", branch], {
      cwd: repoPath,
      timeoutMs: 30_000,
    });
}

/**
 * Every path touched in the working tree, untracked files included, with the
 * old side of renames and copies (`git status --porcelain -z`).
 */
export function parsePorcelainZ(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const original = entries[++index];
      if (original) paths.push(original);
    }
  }
  return [...new Set(paths)];
}

export async function statusPaths(worktree: string) {
  return parsePorcelainZ(
    await git(worktree, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
  );
}

/** Parses `git diff --numstat -z --no-renames`. Binary files count 0 lines. */
export function parseNumstatZ(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    files.push({
      path: match[3],
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return files;
}

export async function stageAll(worktree: string) {
  await git(worktree, ["add", "--all"]);
}

/** Changed files between `base` and the index. */
export async function stagedNumstat(worktree: string, base: string) {
  return parseNumstatZ(
    await git(worktree, [
      "diff",
      "--cached",
      "--no-renames",
      "--numstat",
      "-z",
      base,
    ]),
  );
}

/** Unified diff between `base` and the index. Kept local, never uploaded. */
export async function stagedDiff(worktree: string, base: string) {
  return git(
    worktree,
    ["diff", "--cached", "--no-renames", "--binary", "--no-color", base],
    { maxOutputBytes: 64 * 1024 * 1024 },
  );
}

/** Drops unstaged edits and untracked files created after staging. */
export async function discardUnstaged(worktree: string) {
  await git(worktree, ["checkout", "--", "."]);
  await git(worktree, ["clean", "-fd"]);
}

export function commitMessage(title: string, taskId: string) {
  const subject = `paradigma: ${title.replace(/\s+/g, " ").trim()}`.slice(
    0,
    200,
  );
  return `${subject}\n\nParadigma-Task: ${taskId}\n`;
}

/** Commits the index with the user's own git identity (hooks skipped). */
export async function commit(worktree: string, title: string, taskId: string) {
  await git(worktree, [
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    commitMessage(title, taskId),
  ]);
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

export async function push(worktree: string, branch: string) {
  await git(worktree, [
    "push",
    "--no-verify",
    "-u",
    "origin",
    `${branch}:refs/heads/${branch}`,
  ]);
}

/** Stages the inverse of `sha` (merge commits revert against parent 1). */
export async function revertCommit(worktree: string, sha: string) {
  const parents = (
    await git(worktree, ["rev-list", "--parents", "-n", "1", sha])
  )
    .trim()
    .split(" ")
    .slice(1);
  const args = ["revert", "--no-edit", "--no-commit"];
  if (parents.length > 1) args.push("-m", "1");
  await git(worktree, [...args, sha]);
}

export async function fetchCommit(repoPath: string, sha: string) {
  const present = await run("git", ["cat-file", "-e", `${sha}^{commit}`], {
    cwd: repoPath,
    timeoutMs: 10_000,
  });
  if (present.code === 0) return;
  await git(repoPath, ["fetch", "--no-tags", "origin", sha]);
}
