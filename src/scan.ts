import type { CliProjectScan } from "./contract/cli-api";
import type { Io } from "./io";
import { type PlatformClient, PlatformError } from "./platform";

/**
 * The project's four-pillar scan for `paradigma check all` and `paradigma init`: wait for the
 * first completed scan (requesting one when none is queued), then print the four scores and the
 * fix-first list. Counts only, never pool points: the scan says what was found and how to fix it.
 */

export const SCAN_POLL_MS = 5_000;
/** Default wait for a scan, in seconds (`--wait`). */
export const SCAN_WAIT_SECONDS = 180;

export type ScanWait =
  /** A completed scan; a newer one may still be running. */
  | { state: "completed"; scan: CliProjectScan }
  /** Still queued or running at the deadline. */
  | { state: "running"; scan: CliProjectScan }
  /** The newest scan failed and no completed scan exists. */
  | { state: "failed"; scan: CliProjectScan }
  /** No completed scan and a new one may not start yet (one ran minutes ago). */
  | { state: "too_soon"; scan: CliProjectScan };

const inFlight = (scan: CliProjectScan) =>
  scan.status === "queued" || scan.status === "running";

/** Network drops, timeouts and server hiccups; worth another poll. */
function transient(error: unknown) {
  return (
    error instanceof PlatformError &&
    (error.code === "network" ||
      error.code === "timeout" ||
      (error.status !== undefined && error.status >= 500))
  );
}

/**
 * Returns the latest completed scan at once when there is one. Otherwise requests a scan unless
 * one is in flight, and polls until it completes, fails or `waitSeconds` pass.
 */
export async function waitForScan(input: {
  client: PlatformClient;
  io: Io;
  projectId: string;
  waitSeconds: number;
  /** Called once, before the first poll. */
  onWait?: (scan: CliProjectScan) => void;
}): Promise<ScanWait> {
  const { client, io, projectId } = input;
  let scan = await client.projectScan(projectId);
  if (scan.scannedAt !== null) return { state: "completed", scan };
  if (!inFlight(scan)) {
    const requested = await client.requestProjectScan(projectId);
    scan = requested;
    if (scan.scannedAt !== null) return { state: "completed", scan };
    if (!inFlight(scan))
      return {
        state: requested.reason === "too_soon" ? "too_soon" : "failed",
        scan,
      };
  }
  const deadline = io.now() + input.waitSeconds * 1000;
  if (io.now() < deadline) input.onWait?.(scan);
  while (io.now() < deadline) {
    await io.sleep(Math.min(SCAN_POLL_MS, deadline - io.now()));
    try {
      scan = await client.projectScan(projectId);
    } catch (error) {
      if (!transient(error)) throw error;
      continue;
    }
    if (scan.scannedAt !== null) return { state: "completed", scan };
    if (!inFlight(scan)) return { state: "failed", scan };
  }
  return { state: "running", scan };
}

const MARK: Record<string, string> = { fail: "✗", partial: "!" };

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pillarName(scan: CliProjectScan, pillar: string) {
  return scan.pillars.find((entry) => entry.pillar === pillar)?.name ?? pillar;
}

/** "SEO 92 · AEO 71 · GEO 48 · Agents 96"; pillars without a score show "–". */
export function scoreLine(scan: CliProjectScan): string {
  return scan.pillars
    .map((entry) => `${entry.name} ${entry.score ?? "–"}`)
    .join(" · ");
}

