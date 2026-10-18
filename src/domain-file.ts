import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, runOk } from "./exec";

/**
 * Publishes the domain verification file for `paradigma init`: on a branch
 * with a PR via the person's own `gh` when available (in a separate worktree,
 * so their checkout is untouched), otherwise as a local file to commit.
 * Idempotent: an open PR or an already committed file is reused.
 */

export const VERIFY_BRANCH = "paradigma/domain-verification";
const GIT_TIMEOUT = 2 * 60_000;

export type DomainFileResult =
  | { mode: "pr"; url: string; created: boolean; path: string }
  | { mode: "committed"; branch: string; path: string }
  | { mode: "local"; path: string; changed: boolean; reason?: string };

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

function git(cwd: string, args: string[]) {
  return runOk("git", args, { cwd, timeoutMs: GIT_TIMEOUT, env: gitEnv() });
}

/** Repository-relative path (posix) of the file for an app root. */
export function verificationRepoPath(appRoot: string, repoPath: string) {
  return [appRoot, repoPath].filter(Boolean).join("/").replace(/\/+/g, "/");
}

function writeLocal(file: string, contents: string): boolean {
  let current: string | null = null;
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  if (current?.trim() === contents.trim()) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${contents}\n`);
  return true;
}

async function defaultBranch(root: string, fullName: string): Promise<string> {
  const head = await run(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { cwd: root, timeoutMs: 10_000 },
  );
  const fromRef = head.stdout.trim().replace(/^origin\//, "");
  if (head.code === 0 && fromRef) return fromRef;
  const gh = await run(
    "gh",
    [
      "repo",
      "view",
      fullName,
      "--json",
      "defaultBranchRef",
      "-q",
      ".defaultBranchRef.name",
    ],
    { cwd: root, timeoutMs: 30_000 },
  );
  return (gh.code === 0 && gh.stdout.trim()) || "main";
}

export async function ghReady(cwd: string): Promise<boolean> {
  const status = await run("gh", ["auth", "status"], {
    cwd,
    timeoutMs: 15_000,
  });
  return status.code === 0;
}

export async function publishVerificationFile(input: {
  repoRoot: string;
  fullName: string;
  /** Repository-relative path, e.g. public/.well-known/paradigma-verification.txt */
  path: string;
  contents: string;
  /** Where production serves it, e.g. /.well-known/paradigma-verification.txt */
  servedPath: string;
  productionUrl: string;
  usePullRequest: boolean;
}): Promise<DomainFileResult> {
  const local = join(input.repoRoot, input.path);
  const fallback = (reason?: string): DomainFileResult => ({
    mode: "local",
    path: local,
    changed: writeLocal(local, input.contents),
    reason,
  });
  if (!input.usePullRequest) return fallback();
  if (!(await ghReady(input.repoRoot)))
    return fallback("GitHub CLI not installed or not logged in");

  try {
    const open = await runOk(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        input.fullName,
        "--head",
        VERIFY_BRANCH,
        "--state",
        "open",
        "--json",
        "url",
        "-q",
        ".[0].url",
      ],
      { cwd: input.repoRoot, timeoutMs: 30_000 },
    );
    if (open.trim().startsWith("https://"))
      return { mode: "pr", url: open.trim(), created: false, path: input.path };

    const base = await defaultBranch(input.repoRoot, input.fullName);
    await git(input.repoRoot, [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${base}:refs/remotes/origin/${base}`,
    ]);
    const committed = await run(
      "git",
      ["show", `origin/${base}:${input.path}`],
      {
        cwd: input.repoRoot,
        timeoutMs: 10_000,
      },
    );
    if (
      committed.code === 0 &&
      committed.stdout.trim() === input.contents.trim()
    )
      return { mode: "committed", branch: base, path: input.path };

    const worktree = mkdtempSync(join(tmpdir(), "paradigma-verify-"));
    rmSync(worktree, { recursive: true, force: true });
    try {
      await git(input.repoRoot, [
        "worktree",
        "add",
        "-B",
        VERIFY_BRANCH,
        worktree,
        `origin/${base}`,
      ]);
      writeLocal(join(worktree, input.path), input.contents);
      await git(worktree, ["add", "--", input.path]);
      await git(worktree, [
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "Add Paradigma domain verification file",
      ]);
      await git(worktree, [
        "push",
        "--no-verify",
        "--force-with-lease",
        "-u",
        "origin",
        `${VERIFY_BRANCH}:refs/heads/${VERIFY_BRANCH}`,
      ]);
      const body = [
        `Proves ownership of ${input.productionUrl} to Paradigma by serving \`${input.servedPath}\`.`,
        "",
        "The file only contains a public verification token. After this is merged and deployed, run `npx paradigma-cli verify`.",
      ].join("\n");
      const output = await runOk(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          input.fullName,
          "--base",
          base,
          "--head",
          VERIFY_BRANCH,
          "--title",
          "Add Paradigma domain verification file",
          "--body",
          body,
        ],
        { cwd: worktree, timeoutMs: 60_000 },
      );
      const parsed = parsePrUrl(output);
      if (!parsed) throw new Error("gh pr create did not print a PR URL");
      return { mode: "pr", url: parsed.prUrl, created: true, path: input.path };
    } finally {
      await run("git", ["worktree", "remove", "--force", worktree], {
        cwd: input.repoRoot,
        timeoutMs: 60_000,
      });
      await run("git", ["worktree", "prune"], {
        cwd: input.repoRoot,
        timeoutMs: 60_000,
      });
    }
  } catch (error) {
    return fallback(
      `Could not open a PR (${(error as Error).message.slice(0, 200)})`,
    );
  }
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
