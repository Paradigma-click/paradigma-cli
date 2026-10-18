import type { DiffBudget } from "./autopilot";

/**
 * Minimal glob matcher (dot files included, case sensitive):
 * `**` any number of segments, `*` within a segment, `?` one character,
 * `{a,b}` alternatives (nestable) and `[abc]` / `[!abc]` classes.
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/^\.\//, "");
  let source = "";
  let depth = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const atSegmentStart = index === 0 || pattern[index - 1] === "/";
        index++;
        if (atSegmentStart && pattern[index + 1] === "/") {
          index++;
          source += "(?:[^/]+/)*";
        } else if (atSegmentStart && index === pattern.length - 1) {
          source += ".*";
        } else {
          source += "[^/]*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      depth++;
      source += "(?:";
    } else if (char === "}" && depth > 0) {
      depth--;
      source += ")";
    } else if (char === "," && depth > 0) {
      source += "|";
    } else if (char === "[") {
      const end = pattern.indexOf("]", index + 2);
      if (end === -1) {
        source += "\\[";
      } else {
        let body = pattern.slice(index + 1, end);
        const negate = body.startsWith("!") || body.startsWith("^");
        if (negate) body = body.slice(1);
        body = body.replace(/[\\\]]/g, "\\$&");
        source += negate ? `[^/${body}]` : `[${body}]`;
        index = end;
      }
    } else if (char === "\\" && index + 1 < pattern.length) {
      source += pattern[++index].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  while (depth-- > 0) source += ")";
  return new RegExp(`^${source}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}

/**
 * Never touched by Autopilot, whatever the task allows: manifests, lockfiles,
 * CI, env files, git and agent configuration (which would steer later runs).
 */
export const FORBIDDEN_GLOBS = [
  "**/package.json",
  "**/pnpm-lock.yaml",
  "**/pnpm-workspace.yaml",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/bun.lock",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/.env*",
  ".github/**",
  ".gitlab-ci.yml",
  ".gitlab/**",
  ".circleci/**",
  ".buildkite/**",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "Jenkinsfile",
  ".husky/**",
  "**/.git/**",
  ".gitmodules",
  ".gitattributes",
  ".claude/**",
  ".cursor/**",
  ".codex/**",
  ".vscode/**",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.cursorrules",
] as const;

/**
 * Files the fix harness never reads, lists, writes or sends to a model, in every mode (hosted,
 * GitHub Action).
 */
export const SECRET_FILE_GLOBS = [
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.netrc",
  "**/credentials*.json",
  "**/service-account*.json",
  "**/.git/**",
] as const;

export type ChangedFile = {
  path: string;
  additions: number;
  deletions: number;
};

export type GuardReason =
  | "path_outside_repo"
  | "forbidden_path"
  | "path_not_allowed"
  | "too_many_files"
  | "too_many_lines"
  | "secret_detected";

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: GuardReason; message: string };

/** True when a git path escapes the repository or is not repo-relative. */
export function isOutsideRepo(path: string): boolean {
  if (!path || path.includes("\0")) return true;
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path))
    return true;
  return path.split("/").some((segment) => segment === ".." || segment === "");
}

export function isForbiddenPath(path: string): boolean {
  return matchesAny(path, FORBIDDEN_GLOBS);
}

export function checkPaths(
  paths: readonly string[],
  allowedPaths: readonly string[],
): GuardResult {
  for (const path of paths) {
    if (isOutsideRepo(path))
      return {
        ok: false,
        reason: "path_outside_repo",
        message: `Path is outside the repository: ${path.slice(0, 200)}`,
      };
  }
  for (const path of paths) {
    if (isForbiddenPath(path))
      return {
        ok: false,
        reason: "forbidden_path",
        message: `Protected path changed: ${path.slice(0, 200)}`,
      };
  }
  for (const path of paths) {
    if (!matchesAny(path, allowedPaths))
      return {
        ok: false,
        reason: "path_not_allowed",
        message: `Changed outside the allowed paths: ${path.slice(0, 200)}`,
      };
  }
  return { ok: true };
}

export function checkBudget(
  files: readonly ChangedFile[],
  budget: DiffBudget,
): GuardResult {
  if (files.length > budget.maxFiles)
    return {
      ok: false,
      reason: "too_many_files",
      message: `${files.length} files changed; the budget is ${budget.maxFiles}`,
    };
  const lines = files.reduce(
    (sum, file) => sum + file.additions + file.deletions,
    0,
  );
  if (lines > budget.maxLines)
    return {
      ok: false,
      reason: "too_many_lines",
      message: `${lines} lines changed; the budget is ${budget.maxLines}`,
    };
  return { ok: true };
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  [
    "aws_secret_key",
    /aws.{0,20}(?:secret|private).{0,20}[=:]\s*["']?[A-Za-z0-9/+=]{40}\b/i,
  ],
  ["private_key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["api_key", /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/],
  ["stripe_key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["slack_token", /\bxox[abposre]-[A-Za-z0-9-]{10,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["paradigma_token", /\bpdg_rt_[A-Za-z0-9_-]{16,}/],
  [
    "generic_secret",
    /\b(?:api[_-]?key|secret|token|passw(?:or)?d|auth)\w*["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=.]{24,}["']/i,
  ],
];

/** Returns the kind of the first secret found, never the secret itself. */
export function findSecret(lines: readonly string[]): string | null {
  for (const line of lines) {
    for (const [kind, pattern] of SECRET_PATTERNS) {
      if (pattern.test(line)) return kind;
    }
  }
  return null;
}

/** Added lines of a unified diff (without the leading "+"). */
export function addedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

/** Runs every guard; the first failure wins. */
export function runGuards(input: {
  files: readonly ChangedFile[];
  /** Every path touched, including the old side of renames/deletions. */
  paths: readonly string[];
  allowedPaths: readonly string[];
  budget: DiffBudget;
  diff: string;
}): GuardResult {
  const paths = checkPaths(input.paths, input.allowedPaths);
  if (!paths.ok) return paths;
  const budget = checkBudget(input.files, input.budget);
  if (!budget.ok) return budget;
  const secret = findSecret(addedLines(input.diff));
  if (secret)
    return {
      ok: false,
      reason: "secret_detected",
      message: `Possible secret (${secret}) in the added lines`,
    };
  return { ok: true };
}

/** Redacts anything that looks like a secret from short report text. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [, pattern] of SECRET_PATTERNS) {
    result = result.replace(
      new RegExp(pattern.source, `${pattern.flags}g`),
      "[redacted]",
    );
  }
  return result;
}
