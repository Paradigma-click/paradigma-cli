import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, normalizeServer } from "./api";
import { clientFor, newIdempotencyKey, printMcpResult } from "./commands";
import { type Config, configPath, loadConfig, updateConfig } from "./config";
import { type AutopilotLevel, LEVEL_LABELS } from "./contract/autopilot";
import type {
  CliStatusResponse,
  CliTargetRepository,
  CliVerificationInstructions,
} from "./contract/cli-api";
import { isSetupTokenShape } from "./contract/setup";
import {
  canAutoFix,
  connectVercelGit,
  type DeployReport,
  deployDoctor,
  deployLine,
  deploySummary,
  needsDeployFix,
} from "./deploy";
import {
  type Candidate,
  chooseAppRoot,
  detectRepo,
  inferSiteCandidates,
} from "./detect";
import { publishVerificationFile, verificationRepoPath } from "./domain-file";
import { appAccessUrl, githubRepositoryId } from "./github-access";
import { ActionRequired, type Io, Reporter, UsageError } from "./io";
import {
  hostAgent,
  installedMcpAgent,
  installMcp,
  MCP_AGENTS,
  type McpAgent,
} from "./mcp-install";
import { pairDevice } from "./pairing";
import { PlatformClient, PlatformError } from "./platform";
import {
  initScanSummary,
  renderInitScan,
  SCAN_WAIT_SECONDS,
  type ScanWait,
  waitForScan,
} from "./scan";
import { VERSION } from "./version";

const AGENT_LABELS: Record<McpAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};
const POLL_MS = 5_000;

type Field = { field: string; flag: string; candidates: Candidate[] };

/**
 * `paradigma init`: sign in (setup token or device pairing), find the
 * repository and app, create or reuse the project, verify the domain (or
 * publish the verification file), connect the MCP server, print the
 * site scan's scores and top fixes, and the optional next steps. Every step
 * reads server state first, so running it again resumes where it stopped.
 * `--json` emits one JSON event per line.
 */