/** The `check all` report. */
export function renderProjectScan(scan: CliProjectScan, limit = 5): string[] {
  const lines = [`Four-pillar scan · ${host(scan.productionUrl)}`];
  if (scan.scannedAt)
    lines.push(
      `Scanned ${scan.scannedAt.replace("T", " ").slice(0, 16)} UTC${inFlight(scan) ? " (a new scan is running)" : ""}`,
    );
  lines.push("");
  const width = Math.max(...scan.pillars.map((entry) => entry.name.length), 0);
  for (const entry of scan.pillars) {
    const { counts } = entry;
    const score =
      entry.score === null
        ? "no applicable checks"
        : `${entry.score}/100${entry.label ? ` · ${entry.label}` : ""}`;
    lines.push(
      `  ${entry.name.padEnd(width)}  ${score}`,
      `  ${" ".repeat(width)}  ${counts.pass} passed · ${counts.partial} partial · ${counts.fail} failed · ${counts.na} not applicable`,
    );
  }
  lines.push("");
  if (scan.fixes.length === 0) {
    lines.push("Fix these first: nothing, every applicable check passed.");
  } else {
    lines.push(
      `Fix these first (${scan.openFixes > scan.fixes.length ? `${scan.fixes.length} of ${scan.openFixes}` : scan.fixes.length}):`,
    );
    scan.fixes.slice(0, limit).forEach((fix, index) => {
      const pillars = fix.pillars.map((pillar) => pillarName(scan, pillar));
      lines.push(
        `  ${index + 1}. ${MARK[fix.status] ?? "!"} ${fix.title} (${pillars.join(", ")})`,
        `     ${fix.summary}`,
      );
      if (fix.fix) lines.push(`     Fix: ${fix.fix}`);
      if (fix.autopilot) lines.push("     Autopilot can ship this fix.");
    });
    const more = scan.openFixes - Math.min(limit, scan.fixes.length);
    if (more > 0) lines.push(`  and ${more} more in the dashboard`);
  }
  if (scan.locked) {
    lines.push(
      "",
      "Locked until you verify the domain: these fixes are queued as tasks.",
    );
    if (scan.next) lines.push(`Verify: ${scan.next.command}`);
  }
  lines.push(`Full report: ${scan.dashboardUrl}`);
  return lines;
}

/** The command that shows the scan later. */
export function checkAllCommand(projectId: string) {
  return `npx paradigma-cli check all --project ${projectId}`;
}

/** `init`'s `done.scan`: the four scores, the top 3 fixes and the lock, or the state and how to check later. */
export function initScanSummary(projectId: string, result: ScanWait | null) {
  const check = checkAllCommand(projectId);
  if (!result) return { status: "unavailable", check };
  if (result.state !== "completed")
    return {
      status: result.state === "too_soon" ? "failed" : result.state,
      check,
    };
  const { scan } = result;
  return {
    status: "completed",
    scannedAt: scan.scannedAt,
    pillars: scan.pillars.map(({ pillar, name, score, label }) => ({
      pillar,
      name,
      score,
      label,
    })),
    fixes: scan.fixes
      .slice(0, 3)
      .map(({ title, pillar, status, summary, fix, autopilot }) => ({
        title,
        pillar,
        status,
        summary,
        fix,
        autopilot,
      })),
    openFixes: scan.openFixes,
    locked: scan.locked,
    ...(scan.locked
      ? { lockedReason: "Locked until you verify the domain" }
      : {}),
    dashboardUrl: scan.dashboardUrl,
    check,
  };
}

/** `init`'s human lines for the scan. */
export function renderInitScan(
  projectId: string,
  result: ScanWait | null,
): string[] {
  const check = checkAllCommand(projectId);
  if (!result || result.state === "failed" || result.state === "too_soon")
    return [`• The site scan is not available yet. Check later: ${check}`];
  if (result.state === "running")
    return [`• The site scan is still running. Check later: ${check}`];
  const { scan } = result;
  const lines = [`✓ Site scan: ${scoreLine(scan)}`];
  if (scan.fixes.length === 0)
    lines.push("  Nothing to fix first: every applicable check passed.");
  else {
    lines.push("  Fix these first:");
    scan.fixes.slice(0, 3).forEach((fix, index) => {
      lines.push(`    ${index + 1}. ${fix.title}`);
      if (fix.fix) lines.push(`       Fix: ${fix.fix}`);
    });
  }
  if (scan.locked)
    lines.push(
      "  Locked until you verify the domain: these fixes are queued as tasks.",
    );
  lines.push(`  All results: ${check}`);
  return lines;
}
