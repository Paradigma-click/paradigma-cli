import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { ActionCaps } from "./contract/fix-action";
import type { TaskBrief } from "./contract/harness";
import {
  checkFixEdit,
  type FixLimits,
  isHiddenPath,
  lineChanges,
} from "./fix-limits";
import { isOutsideRepo, matchesGlob } from "./guards";

/**
 * The harness tools of `paradigma fix` over the checked-out repository (docs/36 §5.2): the same
 * names and limits as the hosted session. Every write is checked against the task's limits
 * before it reaches the disk; a refused write tells the model why. Secret files, `.git` and
 * `node_modules` are never listed, read or written. Contents stay in this process: only the
 * changed files go to Paradigma's static check, and nothing goes into the report.
 */

/** Files larger than this are skipped by list and search (generated or binary). */
const MAX_SCAN_BYTES = 1024 * 1024;
/** Files the walk visits at most. */
const MAX_WALK = 20_000;

export type CheckHtmlCall = (input: {
  url?: string;
  html?: string;
  files?: { path: string; content: string | null }[];
}) => Promise<unknown>;

export interface FixFinish {
  outcome: "fixed" | "skipped" | "failed";
  reason: string;
}

export class FixWorkspace {
  /** Original contents of each written file; undefined when it did not exist. */
  private readonly originals = new Map<string, string | undefined>();
  /** Current contents of each written file. */
  private readonly written = new Map<string, string>();
  readonly rejected: { reason: string; path: string }[] = [];
  readonly calls: Record<string, number> = {};
  finished: FixFinish | null = null;

  constructor(
    readonly root: string,
    private readonly limits: FixLimits,
    private readonly caps: ActionCaps,
    private readonly brief: TaskBrief,
    private readonly checkHtml: CheckHtmlCall,
  ) {}

  private count(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  private hidden(path: string) {
    return isOutsideRepo(path) || isHiddenPath(path, this.limits.secretGlobs);
  }

  /** The files the agent changed, with their new contents, sorted by path. */
  changedFiles(): { path: string; content: string }[] {
    return [...this.written.entries()]
      .filter(([path, content]) => this.originals.get(path) !== content)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({ path, content }));
  }

  /** The limits on the current edit, outside the model. */
  checkLimits() {
    return checkFixEdit(this.originals, this.written, this.limits);
  }

  /** Writes the agent's contents back if anything (a build, a formatter) changed them on disk. */
  async restoreWritten(): Promise<string[]> {
    const restored: string[] = [];
    for (const { path, content } of this.changedFiles()) {
      if (this.readDisk(path) === content) continue;
      await this.writeDisk(path, content);
      restored.push(path);
    }
    return restored;
  }

  /** The deepest existing ancestor of `full` resolves inside the root (no symlink escapes). */
  private insideRoot(full: string): boolean {
    try {
      const root = realpathSync(this.root);
      let probe = full;
      while (!existsSync(probe)) {
        const parent = dirname(probe);
        if (parent === probe) return false;
        probe = parent;
      }
      const real = realpathSync(probe);
      return real === root || real.startsWith(`${root}${sep}`);
    } catch {
      return false;
    }
  }

  private readDisk(path: string): string | undefined {
    const full = join(this.root, path);
    if (!this.insideRoot(full)) return undefined;
    try {
      const stat = lstatSync(full);
      if (!stat.isFile()) return undefined;
      return readFileSync(full, "utf8");
    } catch {
      return undefined;
    }
  }

