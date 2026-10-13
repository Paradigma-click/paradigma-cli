import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export type CheckCommand = {
  name: string;
  command: string;
  args: string[];
  /** User-configured commands run through the shell. */
  shell?: boolean;
};

export type CheckResult = {
  name: string;
  status: "passed" | "failed" | "skipped" | "timeout";
  durationMs: number;
};

export const CHECK_SCRIPTS = ["lint", "typecheck", "test", "build"] as const;
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000;

const LOCKFILES: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** Lockfile in the app root first, then the repository root. */
export function detectPackageManager(
  repoRoot: string,
  appRoot: string,
): { manager: PackageManager; lockDir: string } | null {
  const dirs = [...new Set([join(repoRoot, appRoot), repoRoot])];
  for (const dir of dirs) {
    for (const [file, manager] of LOCKFILES) {
      if (existsSync(join(dir, file))) return { manager, lockDir: dir };
    }
  }
  return null;
}

export function readScripts(dir: string): Record<string, string> {
  try {
    const data = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as {
      scripts?: unknown;
    };
    if (data?.scripts && typeof data.scripts === "object")
      return Object.fromEntries(
        Object.entries(data.scripts as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
  } catch {}
  return {};
}

export function installArgs(
  manager: PackageManager,
  lockDir: string,
): CheckCommand {
  switch (manager) {
    case "pnpm":
      return {
        name: "install",
        command: "pnpm",
        args: ["install", "--frozen-lockfile"],
      };
    case "yarn":
      return {
        name: "install",
        command: "yarn",
        args: existsSync(join(lockDir, ".yarnrc.yml"))
          ? ["install", "--immutable"]
          : ["install", "--frozen-lockfile"],
      };
    case "bun":
      return {
        name: "install",
        command: "bun",
        args: ["install", "--frozen-lockfile"],
      };
    case "npm":
      return { name: "install", command: "npm", args: ["ci"] };
  }
}

/** Pure: the repo's own lint/typecheck/test/build scripts, in that order. */
export function planChecks(
  scripts: Record<string, string>,
  manager: PackageManager,
): CheckCommand[] {
  return CHECK_SCRIPTS.filter((name) => scripts[name]).map((name) => ({
    name,
    command: manager,
    args: ["run", name],
  }));
}

/** Per-repo overrides from config: shell commands, named after themselves. */
export function overrideChecks(commands: readonly string[]): CheckCommand[] {
  // Named by position: the command line can contain local paths.
  return commands.slice(0, 10).map((command, index) => ({
    name: `custom-${index + 1}`,
    command,
    args: [],
    shell: true,
  }));
}

export async function runCheck(
  check: CheckCommand,
  cwd: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CheckResult & { cancelled: boolean }> {
  const result = await run(check.command, check.args, {
    cwd,
    shell: check.shell,
    timeoutMs: options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    signal: options.signal,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
  });
  return {
    name: check.name,
    status: result.timedOut
      ? "timeout"
      : result.code === 0
        ? "passed"
        : "failed",
    durationMs: Math.min(result.durationMs, 3_600_000),
    cancelled: result.cancelled,
  };
}

/** Installs dependencies with the frozen lockfile only when missing. */
export async function ensureDependencies(
  worktree: string,
  appRoot: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const detected = detectPackageManager(worktree, appRoot);
  if (!detected) return null;
  if (existsSync(join(detected.lockDir, "node_modules"))) return null;
  return runCheck(
    installArgs(detected.manager, detected.lockDir),
    detected.lockDir,
    options,
  );
}

/** The checks to run for a worktree: overrides win over detection. */
export function resolveChecks(
  worktree: string,
  appRoot: string,
  overrides: readonly string[] | undefined,
): { checks: CheckCommand[]; needsInstall: boolean } {
  if (overrides?.length)
    return { checks: overrideChecks(overrides), needsInstall: false };
  const detected = detectPackageManager(worktree, appRoot);
  const scripts = readScripts(join(worktree, appRoot));
  if (!detected && !Object.keys(scripts).length)
    return { checks: [], needsInstall: false };
  return {
    checks: planChecks(scripts, detected?.manager ?? "npm"),
    needsInstall: Boolean(detected),
  };
}

export async function runChecks(
  checks: readonly CheckCommand[],
  cwd: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const results: CheckResult[] = [];
  let cancelled = false;
  for (const check of checks.slice(0, 10)) {
    const result = await runCheck(check, cwd, options);
    if (result.cancelled) {
      cancelled = true;
      break;
    }
    results.push({
      name: result.name,
      status: result.status,
      durationMs: result.durationMs,
    });
  }
  return { results, cancelled };
}
