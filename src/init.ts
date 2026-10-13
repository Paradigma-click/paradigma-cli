import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { detectAgents } from "./agents";
import { ApiError, normalizeServer } from "./api";
import { clientFor, newIdempotencyKey, printMcpResult } from "./commands";
import { configPath, loadConfig, updateConfig } from "./config";
import type {
  CliStatusResponse,
  CliTargetRepository,
  CliVerificationInstructions,
} from "./contract/cli-api";
import { isSetupTokenShape } from "./contract/setup";
import {
  type Candidate,
  chooseAppRoot,
  detectRepo,
  inferSiteCandidates,
} from "./detect";
import { publishVerificationFile, verificationRepoPath } from "./domain-file";
import { ActionRequired, type Io, Reporter, UsageError } from "./io";
import {
  hostAgent,
  installMcp,
  MCP_AGENTS,
  type McpAgent,
} from "./mcp-install";
import { pairDevice } from "./pairing";
import { PlatformClient, PlatformError } from "./platform";
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
 * publish the verification file), connect the MCP server and print the
 * optional next steps. Every step reads server state first, so running it
 * again resumes where it stopped. `--json` emits one JSON event per line.
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
      const agents = (await detectAgents(io.env)).filter(
        (a) => a.name !== "custom",
      );
      const exchanged = await anonymous.exchangeSetupToken({
        token: values.token,
        runnerName: (
          values.name ??
          `${host ? AGENT_LABELS[host] : "paradigma CLI"} on ${hostname()}`
        ).slice(0, 100),
        platform: platform().slice(0, 40),
        agents: agents
          .slice(0, 5)
          .map((a) => ({ name: a.name, version: a.version })),
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
        `✓ Signed in (runner ${exchanged.runnerId}). Config: ${configPath()}`,
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
    const url = status.links.installApp ?? targets.installGithubAppUrl;
    step("github_app", "action_required", { url, waitSeconds: wait });
    out.line(
      `Install the Paradigma GitHub App on ${detected.fullName} (write access needed):`,
    );
    out.line(`    ${url ?? "see the dashboard onboarding page"}`);
    if (url && io.interactive && !out.json) io.openUrl(url);
    const deadline = io.now() + wait * 1000;
    if (wait > 0)
      out.line(
        `Waiting up to ${Math.round(wait / 60)} min for the installation and app detection…`,
      );
    while (!repo && io.now() < deadline) {
      await io.sleep(POLL_MS);
      ({ targets, repo } = await findRepo());
    }
    if (!repo)
      throw new ActionRequired(
        `The GitHub App is not installed on ${detected.fullName} yet (or no Next.js app was detected). Install it, then run \`npx paradigma-cli init\` again.`,
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

  // 7. Next steps ────────────────────────────────────────────────────────────
  status = await client.status();
  const next = [
    status.links.searchConsole
      ? {
          id: "search_console",
          url: status.links.searchConsole,
          label: "Connect Search Console (opens Google sign-in)",
        }
      : null,
    {
      id: "geo_key",
      command:
        "npx paradigma-cli connect gemini|openai|anthropic|perplexity < key.txt",
      label: "Add an AI search key (only if you provide one)",
    },
    {
      id: "autopilot",
      command: "npx paradigma-cli autopilot level 2",
      label: "Turn on Autopilot (2 = opens PRs for review)",
    },
    {
      id: "schedule",
      command: "npm i -g paradigma-cli && paradigma schedule install --hour 9",
      label: "Run Autopilot daily on this machine",
    },
  ].filter((item) => item !== null);
  out.event("done", {
    ready: status.ready,
    projectId: project.projectId,
    verified,
    dashboardUrl: `${status.server}/dashboard`,
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

async function chooseMcpAgent(
  out: Reporter,
  flag: string | undefined,
  yes: boolean,
  host: McpAgent | null,
): Promise<McpAgent | null> {
  if (flag === "none") return null;
  if (flag) return flag as McpAgent;
  if (out.io.interactive && !out.json) {
    const detected =
      host ??
      (await detectAgents(out.io.env)).find((a) => a.name !== "custom")?.name ??
      null;
    if (detected && detected !== "custom") {
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
    "Main use case (e.g. Track product usage)",
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
