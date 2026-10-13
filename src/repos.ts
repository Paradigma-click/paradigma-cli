import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { homePath } from "./config";
import { runOk } from "./exec";
import { isGitRepo, originFullName } from "./git";

const SKIP_DIRS = new Set(["node_modules", "Library", "vendor", "target"]);
const MAX_DIRS_PER_ROOT = 2000;

export function defaultScanRoots(cwd = process.cwd(), home = homedir()) {
  const roots = [
    join(home, "code"),
    join(home, "projects"),
    join(home, "dev"),
    join(home, "src"),
    join(home, "Developer"),
    join(home, "Documents", "GitHub"),
    join(home, "github"),
    homePath("repos"),
    cwd,
    dirname(cwd),
  ];
  return [...new Set(roots.map((root) => resolve(root)))].filter((root) =>
    existsSync(root),
  );
}

/** Git repositories at depth 0..maxDepth under each root. */
export function findGitRepos(roots: readonly string[], maxDepth = 2): string[] {
  const found = new Set<string>();
  for (const root of roots) {
    let visited = 0;
    const queue: Array<[string, number]> = [[root, 0]];
    while (queue.length && visited < MAX_DIRS_PER_ROOT) {
      const next = queue.shift();
      if (!next) break;
      const [dir, depth] = next;
      visited++;
      if (isGitRepo(dir)) {
        found.add(dir);
        continue;
      }
      if (depth >= maxDepth) continue;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        queue.push([join(dir, entry.name), depth + 1]);
      }
    }
  }
  return [...found];
}

/** fullName (lowercased owner/name) → first local clone found. */
export async function indexLocalClones(
  roots: readonly string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const repo of findGitRepos(roots)) {
    const fullName = await originFullName(repo);
    if (fullName && !index.has(fullName.toLowerCase()))
      index.set(fullName.toLowerCase(), repo);
  }
  return index;
}

/** Parses `--repo owner/name=PATH`. */
export function parseRepoOverride(
  value: string,
): { fullName: string; path: string } | null {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)=(.+)$/.exec(value);
  if (!match) return null;
  const path = match[2].startsWith("~/")
    ? join(homedir(), match[2].slice(2))
    : match[2];
  return { fullName: match[1], path: resolve(path) };
}

/** Confirms that `path` is a clone of `fullName` (by its origin remote). */
export async function verifyClone(path: string, fullName: string) {
  if (!isGitRepo(path)) return `${path} is not a git repository`;
  const origin = await originFullName(path);
  if (!origin) return `${path} has no GitHub origin remote`;
  if (origin.toLowerCase() !== fullName.toLowerCase())
    return `${path} is a clone of ${origin}, not ${fullName}`;
  return null;
}

export async function cloneRepo(fullName: string): Promise<string> {
  const [owner, name] = fullName.split("/");
  const target = homePath("repos", owner, name);
  if (isGitRepo(target)) return target;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await runOk("gh", ["repo", "clone", fullName, target], {
    timeoutMs: 15 * 60_000,
  });
  return target;
}
