import { parseArgs } from "node:util";
import { clientFor, resolveProject } from "./commands";
import { loadConfig, requireToken } from "./config";
import {
  CHECK_PILLARS,
  type CheckPillar,
  type PublicCheck,
  type PublicRiskCheck,
  publicCheckErrorSchema,
  publicCheckSchema,
  publicRiskCheckSchema,
  type RiskLevel,
} from "./contract/public-check";
import { ActionRequired, type Io, Reporter, UsageError } from "./io";
import {
  checkAllCommand,
  renderProjectScan,
  SCAN_WAIT_SECONDS,
  waitForScan,
} from "./scan";
import { VERSION } from "./version";

/**
 * `paradigma check <seo|aeo|geo|agents> <domain> [--json]`: one pillar from the free public API, no
 * sign-in. The scan runs on Paradigma's server (the check code stays private); the CLI prints a
 * compact report, or the API JSON with --json.
 *
 * `paradigma check risk <domain> [--json]` is the free penalty risk checker: a private result for
 * the caller, one free use per 30 days (a signed-in CLI checking its own projects gets the member
 * limit), never cached.
 *
 * `paradigma check all [--project ID] [--wait SECONDS] [--json]` is the product's four-pillar scan
 * of a signed-in project: the latest completed one, or a new one it requests and waits for.
 */

export const CHECK_USAGE =
  "Usage: paradigma check <seo|aeo|geo|agents> <domain> [--json] [--rescan]\n       paradigma check risk <domain> [--json]\n       paradigma check all [--project ID] [--wait SECONDS] [--json]";

const PILLAR_NAMES: Record<CheckPillar, string> = {
  seo: "SEO",
  aeo: "AEO",
  geo: "GEO",
  agents: "Agents",
};

