import { run } from "./exec";

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
