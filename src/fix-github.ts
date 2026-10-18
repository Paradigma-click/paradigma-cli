import type { ExecOptions, ExecResult } from "./exec";
import { runGuards } from "./guards";
import type { FetchLike } from "./io";

/**
 * Git and GitHub for `paradigma fix` in the customer's workflow (docs/36 §7): stage only the
 * files the agent wrote, re-run the shared guards on the staged diff, commit to
 * `paradigma/fix-<task>`, push with the checkout's `GITHUB_TOKEN` credential and open the pull
 * request through the REST API with that token. Never prints or returns contents.
 */

export type Exec = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export class FixGitError extends Error {
  constructor(
    readonly reason: "git_failed" | "limits" | "pr_failed" | "pr_permission",
    message: string,
  ) {
    super(message);
    this.name = "FixGitError";
  }
}

const GIT_TIMEOUT = 5 * 60_000;
const BOT = [
  "-c",
  "user.name=Paradigma",
  "-c",
  "user.email=bot@paradigma.click",
];

async function git(exec: Exec, cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    timeoutMs: GIT_TIMEOUT,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.code !== 0)
    // Only the subcommand: git's stderr can quote paths or remote URLs with credentials.
    throw new FixGitError("git_failed", `git ${args[0]} failed`);
  return result.stdout;
}

/** `git diff --numstat -z` output → per-file counts (binary files count as 1 line each side). */
export function parseNumstatZ(output: string) {
  const files: { path: string; additions: number; deletions: number }[] = [];
  const entries = output.split("\0").filter(Boolean);
  for (const entry of entries) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
    if (!match) continue;
    files.push({
      path: match[3],
      additions: match[1] === "-" ? 1 : Number(match[1]),
      deletions: match[2] === "-" ? 1 : Number(match[2]),
    });
  }
  return files;
}

/**
 * Commits the agent's files to the task branch, after the guards pass on what git itself staged.
 * Returns the commit SHA.
 */
export async function commitFix(input: {
  exec: Exec;
  cwd: string;
  branch: string;
  paths: readonly string[];
  message: string;
  allowedPaths: readonly string[];
  diffBudget: { maxFiles: number; maxLines: number };
}): Promise<{ sha: string; lines: number; paths: string[] }> {
  const { exec, cwd } = input;
  await git(exec, cwd, ["checkout", "-B", input.branch]);
  await git(exec, cwd, ["add", "--", ...input.paths]);
  const names = (
    await git(exec, cwd, ["diff", "--cached", "--name-only", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  const files = parseNumstatZ(
    await git(exec, cwd, ["diff", "--cached", "--numstat", "-z"]),
  );
  const diff = await git(exec, cwd, ["diff", "--cached", "--no-color", "-U0"]);
  const guard = runGuards({
    files,
    paths: names,
    allowedPaths: input.allowedPaths,
    budget: input.diffBudget,
    diff,
  });
  if (!guard.ok) throw new FixGitError("limits", guard.message);
  if (names.length === 0) throw new FixGitError("limits", "Nothing to commit.");
  await git(exec, cwd, [...BOT, "commit", "--no-verify", "-m", input.message]);
  const sha = (await git(exec, cwd, ["rev-parse", "HEAD"])).trim();
  return {
    sha,
    lines: files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
    paths: names,
  };
}

/** Pushes the task branch (it is Paradigma's own branch: a retried run replaces it). */
export async function pushFix(exec: Exec, cwd: string, branch: string) {
  await git(exec, cwd, [
    "push",
    "--force",
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
}

export const PR_PERMISSION_HELP =
  'The workflow token cannot open pull requests. In the repository, open Settings > Actions > General and turn on "Allow GitHub Actions to create and approve pull requests".';

/** Opens the pull request with the workflow's token, or finds the one this branch already has. */
export async function openFixPull(input: {
  fetch: FetchLike;
  apiUrl: string;
  token: string;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}): Promise<{ url: string; number: number }> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "paradigma-cli",
  };
  const base = `${input.apiUrl.replace(/\/+$/, "")}/repos/${input.repo}`;
  let response: Response;
  try {
    response = await input.fetch(`${base}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.branch,
        base: input.base,
        draft: input.draft,
        maintainer_can_modify: true,
      }),
    });
  } catch {
    throw new FixGitError("pr_failed", "GitHub could not be reached.");
  }
  if (response.ok) {
    const pull = (await response.json()) as {
      html_url: string;
      number: number;
    };
    return { url: pull.html_url, number: pull.number };
  }
  if (response.status === 403)
    throw new FixGitError("pr_permission", PR_PERMISSION_HELP);
  if (response.status === 422) {
    // A retried run: the branch already has an open pull request.
    const owner = input.repo.split("/")[0];
    const existing = await input
      .fetch(
        `${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}`,
        { headers },
      )
      .catch(() => null);
    if (existing?.ok) {
      const pulls = (await existing.json()) as {
        html_url: string;
        number: number;
      }[];
      if (pulls[0]) return { url: pulls[0].html_url, number: pulls[0].number };
    }
  }
  throw new FixGitError(
    "pr_failed",
    `GitHub refused the pull request (HTTP ${response.status}).`,
  );
}