/** Exit code for a failure the API explained: 2 bad input, 3 wait (rate limit), 1 otherwise. */
export function exitCodeFor(error: string): number {
  if (error === "invalid_domain" || error === "unknown_pillar") return 2;
  if (
    error === "rate_limited" ||
    error === "rescan_too_soon" ||
    error === "already_used"
  )
    return 3;
  return 1;
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/** The compact terminal report: score, label, the fix-first list and the suggestions count. */
export function renderCheck(report: PublicCheck, limit = 5): string[] {
  const pillar = report.pillars[0];
  if (!pillar) return ["No result."];
  const lines = [
    `${report.tool.name} · ${report.target.host}`,
    pillar.score === null
      ? "No applicable checks"
      : `Score ${formatScore(pillar.score)}/100 · ${pillar.label ?? ""}`.trim(),
  ];
  if (pillar.cap) lines.push(`Capped at ${pillar.cap.at}: ${pillar.cap.label}`);
  lines.push(
    `${pillar.counts.pass} passed · ${pillar.counts.partial} partial · ${pillar.counts.fail} failed · ${pillar.counts.na} not applicable`,
    `Scanned ${report.snapshot.scannedAt.replace("T", " ").slice(0, 16)} UTC${report.snapshot.cached ? " (cached)" : ""}`,
    "",
  );
  if (pillar.fixFirst.length === 0) {
    lines.push("Fix these first: nothing, every applicable check passed.");
  } else {
    lines.push(`Fix these first (${pillar.fixFirst.length}):`);
    pillar.fixFirst.slice(0, limit).forEach((item, index) => {
      lines.push(
        `  ${index + 1}. ${item.status === "fail" ? "✗" : "!"} ${item.title}`,
        `     ${item.summary}`,
      );
      if (item.fix) lines.push(`     Fix: ${item.fix.copy}`);
    });
    if (pillar.fixFirst.length > limit)
      lines.push(`  and ${pillar.fixFirst.length - limit} more`);
  }
  const open = pillar.suggestions.filter(
    (item) => item.status === "fail" || item.status === "partial",
  ).length;
  lines.push(
    "",
    `${pillar.suggestions.length} suggestions, not scored (${open} open)`,
  );
  const others = report.teaser.map((item) =>
    item.issues === 0
      ? `no ${PILLAR_NAMES[item.pillar]} issues`
      : `${item.issues} ${PILLAR_NAMES[item.pillar]} ${item.issues === 1 ? "issue" : "issues"}`,
  );
  if (others.length > 0)
    lines.push(
      `Other pillars: ${others.join(" · ")} (see all free in Paradigma)`,
    );
  lines.push(`Full report: ${report.tool.resultUrl}`);
  return lines;
}

const RISK_LEVEL_NAMES: Record<RiskLevel, string> = {
  none: "None found",
  low: "Low",
  elevated: "Elevated",
  high: "High",
};

const CHANNEL_NAMES: Record<string, string> = {
  google: "Google",
  bing: "Bing",
  ai: "AI engines",
  browsers: "Browsers",
  social: "Social",
};

function pathOf(page: string): string {
  try {
    const url = new URL(page);
    return url.pathname.length > 1 ? url.pathname : "/";
  } catch {
    return page;
  }
}

/** The penalty risk result in the terminal: level, each family with its evidence, fix and policy. */
export function renderRiskCheck(report: PublicRiskCheck, pages = 3): string[] {
  const lines = [
    `Penalty risk checker · ${report.target.host}`,
    `Penalty risk: ${RISK_LEVEL_NAMES[report.level]}${report.found.length ? ` · ${report.found.length} ${report.found.length === 1 ? "family" : "families"} found` : ""}`,
    "Evidence, not a verdict: scans run from Paradigma's servers, so a clean result is not proof.",
    "",
  ];
  report.found.forEach((family, index) => {
    const channels = family.channels
      .map((channel) => CHANNEL_NAMES[channel] ?? channel)
      .join(", ");
    lines.push(
      `${index + 1}. ${family.label}`,
      `   ${RISK_LEVEL_NAMES[family.level]} · ${family.documented ? "Documented" : "Inferred"}${channels ? ` · ${channels}` : ""}`,
    );
    for (const finding of family.findings) {
      lines.push(`   - ${finding.evidence}`);
      if (finding.pages.length) {
        const shown = finding.pages.slice(0, pages).map(pathOf);
        const more = finding.pages.length - shown.length;
        lines.push(
          `     Pages: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
        );
      }
      if (finding.fix) lines.push(`     Fix: ${finding.fix}`);
    }
    if (family.policyUrl) lines.push(`   Policy: ${family.policyUrl}`);
  });
  if (report.found.length) lines.push("");
  lines.push(
    `Checked and clean: ${report.clean.length} ${report.clean.length === 1 ? "family" : "families"}`,
  );
  if (report.notChecked.length)
    lines.push(
      `Needs a signed-in scan: ${report.notChecked.map((family) => family.label).join(", ")}`,
    );
  lines.push(
    `Manual actions: ${report.tool.manualActionsUrl}`,
    `Verify your domain to watch this daily: ${report.tool.signUpUrl}`,
  );
  return lines;
}

function serverFor(io: Io, flag: string | undefined): string {
  const value = flag ?? io.env.PARADIGMA_SERVER ?? loadConfig().server;
  return value.replace(/\/+$/, "");
}

export async function checkCommand(io: Io, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      rescan: { type: "boolean" },
      server: { type: "string" },
      project: { type: "string" },
      wait: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const out = new Reporter(io, Boolean(values.json));
  const [target, domain, ...extra] = positionals;
  if (target === "all") {
    if (domain !== undefined) throw new UsageError(CHECK_USAGE);
    return checkAll(io, out, values.project, values.wait);
  }
  if (target === "risk") {
    if (!domain || extra.length > 0 || values.rescan)
      throw new UsageError(CHECK_USAGE);
    return checkRisk(io, out, domain, values.server, Boolean(values.json));
  }
  if (
    !target ||
    !(CHECK_PILLARS as readonly string[]).includes(target) ||
    !domain ||
    extra.length > 0
  )
    throw new UsageError(CHECK_USAGE);
  const pillar = target as CheckPillar;

  const server = serverFor(io, values.server);
  const fetchImpl = io.fetch ?? ((input, init) => fetch(input, init));
  if (!values.json && io.interactive)
    io.stderr(
      `Checking ${domain} (${PILLAR_NAMES[pillar]}), this can take a minute…\n`,
    );
  let response: Response;
  try {
    response = await fetchImpl(
      `${server}/api/tools/v1/${pillar}/${encodeURIComponent(domain.trim())}`,
      {
        method: values.rescan ? "POST" : "GET",
        headers: {
          accept: "application/json",
          "user-agent": `paradigma-cli/${VERSION}`,
        },
        signal: AbortSignal.timeout(200_000),
      },
    );
  } catch {
    throw new Error(`Could not reach ${server}. Check your connection.`);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Unexpected answer from ${server} (HTTP ${response.status}).`,
    );
  }
  if (!response.ok) {
    const error = publicCheckErrorSchema.safeParse(body);
    const message = error.success
      ? error.data.message
      : `The check failed (HTTP ${response.status}).`;
    if (values.json) io.stdout(`${text.trim()}\n`);
    else io.stderr(`${message}\n`);
    process.exitCode = exitCodeFor(error.success ? error.data.error : "");
    return;
  }
  if (values.json) {
    io.stdout(`${text.trim()}\n`);
    return;
  }
  const report = publicCheckSchema.safeParse(body);
  if (!report.success)
    throw new Error(
      "The answer did not match the report schema. Update the CLI.",
    );
  for (const line of renderCheck(report.data)) out.line(line);
}

/**
 * `paradigma check risk <domain>`: the penalty risk checker. Sends the saved CLI token when the
 * server is the configured one, so a signed-in member's own projects use the member limit; any
 * other domain is the one free use.
 */
async function checkRisk(
  io: Io,
  out: Reporter,
  domain: string,
  serverFlag: string | undefined,
  json: boolean,
) {
  const server = serverFor(io, serverFlag);
  const config = loadConfig();
  const token =
    config.token && config.server.replace(/\/+$/, "") === server
      ? config.token
      : undefined;
  const fetchImpl = io.fetch ?? ((input, init) => fetch(input, init));
  if (!json && io.interactive)
    io.stderr(`Checking ${domain} for penalty risk, this can take a minute…\n`);
  let response: Response;
  try {
    response = await fetchImpl(
      `${server}/api/tools/v1/risk/${encodeURIComponent(domain.trim())}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": `paradigma-cli/${VERSION}`,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(200_000),
      },
    );
  } catch {
    throw new Error(`Could not reach ${server}. Check your connection.`);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Unexpected answer from ${server} (HTTP ${response.status}).`,
    );
  }
  if (!response.ok) {
    const error = publicCheckErrorSchema.safeParse(body);
    const message = error.success
      ? error.data.message
      : `The check failed (HTTP ${response.status}).`;
    if (json) io.stdout(`${text.trim()}\n`);
    else io.stderr(`${message}\n`);
    process.exitCode = exitCodeFor(error.success ? error.data.error : "");
    return;
  }
  if (json) {
    io.stdout(`${text.trim()}\n`);
    return;
  }
  const report = publicRiskCheckSchema.safeParse(body);
  if (!report.success)
    throw new Error(
      "The answer did not match the penalty risk schema. Update the CLI.",
    );
  for (const line of renderRiskCheck(report.data)) out.line(line);
}

async function checkAll(
  io: Io,
  out: Reporter,
  projectFlag: string | undefined,
  waitFlag: string | undefined,
) {
  const wait = waitFlag === undefined ? SCAN_WAIT_SECONDS : Number(waitFlag);
  if (!Number.isInteger(wait) || wait < 0 || wait > 3600)
    throw new UsageError("--wait must be 0 to 3600 seconds");
  const config = requireToken(loadConfig());
  const ctx = { io, out, config, client: clientFor(config, io) };
  const project = await resolveProject(ctx, projectFlag);
  const result = await waitForScan({
    client: ctx.client,
    io,
    projectId: project.id,
    waitSeconds: wait,
    onWait: (scan) => {
      if (!out.json)
        io.stderr(
          `Scanning ${scan.productionUrl}, this takes a minute or two (waiting up to ${wait} s)…\n`,
        );
    },
  });
  const check = checkAllCommand(project.id);
  if (result.state === "running")
    throw new ActionRequired(
      `The scan is still running. Check again in a minute: ${check}`,
      { projectId: project.id, scan: { status: "running" }, check },
    );
  if (result.state === "too_soon")
    throw new ActionRequired(
      `A scan ran a few minutes ago and no result is available. Try again in a few minutes: ${check}`,
      { projectId: project.id, scan: { status: result.scan.status }, check },
    );
  if (result.state === "failed") {
    out.result(
      { ok: false, error: "scan_failed", projectId: project.id, check },
      () =>
        io.stderr(
          `The scan of ${result.scan.productionUrl} failed. Check that the site is reachable, then run: ${check}\n`,
        ),
    );
    process.exitCode = 1;
    return;
  }
  out.result(result.scan, () => {
    for (const line of renderProjectScan(result.scan)) out.line(line);
  });
}
