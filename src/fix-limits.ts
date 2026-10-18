import type { DiffBudget } from "./contract/autopilot";
import { checkBudget, checkPaths, findSecret, matchesAny } from "./guards";

/**
 * The limits of `paradigma fix` (docs/36 §5.2, GitHub Action mode), pure: the same rules the
 * hosted session enforces on every write (`src/lib/harness/limits.ts`), over the files the Action
 * changed. `allowedPaths` and `diffBudget` come from the server's task, the forbidden paths, the
 * secret patterns and the budget math from the shared contract. The model's claims never count.
 */

/** Largest file the Action writes (the hosted writer's limit). */
export const MAX_FIX_WRITE_BYTES = 256 * 1024;

export type FixLimitReason =
  | "path_outside_repo"
  | "forbidden_path"
  | "path_not_allowed"
  | "too_many_files"
  | "too_many_lines"
  | "secret_detected"
  | "secret_file"
  | "file_too_large"
  | "cleanup_scope";

export type FixLimitResult =
  | { ok: true; changes: FixChange[]; lines: number }
  | { ok: false; reason: FixLimitReason; message: string };

export interface FixChange {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified";
}

export interface FixLimits {
  allowedPaths: readonly string[];
  diffBudget: DiffBudget;
  secretGlobs: readonly string[];
  category: string;
}

/** Original contents of every file the Action touched (undefined: it did not exist). */
export type FixOriginals = ReadonlyMap<string, string | undefined>;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

const LCS_CELL_CAP = 4_000_000;

function lcsLength(a: string[], b: string[]): number {
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[b.length];
}

/** Additions and deletions between two versions of a file, as a pull request counts them. */
export function lineChanges(
  before: string,
  after: string,
): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start])
    start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 || midB.length === 0)
    return { additions: midB.length, deletions: midA.length };
  // Past the cap every middle line counts: only ever over-counts, the safe side for a budget.
  if (midA.length * midB.length > LCS_CELL_CAP)
    return { additions: midB.length, deletions: midA.length };
  const common = lcsLength(midA, midB);
  return { additions: midB.length - common, deletions: midA.length - common };
}

/** Lines in `after` that were not in `before` (for the secret scan). */
export function addedLines(before: string, after: string): string[] {
  const seen = new Map<string, number>();
  for (const line of splitLines(before))
    seen.set(line, (seen.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of splitLines(after)) {
    const count = seen.get(line) ?? 0;
    if (count > 0) seen.set(line, count - 1);
    else added.push(line);
  }
  return added;
}

/** Never read, listed, written or sent to a model: secret files and git internals. */
export function isHiddenPath(path: string, secretGlobs: readonly string[]) {
  const segments = path.split("/");
  return (
    segments.includes(".git") ||
    segments.includes("node_modules") ||
    matchesAny(path, secretGlobs)
  );
}

/**
 * Whether the edit (originals → current contents) stays inside the task's limits: repository
 * paths only, no protected or secret file, only allowed paths, a cleanup never adds a file, no
 * file over the size limit, within the budget and no secret in added lines.
 */
export function checkFixEdit(
  originals: FixOriginals,
  current: ReadonlyMap<string, string>,
  limits: FixLimits,
): FixLimitResult {
  const changes: FixChange[] = [];
  for (const path of [...current.keys()].sort()) {
    const before = originals.get(path);
    const after = current.get(path) ?? "";
    if (before === after) continue;
    changes.push({
      path,
      ...lineChanges(before ?? "", after),
      status: before === undefined ? "added" : "modified",
    });
  }
  const paths = checkPaths(
    changes.map((change) => change.path),
    limits.allowedPaths,
  );
  if (!paths.ok) return paths;
  const secretFile = changes.find((change) =>
    isHiddenPath(change.path, limits.secretGlobs),
  );
  if (secretFile)
    return {
      ok: false,
      reason: "secret_file",
      message: `Secret files are never written: ${secretFile.path.slice(0, 200)}`,
    };
  if (limits.category === "policy_cleanup") {
    const added = changes.find((change) => change.status === "added");
    if (added)
      return {
        ok: false,
        reason: "cleanup_scope",
        message: `A penalty risk cleanup never creates a file: ${added.path.slice(0, 200)}`,
      };
  }
  const large = changes.find(
    (change) =>
      new TextEncoder().encode(current.get(change.path) ?? "").length >
      MAX_FIX_WRITE_BYTES,
  );
  if (large)
    return {
      ok: false,
      reason: "file_too_large",
      message: `File is over ${MAX_FIX_WRITE_BYTES / 1024} KB: ${large.path.slice(0, 200)}`,
    };
  const budget = checkBudget(changes, limits.diffBudget);
  if (!budget.ok) return budget;
  for (const change of changes) {
    const secret = findSecret(
      addedLines(
        originals.get(change.path) ?? "",
        current.get(change.path) ?? "",
      ),
    );
    if (secret)
      return {
        ok: false,
        reason: "secret_detected",
        message: `Possible secret (${secret}) in the added lines of ${change.path.slice(0, 200)}`,
      };
  }
  return {
    ok: true,
    changes,
    lines: changes.reduce((sum, c) => sum + c.additions + c.deletions, 0),
  };
}