export async function initCommand(io: Io, args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      token: { type: "string" },
      server: { type: "string" },
      dir: { type: "string" },
      url: { type: "string" },
      brand: { type: "string" },
      category: { type: "string" },
      "use-case": { type: "string" },
      "app-root": { type: "string" },
      mcp: { type: "string" },
      name: { type: "string" },
      wait: { type: "string" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      "no-pr": { type: "boolean" },
      "fix-deploy": { type: "boolean" },
      level: { type: "string" },
      "confirm-full-autopilot": { type: "boolean" },
    },
    strict: true,
  });
  const out = new Reporter(io, Boolean(values.json));
  const step = (
    name: string,
    status: string,
    data: Record<string, unknown> = {},
  ) => out.event("step", { step: name, status, ...data });
  const wait = values.wait === undefined ? 600 : Number(values.wait);
  if (!Number.isInteger(wait) || wait < 0 || wait > 3600)
    throw new UsageError("--wait must be 0 to 3600 seconds");
  if (
    values.mcp &&
    values.mcp !== "none" &&
    !(MCP_AGENTS as readonly string[]).includes(values.mcp)
  )
    throw new UsageError("--mcp must be claude, codex, cursor or none");
  const autopilotFlags = parseAutopilotFlags(values);
  if (values.token !== undefined && !isSetupTokenShape(values.token))
    // Never echo the value: it may be a credential pasted in the wrong place.
    throw new UsageError(
      "--token is not a Paradigma setup token (pdg_setup_…). Copy a fresh prompt from the dashboard.",
    );

  // 1. Credential ──────────────────────────────────────────────────────────
  let config = loadConfig();
  const server = normalizeServer(
    values.server ?? io.env.PARADIGMA_SERVER ?? config.server,
  );
  const sameServer = config.token && normalizeServer(config.server) === server;
  const savedWorks = async () => {
    if (!sameServer) return false;
    try {
      await clientFor(config, io).status();
      return true;
    } catch (error) {
      if (error instanceof PlatformError && error.code === "invalid_token")
        return false;
      throw error;
    }
  };
  const host = hostAgent(io.env);
  if (values.token) {
    const anonymous = new PlatformClient({
      server,
      fetch: io.fetch,
      userAgent: `paradigma-cli/${VERSION}`,
    });
    try {
      const exchanged = await anonymous.exchangeSetupToken({
        token: values.token,
        runnerName: (
          values.name ??
          `${host ? AGENT_LABELS[host] : "paradigma CLI"} on ${hostname()}`
        ).slice(0, 100),
        platform: platform().slice(0, 40),
        agents: [],
        cliVersion: VERSION,
      });
      config = await updateConfig((next) => {
        next.server = normalizeServer(exchanged.server);
        next.runnerId = exchanged.runnerId;
        next.token = exchanged.runnerToken;
        next.publicKey = exchanged.publicKey;
      });
      step("auth", "done", {
        method: "setup_token",
        runnerId: exchanged.runnerId,
      });
      out.line(
        `✓ Signed in (credential ${exchanged.runnerId}). Config: ${configPath()}`,
      );
    } catch (error) {
      if (!(error instanceof PlatformError && error.code === "invalid_token"))
        throw error;
      // A rerun after success: the one-time token is spent, the saved credential still works.
      if (!(await savedWorks()))
        throw new ActionRequired(
          "The setup token is invalid, expired or already used. Copy a fresh prompt from the dashboard onboarding page.",
        );
      step("auth", "done", { method: "saved_credential" });
      out.line(
        "✓ Setup token already used; continuing with the saved credential.",
      );
    }
  } else if (await savedWorks()) {
    step("auth", "done", { method: "saved_credential" });
    out.line(`✓ Signed in to ${config.server}.`);
  } else {
    step("auth", "action_required", { method: "device_pairing" });
    const paired = await pairDevice({
      server,
      name: (values.name ?? hostname()).slice(0, 100),
      io,
      say: (line) => (out.json ? io.stderr(`${line}\n`) : out.line(line)),
    }).catch((error: unknown) => {
      // Device pairing lives behind AUTOPILOT_ENABLED; setup tokens do not.
      if (error instanceof ApiError && error.code === "disabled")
        throw new ActionRequired(
          `Copy the setup prompt from ${server}/setup (it includes a one-time token) and run \`npx paradigma-cli init --token …\`.`,
          { url: `${server}/setup` },
        );
      throw error;
    });
    config = await updateConfig((next) => {
      next.server = server;
      next.runnerId = paired.runnerId;
      next.token = paired.runnerToken;
      next.publicKey = paired.publicKey;
    });
    step("auth", "done", {
      method: "device_pairing",
      runnerId: paired.runnerId,
    });
  }
  const client = clientFor(config, io);
  let status: CliStatusResponse = await client.status();

  // 2. Repository and GitHub App ─────────────────────────────────────────────
  const detected = await detectRepo(
    values.dir ? resolve(io.cwd, values.dir) : io.cwd,
  );
  if (!detected)
    throw new ActionRequired(
      "Run `npx paradigma-cli init` inside your project's git repository (no GitHub `origin` remote found).",
    );
  step("repository", "done", { fullName: detected.fullName });
  out.line(`✓ Repository ${detected.fullName}`);
  const findRepo = async () => {
    const targets = await client.targets();
    return {
      targets,
      repo: targets.repositories.find(
        (r) => r.fullName.toLowerCase() === detected.fullName.toLowerCase(),
      ),
    };
  };
  let { targets, repo } = await findRepo();
  if (!repo) {
    const owner = detected.fullName.split("/")[0] ?? "";
    const installed = (targets.installations ?? []).some(
      (item) => item.accountLogin.toLowerCase() === owner.toLowerCase(),
    );
    // With the app already on this account, open its settings with this
    // repository pre-selected: one confirmation instead of a fresh install.
    const url = appAccessUrl({
      installUrl: status.links.installApp ?? targets.installGithubAppUrl,
      owner,
      installations: targets.installations ?? [],
      repositoryId: installed
        ? await githubRepositoryId(detected.fullName, detected.root)
        : null,
    });
    step("github_app", "action_required", { url, waitSeconds: wait });
    out.line(
      installed
        ? `Give the Paradigma GitHub App access to ${detected.fullName} (it is pre-selected; confirm on GitHub):`
        : `Install the Paradigma GitHub App on ${detected.fullName} (write access needed):`,
    );
    out.line(`    ${url ?? "see the dashboard onboarding page"}`);
    if (!installed)
      out.line(
        '    Tip: choose "All repositories" so new repositories need no extra step.',
      );
    if (url && io.interactive && !out.json) io.openUrl(url);
    const deadline = io.now() + wait * 1000;
    if (wait > 0)
      out.line(
        `Waiting up to ${Math.round(wait / 60)} min for the installation and app detection…`,
      );
    while (!repo && io.now() < deadline) {
      await io.sleep(POLL_MS);
      try {
        ({ targets, repo } = await findRepo());
      } catch (error) {
        // A dropped request while waiting is not a reason to give up: the
        // next poll retries until the deadline.
        if (!isTransient(error)) throw error;
      }
    }
    if (!repo)
      throw new ActionRequired(
        `The GitHub App is not installed on ${detected.fullName} yet (or no site was detected yet). Install it, then run \`npx paradigma-cli init\` again.`,
        { url },
      );
  }
  step("github_app", "done", { repoId: repo.repoId });
  out.line("✓ GitHub App installed");

  // 3. App root ──────────────────────────────────────────────────────────────
  const roots = repo.apps.map((app) => app.appRoot);
  const appRoot =
    values["app-root"] !== undefined
      ? roots.includes(values["app-root"])
        ? values["app-root"]
        : null
      : chooseAppRoot(roots, detected.relativeDir);
  if (appRoot === null) {
    const candidates = roots.map((value) => ({
      value,
      source: "detected app",
    }));
    out.event("needs_input", {
      fields: [{ field: "appRoot", flag: "--app-root", candidates }],
    });
    throw new ActionRequired(
      `Choose the app with --app-root (one of: ${roots.map((r) => JSON.stringify(r)).join(", ")}).`,
    );
  }
  const app = repo.apps.find((a) => a.appRoot === appRoot);

  // 4. Project ───────────────────────────────────────────────────────────────
  const project = await ensureProject({
    io,
    out,
    client,
    repo,
    repoRoot: detected.root,
    appRoot,
    existing: app,
    values,
  });
  await updateConfig((next) => {
    next.defaultProjectId = project.projectId;
  });

  // 4b. Deploy pipeline ──────────────────────────────────────────────────────
  // Merged fixes only go live when the host deploys merges (Git integration or
  // a deploy workflow). Static detection plus the person's own host CLI login.
  const deploy = await checkDeploy({
    out,
    repoRoot: detected.root,
    appRoot,
    fix: Boolean(values["fix-deploy"]),
    yes: Boolean(values.yes),
  });

  // 5. Domain ────────────────────────────────────────────────────────────────
  let verified = project.verified;
  if (verified) {
    step("domain", "done", { projectId: project.projectId });
    out.line("✓ Domain verified");
  } else {
    const result = await client.verify(project.projectId, {
      idempotencyKey: newIdempotencyKey(),
    });
    verified = result.verified;
    if (verified) {
      step("domain", "done", {
        method: result.method,
        projectId: project.projectId,
      });
      out.line(`✓ Domain verified (${result.method}); first audit requested`);
    } else {
      const instructions: CliVerificationInstructions =
        result.instructions ??
        (await client.verification(project.projectId)).instructions;
      const file = await publishVerificationFile({
        repoRoot: detected.root,
        fullName: detected.fullName,
        path: verificationRepoPath(appRoot, instructions.file.repoPath),
        contents: instructions.file.contents,
        servedPath: instructions.file.path,
        productionUrl: project.productionUrl,
        usePullRequest: !values["no-pr"],
      });
      const reverify = `npx paradigma-cli verify --project ${project.projectId}`;
      step("domain", "action_required", {
        projectId: project.projectId,
        attempts: result.attempts,
        file,
        dns: instructions.dns,
        reverify,
      });
      if (file.mode === "pr")
        out.line(
          `• Domain verification PR ${file.created ? "opened" : "already open"}: ${file.url}`,
        );
      else if (file.mode === "committed")
        out.line(
          `• The verification file is already on ${file.branch}; it must be deployed to production.`,
        );
      else {
        if (file.reason) out.warn(file.reason);
        out.line(`• Wrote ${file.path}. Commit it and deploy to production.`);
      }
      out.line(
        `  After it is live at ${instructions.file.url}, run: ${reverify}`,
      );
      out.line(
        `  Or add DNS TXT ${instructions.dns.name} = ${instructions.dns.value}, then run the same command.`,
      );
    }
  }

  // 6. MCP ───────────────────────────────────────────────────────────────────
  const agent = await chooseMcpAgent(
    out,
    values.mcp,
    Boolean(values.yes),
    host,
  );
  if (agent) {
    const result = await installMcp(agent, config.server, {
      env: io.env as NodeJS.ProcessEnv,
    });
    const { status: outcome, ...detail } = result;
    step("mcp", outcome === "failed" ? "failed" : "done", {
      ...detail,
      result: outcome,
    });
    printMcpResult(out, result);
  } else {
    const suggestion = `npx paradigma-cli mcp install --agent ${host ?? "claude|codex|cursor"}`;
    step("mcp", "skipped", { command: suggestion });
    out.line(`• Connect your agent later: ${suggestion}`);
  }

  // 7. Site scan ────────────────────────────────────────────────────────────
  // Creating the project started the public four-pillar scan; it does not wait for verification.
  // Waits at most --wait (3 minutes by default here), never forever.
  const scanWait = values.wait === undefined ? SCAN_WAIT_SECONDS : wait;
  let scan: ScanWait | null = null;
  try {
    scan = await waitForScan({
      client,
      io,
      projectId: project.projectId,
      waitSeconds: scanWait,
      onWait: () =>
        out.line(
          `Waiting up to ${scanWait} s for the site scan (SEO, AEO, GEO, Agents)…`,
        ),
    });
  } catch (error) {
    // An older server without the scan route, or a hiccup: setup is still done.
    if (!(error instanceof PlatformError)) throw error;
  }
  const scanSummary = initScanSummary(project.projectId, scan);
  step(
    "scan",
    scanSummary.status === "completed" ? "done" : scanSummary.status,
    { projectId: project.projectId },
  );
  for (const line of renderInitScan(project.projectId, scan)) out.line(line);

  // 7b. Autopilot level ──────────────────────────────────────────────────────
  // Asked together after the scan; with --yes and no flags nothing changes.
  const autopilot = await configureAutopilot({
    out,
    client,
    config,
    repoId: repo.repoId,
    repoName: detected.fullName,
    flags: autopilotFlags,
  });

  // 8. Next steps ────────────────────────────────────────────────────────────
  status = await client.status();
  // Any engine with a route counts; an older server or an error means unknown.
  const aiReady = await client
    .aiEngines(project.projectId)
    .then(
      (ai) =>
        // Included in the plan: Paradigma samples, nothing to connect.
        Boolean(ai.included) ||
        ai.engines.some((engine) => engine.transport !== null),
    )
    .catch(() => false);
  const next = [
    deploy && needsDeployFix(deploy.report)
      ? {
          id: "deploy",
          command: deploy.report.fix ?? "npx paradigma-cli doctor deploy",
          label: "Make merges deploy, or fixes never reach the live site",
        }
      : null,
    status.links.searchConsole
      ? {
          id: "search_console",
          // status.links point at the account's first project; this one is
          // the project init just set up.
          url: `${status.server}/dashboard/sites/${encodeURIComponent(project.projectId)}/connect/google`,
          label:
            "Set up Google: Search Console and Analytics (npx paradigma-cli google)",
        }
      : null,
    aiReady
      ? null
      : {
          id: "ai_visibility",
          command: "npx paradigma-cli connect ai",
          label:
            "Set up AI visibility: your AI keys from the environment, or one OpenRouter consent",
        },
    autopilot.levelSet
      ? null
      : {
          id: "autopilot",
          command: "npx paradigma-cli autopilot level 2",
          label: "Turn on Autopilot (2 = opens PRs for review)",
        },
  ].filter((item) => item !== null);
  out.event("done", {
    ready: status.ready,
    projectId: project.projectId,
    verified,
    dashboardUrl: `${status.server}/dashboard`,
    scan: scanSummary,
    deploy: deploy
      ? {
          ...deploySummary(deploy.report),
          ...(deploy.wouldRun ? { wouldRun: deploy.wouldRun } : {}),
        }
      : null,
    next,
  });
  out.line();
  out.line(
    status.ready
      ? "Paradigma is set up."
      : "Almost there: verify the domain to unlock the dashboard.",
  );
  out.line(`Dashboard: ${status.server}/dashboard`);
  out.line("Optional next steps:");
  for (const item of next)
    out.line(`  - ${item.label}: ${"url" in item ? item.url : item.command}`);
}