  private async writeDisk(path: string, content: string) {
    const full = join(this.root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  private current(path: string): string | undefined {
    return this.written.has(path)
      ? this.written.get(path)
      : this.readDisk(path);
  }

  /** Every visible file, sorted, bounded. */
  private walk(dir = ""): string[] {
    const out: string[] = [];
    const visit = (rel: string) => {
      if (out.length >= MAX_WALK) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(join(this.root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && !this.hidden(path)) out.push(path);
        if (out.length >= MAX_WALK) return;
      }
    };
    visit(dir);
    // Files the agent created are on disk already; the walk sees them.
    return out.sort();
  }

  async get_task_brief(): Promise<TaskBrief> {
    this.count("get_task_brief");
    return this.brief;
  }

  async list_files(input: { dir?: string; glob?: string; limit?: number }) {
    this.count("list_files");
    const dir = (input.dir ?? "").replace(/^\.?\/*/, "").replace(/\/+$/, "");
    if (dir && this.hidden(`${dir}/x`)) return { files: [], truncated: false };
    const limit = Math.min(input.limit ?? this.caps.maxList, this.caps.maxList);
    const all = this.walk(dir).filter(
      (path) => !input.glob || matchesGlob(path, input.glob),
    );
    return { files: all.slice(0, limit), truncated: all.length > limit };
  }

  async read_file(input: {
    path: string;
    startLine?: number;
    endLine?: number;
  }) {
    this.count("read_file");
    if (typeof input.path !== "string" || this.hidden(input.path))
      return { ok: false as const, error: "This file is never read." };
    const content = this.current(input.path);
    if (content === undefined)
      return { ok: false as const, error: "No such file." };
    const lines = content.split("\n");
    const start = Math.max(1, input.startLine ?? 1);
    const end = Math.min(lines.length, input.endLine ?? lines.length);
    let slice = lines.slice(start - 1, end).join("\n");
    let truncated = false;
    if (slice.length > this.caps.maxReadBytes) {
      slice = slice.slice(0, this.caps.maxReadBytes);
      truncated = true;
    }
    return {
      ok: true as const,
      path: input.path,
      content: slice,
      totalLines: lines.length,
      truncated,
    };
  }

  async search(input: {
    query: string;
    regex?: boolean;
    glob?: string;
    limit?: number;
  }) {
    this.count("search");
    let pattern: RegExp;
    try {
      pattern = input.regex
        ? new RegExp(String(input.query))
        : new RegExp(
            String(input.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          );
    } catch {
      return { matches: [], truncated: false };
    }
    const limit = Math.min(
      input.limit ?? this.caps.maxMatches,
      this.caps.maxMatches,
    );
    const matches: { path: string; line: number; text: string }[] = [];
    let truncated = false;
    for (const path of this.walk()) {
      if (input.glob && !matchesGlob(path, input.glob)) continue;
      const full = join(this.root, path);
      try {
        if (!this.written.has(path) && lstatSync(full).size > MAX_SCAN_BYTES)
          continue;
      } catch {
        continue;
      }
      const content = this.current(path);
      if (content === undefined || content.includes("\0")) continue;
      for (const [index, line] of content.split("\n").entries()) {
        if (!pattern.test(line)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({ path, line: index + 1, text: line.slice(0, 300) });
      }
      if (truncated) break;
    }
    return { matches, truncated };
  }

  async write_file(input: { path: string; content: string }) {
    this.count("write_file");
    const path = typeof input.path === "string" ? input.path : "";
    const content = typeof input.content === "string" ? input.content : "";
    if (content.length > this.caps.maxWriteChars) {
      this.rejected.push({ reason: "file_too_large", path });
      return {
        ok: false as const,
        reason: "file_too_large",
        message: `The content is over ${this.caps.maxWriteChars} characters.`,
      };
    }
    if (isOutsideRepo(path)) {
      this.rejected.push({ reason: "path_outside_repo", path });
      return {
        ok: false as const,
        reason: "path_outside_repo",
        message: `Path is outside the repository: ${path.slice(0, 200)}`,
      };
    }
    const originals = new Map(this.originals);
    if (!originals.has(path)) originals.set(path, this.readDisk(path));
    const next = new Map(this.written);
    next.set(path, content);
    const result = checkFixEdit(originals, next, this.limits);
    if (!result.ok) {
      this.rejected.push({ reason: result.reason, path });
      return {
        ok: false as const,
        reason: result.reason,
        message: result.message,
      };
    }
    // A symlink or directory in the way is never followed or replaced.
    const full = join(this.root, path);
    if (
      !this.insideRoot(full) ||
      (existsSync(full) && !lstatSync(full).isFile())
    ) {
      this.rejected.push({ reason: "path_outside_repo", path });
      return {
        ok: false as const,
        reason: "path_outside_repo",
        message: `Not a regular file: ${path.slice(0, 200)}`,
      };
    }
    if (!this.originals.has(path))
      this.originals.set(path, originals.get(path));
    this.written.set(path, content);
    await this.writeDisk(path, content);
    const counts = lineChanges(this.originals.get(path) ?? "", content);
    return {
      ok: true as const,
      path,
      additions: counts.additions,
      deletions: counts.deletions,
      budget: {
        files: result.changes.length,
        lines: result.lines,
        maxFiles: this.limits.diffBudget.maxFiles,
        maxLines: this.limits.diffBudget.maxLines,
      },
    };
  }

  async check_html(input: { url?: string; html?: string }) {
    this.count("check_html");
    if (input.html !== undefined || input.url !== undefined) {
      // The server needs the page's URL: HTML without one is read as the first page item's page.
      const url =
        input.url ??
        this.brief.acceptance.find((item) => item.scope === "page")?.url ??
        this.brief.acceptance[0]?.url;
      if (url === undefined)
        return {
          ok: false,
          error: "Pass the url of the page this HTML belongs to.",
        };
      return this.checkHtml({
        url,
        ...(input.html !== undefined ? { html: input.html } : {}),
      });
    }
    return this.checkHtml({ files: this.changedFiles() });
  }

  async finish_task(input: { outcome: string; reason: string }) {
    this.count("finish_task");
    const outcome =
      input.outcome === "fixed" || input.outcome === "skipped"
        ? input.outcome
        : "failed";
    this.finished = {
      outcome,
      reason: String(input.reason ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 200),
    };
    return { ok: true as const };
  }

  /** Runs one tool call by name; unknown tools and thrown errors become an error result. */
  async call(name: string, input: unknown): Promise<unknown> {
    const args = (input && typeof input === "object" ? input : {}) as never;
    try {
      switch (name) {
        case "get_task_brief":
          return await this.get_task_brief();
        case "list_files":
          return await this.list_files(args);
        case "read_file":
          return await this.read_file(args);
        case "search":
          return await this.search(args);
        case "write_file":
          return await this.write_file(args);
        case "check_html":
          return await this.check_html(args);
        case "finish_task":
          return await this.finish_task(args);
        default:
          return {
            ok: false,
            error: `Unknown tool: ${String(name).slice(0, 60)}`,
          };
      }
    } catch (error) {
      if (error instanceof FixReportableError) throw error;
      if (error instanceof Error && error.name === "FixToolRefused")
        return { ok: false, error: error.message.slice(0, 400) };
      return { ok: false, error: "The tool failed." };
    }
  }
}

/** An error that ends the run with a reason category (e.g. the token expired mid-run). */
export class FixReportableError extends Error {
  constructor(
    readonly reason:
      | "token_expired"
      | "internal_error"
      | "provider_error"
      | "rate_limited"
      | "no_model_key",
    message: string,
  ) {
    super(message);
    this.name = "FixReportableError";
  }
}
