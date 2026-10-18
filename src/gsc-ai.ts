import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { context, resolveProject } from "./commands";
import type { CliGscAiStatus } from "./contract/cli-api";
import { type Io, UsageError } from "./io";

/**
 * `paradigma gsc-ai`: the Search Console Generative AI report, which Google keeps out of its API.
 * With no arguments it prints the last import and the exact export steps with the deep link;
 * `import` sends the export (.zip or CSVs) for the server to parse with the dashboard's parser.
 * File contents are read only to send them and are never printed.
 */

/** Same limits as the dashboard upload. */
export const GSC_AI_MAX_FILES = 5;
export const GSC_AI_MAX_BYTES = 512 * 1024;
/** A fresh import is due after this many days (the monthly setup task). */
const EVERY_DAYS = 30;
const DAY = 86_400_000;
const NAME = /\.(?:csv|zip)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const USAGE =
  "Usage: paradigma gsc-ai [import <file.zip|file.csv>... [--from YYYY-MM-DD --to YYYY-MM-DD]] [--project ID] [--json]";

/** Whether the last import is missing or older than 30 days. */
export function gscAiImportDue(
  lastImportedAt: string | null,
  now: number,
): boolean {
  if (!lastImportedAt) return true;
  const at = Date.parse(lastImportedAt);
  return Number.isNaN(at) || now - at >= EVERY_DAYS * DAY;
}

/** Pure: what `paradigma gsc-ai` prints. */
export function gscAiStatusLines(
  status: CliGscAiStatus,
  now: number,
): string[] {
  const last = status.lastImport;
  const lines = [
    `Search Console AI report   ${
      last
        ? `last import ${last.importedAt.slice(0, 10)} (${last.fromDate} to ${last.toDate}, ${last.pages} page${last.pages === 1 ? "" : "s"})`
        : "never imported"
    }`,
  ];
  if (!status.verified) {
    lines.push(
      `  Verify the domain first: npx paradigma-cli verify --project ${status.projectId}`,
    );
    return lines;
  }
  if (!status.searchConsoleConnected)
    lines.push(
      `  Search Console is not connected: npx paradigma-cli google --project ${status.projectId}`,
    );
  lines.push(
    gscAiImportDue(last?.importedAt ?? null, now)
      ? "Export it now (Google has no API for this report):"
      : "Next export (monthly):",
    `  1. Open ${status.reportUrl}`,
    "     (Search Console, Performance, Generative AI; signed in with access to the property)",
    "  2. Pick the longest date range, then Export and download the .zip",
    `  3. Run: npx paradigma-cli gsc-ai import <file.zip> --project ${status.projectId}`,
    `  Settings: ${status.settingsUrl}`,
  );
  return lines;
}

/** Reads the export files for upload; checks names and sizes first. Never returns their text. */
export async function readGscAiFiles(
  cwd: string,
  paths: string[],
): Promise<{ name: string; base64: string }[]> {
  if (!paths.length) throw new UsageError(USAGE);
  if (paths.length > GSC_AI_MAX_FILES)
    throw new UsageError(
      `Send one .zip or up to ${GSC_AI_MAX_FILES} .csv files.`,
    );
  let total = 0;
  const files: { name: string; base64: string }[] = [];
  for (const path of paths) {
    const name = basename(path);
    if (!NAME.test(name))
      throw new UsageError(`${name}: only .zip and .csv files are accepted.`);
    const full = resolve(cwd, path);
    let size: number;
    try {
      const info = await stat(full);
      if (!info.isFile()) throw new Error("not a file");
      size = info.size;
    } catch {
      throw new UsageError(`${name}: file not found.`);
    }
    if (size === 0) throw new UsageError(`${name}: the file is empty.`);
    total += size;
    if (total > GSC_AI_MAX_BYTES)
      throw new UsageError(
        `The export is larger than ${GSC_AI_MAX_BYTES / 1024} KB. Send the Generative AI report export as Search Console downloads it.`,
      );
    files.push({ name, base64: (await readFile(full)).toString("base64") });
  }
  return files;
}

export async function gscAiCommand(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      project: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const [action, ...paths] = positionals;
  if (action !== undefined && action !== "import" && action !== "status")
    throw new UsageError(USAGE);
  if (action === "status" && paths.length) throw new UsageError(USAGE);
  if (
    (values.from && !DATE.test(values.from)) ||
    (values.to && !DATE.test(values.to)) ||
    Boolean(values.from) !== Boolean(values.to)
  )
    throw new UsageError("Pass both --from and --to as YYYY-MM-DD.");

  if (action !== "import") {
    const ctx = context(io, Boolean(values.json));
    const project = await resolveProject(ctx, values.project);
    const status = await ctx.client.gscAiStatus(project.id);
    ctx.out.result(status, () => {
      for (const line of gscAiStatusLines(status, Date.now()))
        ctx.out.line(line);
    });
    if (
      !status.verified ||
      gscAiImportDue(status.lastImport?.importedAt ?? null, Date.now())
    )
      process.exitCode = 3;
    return;
  }

  // Files first: a bad path fails before any network call.
  const files = await readGscAiFiles(io.cwd, paths);
  const ctx = context(io, Boolean(values.json));
  const project = await resolveProject(ctx, values.project);
  const result = await ctx.client.importGscAi(project.id, {
    files,
    ...(values.from && values.to
      ? { fromDate: values.from, toDate: values.to }
      : {}),
  });
  ctx.out.result(result, () =>
    ctx.out.line(
      `✓ Imported the Search Console AI report: ${result.fromDate} to ${result.toDate}, ${result.pages} page${result.pages === 1 ? "" : "s"}. ${result.settingsUrl}`,
    ),
  );
}