type AutopilotFlags = {
  level?: AutopilotLevel;
  confirmFull: boolean;
};

const FULL_AUTOPILOT_CONFIRM =
  "Level 0 (Full autopilot) merges without human review. Add --confirm-full-autopilot to confirm (allowlisted accounts only).";

/** Validates --level and --confirm-full-autopilot up front. */
export function parseAutopilotFlags(values: {
  level?: string;
  "confirm-full-autopilot"?: boolean;
}): AutopilotFlags {
  const flags: AutopilotFlags = {
    confirmFull: Boolean(values["confirm-full-autopilot"]),
  };
  if (values.level !== undefined) {
    const raw = values.level.trim();
    if (!/^[0-3]$/.test(raw))
      throw new UsageError("--level must be 0, 1, 2 or 3");
    flags.level = Number(raw) as AutopilotLevel;
    if (flags.level === 0 && !flags.confirmFull)
      throw new UsageError(FULL_AUTOPILOT_CONFIRM);
  }
  return flags;
}

/**
 * The Autopilot level for this repository, asked after the scan. The flag
 * wins; interactive sessions are asked; non-interactive runs without the flag
 * change nothing. Never fails init.
 */
async function configureAutopilot(input: {
  out: Reporter;
  client: PlatformClient;
  config: Config;
  repoId: string;
  repoName: string;
  flags: AutopilotFlags;
}): Promise<{ levelSet: boolean }> {
  const { out, client, flags } = input;
  const ask = out.io.interactive && !out.json;
  const step = (name: string, status: string, data = {}) =>
    out.event("step", { step: name, status, ...data });
  const failure = (error: unknown) =>
    error instanceof PlatformError
      ? { code: error.code, message: error.message }
      : null;

  const current = await client
    .autopilotPolicyRead(input.repoId)
    .catch(() => null);

  // Level ────────────────────────────────────────────────────────────────────
  let level = flags.level;
  let levelSet = false;
  if (level === undefined && ask) {
    const fallback = current?.policy.level ?? 3;
    const full = current?.fullAutopilotAllowed === true;
    out.line();
    out.line(
      `Autopilot for ${input.repoName}: 3 Notify, 2 Open PR, 1 Autopilot (merges low-risk fixes)${full ? ", 0 Full autopilot (merges without review)" : ""}.`,
    );
    const answer = (
      (await out.prompt('Level, or "skip"', String(fallback))) ?? ""
    ).trim();
    if (/^[0-3]$/.test(answer) && (answer !== "0" || full)) {
      level = Number(answer) as AutopilotLevel;
      if (
        level === 0 &&
        !(await out.confirm(
          "Paradigma's agent will merge changes without human review. Continue?",
          false,
        ))
      )
        level = undefined;
    } else if (answer.toLowerCase() !== "skip")
      out.warn(
        `Not a level: ${answer.slice(0, 20)}. Autopilot left as it was.`,
      );
  }
  if (level !== undefined) {
    try {
      await client.autopilotPolicy(input.repoId, {
        enabled: true,
        level,
        ...(level === 0 ? { confirmFullAutopilot: true } : {}),
      });
      levelSet = true;
      step("autopilot", "done", { level, label: LEVEL_LABELS[level] });
      out.line(`✓ Autopilot on at level ${level} (${LEVEL_LABELS[level]})`);
    } catch (error) {
      const detail = failure(error);
      if (!detail) throw error;
      step("autopilot", "failed", { level, ...detail });
      out.warn(`Autopilot level not set: ${detail.message}`);
    }
  }

  const dashboardUrl = `${input.config.server}/dashboard/autopilot`;
  step("fixes", "info", { by: "paradigma", dashboardUrl });
  out.line(
    `• Fixes are made by the Paradigma agent, hosted or in your GitHub Actions. Choose where in the dashboard: ${dashboardUrl}`,
  );
  return { levelSet };
}

/**
 * Runs the deploy doctor for the app. With --fix-deploy it may run
 * `vercel git connect` (after a confirmation, or non-interactively with
 * --yes); otherwise it reports what it would run. Never fails init.
 */
async function checkDeploy(input: {
  out: Reporter;
  repoRoot: string;
  appRoot: string;
  fix: boolean;
  yes: boolean;
}): Promise<{ report: DeployReport; wouldRun: string | null } | null> {
  const { out, repoRoot, appRoot } = input;
  try {
    let report = await deployDoctor({ repoRoot, appRoot });
    let wouldRun: string | null = null;
    if (canAutoFix(report)) {
      const allowed =
        input.fix &&
        (input.yes ||
          (await out.confirm("Run `vercel git connect` now?", false)));
      if (allowed) {
        const result = await connectVercelGit({ repoRoot, appRoot });
        report = result.report;
        if (!result.ok) {
          report.fixed = false;
          if (result.message)
            report.problem = `vercel git connect: ${result.message}`;
        }
      } else wouldRun = "vercel git connect";
    }
    out.event("step", {
      step: "deploy",
      status: report.fixed
        ? "fixed"
        : needsDeployFix(report)
          ? "action_required"
          : "done",
      ...deploySummary(report),
      evidence: report.evidence,
      ...(wouldRun ? { wouldRun } : {}),
    });
    out.line(deployLine(report));
    if (report.problem) out.warn(report.problem);
    if (wouldRun)
      out.line(
        "  Run it now: npx paradigma-cli doctor deploy --fix (or init --fix-deploy --yes)",
      );
    return { report, wouldRun };
  } catch (error) {
    out.event("step", {
      step: "deploy",
      status: "failed",
      message: (error as Error).message,
    });
    out.warn(`Deploy check failed: ${(error as Error).message}`);
    return null;
  }
}

async function chooseMcpAgent(
  out: Reporter,
  flag: string | undefined,
  yes: boolean,
  host: McpAgent | null,
): Promise<McpAgent | null> {
  if (flag === "none") return null;
  if (flag) return flag as McpAgent;
  if (out.io.interactive && !out.json) {
    const detected = host ?? (await installedMcpAgent(out.io.env));
    if (detected) {
      const label = AGENT_LABELS[detected];
      return (await out.confirm(
        `Connect the Paradigma MCP server to ${label}?`,
        true,
      ))
        ? detected
        : null;
    }
    return null;
  }
  return yes ? host : null;
}

async function ensureProject(input: {
  io: Io;
  out: Reporter;
  client: PlatformClient;
  repo: CliTargetRepository;
  repoRoot: string;
  appRoot: string;
  existing: CliTargetRepository["apps"][number] | undefined;
  values: {
    url?: string;
    brand?: string;
    category?: string;
    "use-case"?: string;
    yes?: boolean;
  };
}): Promise<{ projectId: string; verified: boolean; productionUrl: string }> {
  const { out, client, values, existing } = input;
  const label = `${input.repo.fullName}${input.appRoot ? `/${input.appRoot}` : ""}`;
  if (existing?.projectId) {
    // Reruns must not rewrite the project: only a different production URL
    // updates it here; other fields change with `paradigma projects update`.
    const urlChanged =
      values.url !== undefined &&
      values.url.trim().replace(/\/$/, "") !== existing.productionUrl;
    const changes = urlChanged
      ? {
          productionUrl: values.url?.trim() as string,
          ...(values.brand ? { brandName: values.brand } : {}),
          ...(values.category ? { category: values.category } : {}),
          ...(values["use-case"] ? { useCase: values["use-case"] } : {}),
        }
      : null;
    if (!changes) {
      out.event("step", {
        step: "project",
        status: "done",
        projectId: existing.projectId,
        created: false,
      });
      out.line(
        `✓ Project ${existing.projectId} (${existing.productionUrl ?? label})`,
      );
      return {
        projectId: existing.projectId,
        verified: existing.verified === true,
        productionUrl: existing.productionUrl ?? "",
      };
    }
    const updated = await client.updateProject(existing.projectId, {
      config: changes,
      idempotencyKey: newIdempotencyKey(),
    });
    out.event("step", {
      step: "project",
      status: "done",
      projectId: updated.projectId,
      updated: true,
    });
    out.line(`✓ Project ${updated.projectId} updated`);
    return {
      projectId: updated.projectId,
      verified: updated.verified,
      productionUrl: changes.productionUrl,
    };
  }

  const candidates = inferSiteCandidates(input.repoRoot, input.appRoot);
  const choose = async (
    flag: string | undefined,
    list: Candidate[],
    question: string,
  ) => {
    if (flag) return flag.trim();
    if (out.io.interactive && !out.json) {
      if (list.length > 1)
        out.line(
          `  Found: ${list.map((c) => `${c.value} (${c.source})`).join(", ")}`,
        );
      return out.prompt(question, list[0]?.value);
    }
    return values.yes ? (list[0]?.value ?? null) : null;
  };
  const description = candidates.descriptions.find(
    (c) => c.value.length <= 100,
  );
  const productionUrl = await choose(
    values.url,
    candidates.urls,
    "Production URL (https://…)",
  );
  const brandName = await choose(values.brand, candidates.brands, "Brand name");
  const category = await choose(
    values.category,
    [],
    "Category (e.g. Analytics software)",
  );
  const useCase = await choose(
    values["use-case"],
    description ? [description] : [],
    'Main use case, as "for …" (e.g. planning a launch)',
  );
  const missing: Field[] = [];
  if (!productionUrl)
    missing.push({
      field: "productionUrl",
      flag: "--url",
      candidates: candidates.urls,
    });
  if (!brandName)
    missing.push({
      field: "brandName",
      flag: "--brand",
      candidates: candidates.brands,
    });
  if (!category)
    missing.push({ field: "category", flag: "--category", candidates: [] });
  if (!useCase)
    missing.push({
      field: "useCase",
      flag: "--use-case",
      candidates: candidates.descriptions,
    });
  if (missing.length || !productionUrl || !brandName || !category || !useCase) {
    out.event("needs_input", { fields: missing });
    throw new ActionRequired(
      `Re-run init with ${missing.map((m) => m.flag).join(", ")}${missing.some((m) => m.candidates.length) ? ` (candidates: ${missing.flatMap((m) => m.candidates.slice(0, 3).map((c) => `${m.flag} "${c.value}"`)).join(", ")})` : ""}.`,
      { fields: missing },
    );
  }
  const created = await client.createProject({
    repoId: input.repo.repoId,
    appRoot: input.appRoot,
    config: { productionUrl, brandName, category, useCase },
    idempotencyKey: newIdempotencyKey(),
  });
  out.event("step", {
    step: "project",
    status: "done",
    projectId: created.projectId,
    created: true,
  });
  out.line(`✓ Project ${created.projectId} created for ${productionUrl}`);
  return {
    projectId: created.projectId,
    verified: created.verified,
    productionUrl,
  };
}

/** Network drops, timeouts and server hiccups; worth another poll. */
function isTransient(error: unknown): boolean {
  if (error instanceof ApiError || error instanceof PlatformError)
    return (
      error.code === "network" ||
      error.code === "timeout" ||
      (error.status !== undefined && error.status >= 500)
    );
  return false;
}
