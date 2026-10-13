import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { type Config, loadConfig, requireToken } from "./config";
import {
  type CliProject,
  type CliVerificationMethod,
  CREDENTIAL_PROVIDERS,
  type CredentialProvider,
  type CredentialRequest,
  GEO_DAILY_LIMITS,
  GEO_ENGINES,
  SYNC_SOURCES,
  type SyncSource,
  VERIFICATION_METHODS,
} from "./contract/cli-api";
import { chooseAppRoot, detectRepo } from "./detect";
import { ActionRequired, type Io, Reporter, UsageError } from "./io";
import {
  hostAgent,
  installMcp,
  MCP_AGENTS,
  type McpAgent,
  type McpInstallResult,
} from "./mcp-install";
import {
  type Loose,
  PlatformClient,
  PlatformError,
  type VerifyResult,
} from "./platform";
import { VERSION } from "./version";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newIdempotencyKey() {
  return `cli_${randomBytes(18).toString("base64url")}`;
}

export function clientFor(config: Config, io: Io) {
  return new PlatformClient({
    server: config.server,
    token: config.token,
    fetch: io.fetch,
    userAgent: `paradigma-cli/${VERSION}`,
  });
}

type Ctx = { io: Io; out: Reporter; config: Config; client: PlatformClient };

function context(io: Io, json: boolean): Ctx {
  const config = requireToken(loadConfig());
  return {
    io,
    out: new Reporter(io, json),
    config,
    client: clientFor(config, io),
  };
}

function absolute(ctx: Ctx, path: unknown): string | null {
  if (typeof path !== "string" || !path) return null;
  return /^https?:\/\//.test(path) ? path : `${ctx.client.server}${path}`;
}

// ─── Resolution of the project, organization and repository ────────────────

/** --project, else the project for this checkout, else init's default, else the only one. */
export async function resolveProject(
  ctx: Ctx,
  flag: string | undefined,
): Promise<CliProject | { id: string; orgId: null; repoId: null }> {
  const { projects } = await ctx.client.projects();
  if (flag) {
    if (!UUID.test(flag))
      throw new UsageError("--project must be a project id (UUID).");
    return (
      projects.find((p) => p.id === flag) ?? {
        id: flag,
        orgId: null,
        repoId: null,
      }
    );
  }
  const repo = await detectRepo(ctx.io.cwd);
  if (repo) {
    const inRepo = projects.filter(
      (p) => p.repoFullName?.toLowerCase() === repo.fullName.toLowerCase(),
    );
    const root = chooseAppRoot(
      inRepo.map((p) => p.appRoot),
      repo.relativeDir,
    );
    const match = inRepo.find((p) => p.appRoot === root);
    if (match) return match;
  }
  const preferred = projects.find((p) => p.id === ctx.config.defaultProjectId);
  if (preferred) return preferred;
  if (projects.length === 1) return projects[0];
  if (!projects.length)
    throw new ActionRequired(
      "No projects yet. Run `npx paradigma-cli init` in your repository.",
    );
  throw new UsageError(
    `Several projects match; pass --project <id>:\n${projects.map((p) => `  ${p.id}  ${p.name}  ${p.productionUrl}`).join("\n")}`,
  );
}

async function resolveOrg(ctx: Ctx, flags: { org?: string; project?: string }) {
  if (flags.org) {
    if (!UUID.test(flags.org))
      throw new UsageError("--org must be an organization id (UUID).");
    return flags.org;
  }
  const project = await resolveProject(ctx, flags.project);
  if (!project.orgId)
    throw new UsageError("Pass --org <id> (see `paradigma links`).");
  return project.orgId;
}

async function resolveRepo(
  ctx: Ctx,
  flags: { repo?: string; project?: string },
) {
  if (flags.repo && UUID.test(flags.repo)) return flags.repo;
  const { repositories } = await ctx.client.targets();
  const byName = (name: string) =>
    repositories.find((r) => r.fullName.toLowerCase() === name.toLowerCase());
  if (flags.repo) {
    const found = byName(flags.repo);
    if (!found)
      throw new UsageError(
        `${flags.repo} is not an installed repository you can write to.`,
      );
    return found.repoId;
  }
  const detected = await detectRepo(ctx.io.cwd);
  const local = detected ? byName(detected.fullName) : undefined;
  if (local) return local.repoId;
  const project = await resolveProject(ctx, flags.project);
  if (!project.repoId) throw new UsageError("Pass --repo owner/name.");
  return project.repoId;
}

// ─── Rendering helpers ──────────────────────────────────────────────────────

function printOperation(ctx: Ctx, label: string, result: Loose) {
  const operation = result.operation as
    | { id?: string; status?: string; dashboardPath?: string }
    | null
    | undefined;
  ctx.out.result(result, () => {
    if (!operation) {
      ctx.out.line(`${label}: requested.`);
      return;
    }
    ctx.out.line(
      `${label}: ${operation.status ?? "requested"}${operation.id ? ` (operation ${operation.id})` : ""}`,
    );
    const link = absolute(ctx, operation.dashboardPath);
    if (link) ctx.out.line(`  ${link}`);
  });
  if (operation?.status === "failed") process.exitCode = 1;
}

export function printInstructions(
  out: Reporter,
  instructions: NonNullable<VerifyResult["instructions"]>,
  projectId: string,
) {
  out.line("Prove you own the domain with one of:");
  out.line(
    `  DNS TXT   ${instructions.dns.name}  →  ${instructions.dns.value}`,
  );
  out.line(
    `  File      ${instructions.file.repoPath} containing ${instructions.file.contents}`,
  );
  out.line(`            (served at ${instructions.file.url})`);
  out.line(`  Meta tag  ${instructions.meta.tag}`);
  out.line(`Then run: npx paradigma-cli verify --project ${projectId}`);
}

// ─── Commands ──────────────────────────────────────────────────────────────

async function linksCommand(io: Io, args: string[]) {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    strict: true,
  });
  const ctx = context(io, Boolean(values.json));
  const links = await ctx.client.links();
  ctx.out.result(links, () => {
    const show = (label: string, value: unknown) => {
      if (typeof value === "string")
        ctx.out.line(`${label.padEnd(24)}${value}`);
    };
    show("Install the GitHub App", links.githubAppInstallUrl);
    show("Dashboard", links.dashboardUrl);
    show("MCP server", links.mcpUrl);
    for (const project of (links.projects as Loose[] | undefined) ?? []) {
      ctx.out.line(`Project ${project.projectId}:`);
      show("  Search Console", project.connectSearchConsoleUrl);
      show("  Google Analytics", project.connectGa4Url);
      show("  Settings", project.settingsUrl);
    }
    for (const org of (links.orgs as Loose[] | undefined) ?? []) {
      ctx.out.line(`Organization ${org.orgId}:`);
      show("  Slack", org.connectSlackUrl);
      show("  Billing", org.billingUrl);
    }
  });
}

/** `paradigma status` account section; null when not signed in. */
export async function accountStatus(io: Io, json: boolean) {
  const config = loadConfig();
  if (!config.token) return null;
  const client = clientFor(config, io);
  const status = await client.status();
  const out = new Reporter(io, json);
  if (!json) {
    out.line(
      `Account:    ${status.ready ? "ready" : "setup in progress"} (${status.server})`,
    );
    for (const step of status.steps)
      out.line(
        `  ${step.done ? "✓" : "·"} ${step.label}${step.kind === "optional" ? " (optional)" : ""}`,
      );
    if (status.project)
      out.line(
        `  Project: ${status.project.name} ${status.project.productionUrl} (${status.project.siteId})`,
      );
    if (!status.ready) out.line("  Continue with: npx paradigma-cli init");
  }
  return status;
}

const projectFlags = {
  json: { type: "boolean" },
  project: { type: "string" },
  repo: { type: "string" },
  "app-root": { type: "string" },
  url: { type: "string" },
  brand: { type: "string" },
  category: { type: "string" },
  "use-case": { type: "string" },
  sitemap: { type: "string" },
  alias: { type: "string", multiple: true },
  competitor: { type: "string", multiple: true },
} as const;

async function projectsCommand(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: projectFlags,
    allowPositionals: true,
    strict: true,
  });
  const action = positionals[0] ?? "list";
  const ctx = context(io, Boolean(values.json));
  if (action === "list") {
    const result = await ctx.client.projects();
    ctx.out.result(result, () => {
      if (!result.projects.length)
        ctx.out.line("No projects yet. Run `npx paradigma-cli init`.");
      for (const p of result.projects)
        ctx.out.line(
          `${p.id}  ${p.name}  ${p.productionUrl}  ${p.verified === true ? "verified" : p.verified === false ? "unverified" : "-"}  ${p.repoFullName ?? p.repoId}${p.appRoot ? `/${p.appRoot}` : ""}`,
        );
    });
    return;
  }
  const config = {
    ...(values.url ? { productionUrl: values.url } : {}),
    ...(values.brand ? { brandName: values.brand } : {}),
    ...(values.category ? { category: values.category } : {}),
    ...(values["use-case"] ? { useCase: values["use-case"] } : {}),
    ...(values.sitemap ? { sitemapUrl: values.sitemap } : {}),
    ...(values.alias ? { brandAliases: values.alias } : {}),
    ...(values.competitor ? { competitors: values.competitor } : {}),
  };
  if (action === "create") {
    const missing = (
      [
        ["url", config.productionUrl],
        ["brand", config.brandName],
        ["category", config.category],
        ["use-case", config.useCase],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([flag]) => `--${flag}`);
    if (missing.length)
      throw new UsageError(`projects create needs ${missing.join(", ")}`);
    const repoId = await resolveRepo(ctx, values);
    const { repositories } = await ctx.client.targets();
    const repo = repositories.find((r) => r.repoId === repoId);
    const detected = await detectRepo(io.cwd);
    const appRoot =
      values["app-root"] ??
      chooseAppRoot(
        repo?.apps.map((a) => a.appRoot) ?? [],
        detected?.relativeDir ?? "",
      );
    if (appRoot === null || appRoot === undefined)
      throw new UsageError(
        `Pass --app-root (one of: ${repo?.apps.map((a) => JSON.stringify(a.appRoot)).join(", ") || "none detected"}).`,
      );
    const result = await ctx.client.createProject({
      repoId,
      appRoot,
      config: config as Required<
        Pick<
          typeof config,
          "productionUrl" | "brandName" | "category" | "useCase"
        >
      > &
        typeof config,
      idempotencyKey: newIdempotencyKey(),
    });
    ctx.out.result(result, () => {
      ctx.out.line(
        `${result.created ? "Created" : "Updated"} project ${result.projectId}.`,
      );
      if (result.verification)
        printInstructions(ctx.out, result.verification, result.projectId);
      else if (result.verified) ctx.out.line("Domain verified.");
    });
    return;
  }
  if (action === "update") {
    if (!Object.keys(config).length)
      throw new UsageError(
        "projects update needs at least one of --url, --brand, --category, --use-case, --sitemap, --alias, --competitor",
      );
    const project = await resolveProject(ctx, values.project);
    const result = await ctx.client.updateProject(project.id, {
      config,
      idempotencyKey: newIdempotencyKey(),
    });
    ctx.out.result(result, () => {
      ctx.out.line(`Updated project ${result.projectId}.`);
      if (result.productionUrlChanged)
        ctx.out.line(
          "The production URL changed, so the domain must be verified again.",
        );
      if (result.verification)
        printInstructions(ctx.out, result.verification, result.projectId);
    });
    return;
  }
  throw new UsageError("Usage: paradigma projects list|create|update");
}

async function verifyCommand(io: Io, args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      project: { type: "string" },
      method: { type: "string", multiple: true },
    },
    strict: true,
  });
  const methods = values.method as CliVerificationMethod[] | undefined;
  for (const method of methods ?? [])
    if (!(VERIFICATION_METHODS as readonly string[]).includes(method))
      throw new UsageError("--method must be dns, file or meta");
  const ctx = context(io, Boolean(values.json));
  const project = await resolveProject(ctx, values.project);
  const result = await ctx.client.verify(project.id, {
    methods,
    idempotencyKey: newIdempotencyKey(),
  });
  ctx.out.result(result, () => {
    if (result.verified) {
      ctx.out.line(
        `Domain verified (${result.method}). The first audit has been requested.`,
      );
      return;
    }
    for (const attempt of result.attempts)
      ctx.out.line(`  ✗ ${attempt.method}: ${attempt.reason ?? "not found"}`);
    if (result.instructions)
      printInstructions(ctx.out, result.instructions, project.id);
  });
  if (!result.verified) process.exitCode = 3;
}

async function auditCommand(io: Io, args: string[]) {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" }, project: { type: "string" } },
    strict: true,
  });
  const ctx = context(io, Boolean(values.json));
  const project = await resolveProject(ctx, values.project);
  printOperation(
    ctx,
    "Audit",
    await ctx.client.audit(project.id, newIdempotencyKey()),
  );
}

async function syncCommand(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean" }, project: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const source = positionals[0] as SyncSource | undefined;
  if (!source || !(SYNC_SOURCES as readonly string[]).includes(source))
    throw new UsageError(`Usage: paradigma sync ${SYNC_SOURCES.join("|")}`);
  const ctx = context(io, Boolean(values.json));
  const project = await resolveProject(ctx, values.project);
  printOperation(
    ctx,
    `Sync ${source}`,
    await ctx.client.sync(project.id, source, newIdempotencyKey()),
  );
}

const SECRET_FLAG = /^--(?:api-?key|key|secret|password|token|pass)(?:=|$)/i;

/** Secret from an env var (--key-env NAME), piped stdin or a hidden prompt; never argv. */
async function readSecret(io: Io, label: string, envName: string | undefined) {
  if (envName) {
    const value = io.env[envName]?.trim();
    if (!value) throw new UsageError(`${envName} is empty or not set.`);
    return value;
  }
  if (!io.stdinIsTTY) {
    const value = (await io.readStdin()).trim();
    if (!value)
      throw new UsageError(
        `Pipe the ${label} on stdin or pass --key-env NAME.`,
      );
    return value;
  }
  if (io.interactive) {
    const value = (await io.askHidden(`${label}: `)).trim();
    if (value) return value;
  }
  throw new UsageError(`Pipe the ${label} on stdin or pass --key-env NAME.`);
}

async function connectCommand(io: Io, args: string[]) {
  if (args.some((arg) => SECRET_FLAG.test(arg)))
    throw new UsageError(
      "Secrets are never accepted as arguments. Pipe the key on stdin (paradigma connect <provider> < key.txt) or pass --key-env NAME.",
    );
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      project: { type: "string" },
      "key-env": { type: "string" },
      "site-domain": { type: "string" },
      region: { type: "string" },
      "posthog-project": { type: "string" },
      login: { type: "string" },
      location: { type: "string" },
      language: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const provider = positionals[0] as CredentialProvider | undefined;
  if (
    !provider ||
    !(CREDENTIAL_PROVIDERS as readonly string[]).includes(provider)
  )
    throw new UsageError(
      `Usage: paradigma connect ${CREDENTIAL_PROVIDERS.join("|")}`,
    );
  let request: CredentialRequest;
  const envName = values["key-env"];
  if (provider === "dataforseo") {
    const location = Number(values.location ?? "2840");
    if (!values.login)
      throw new UsageError(
        "dataforseo needs --login (the API login, not secret).",
      );
    if (!Number.isInteger(location) || location < 1)
      throw new UsageError(
        "--location must be a DataForSEO location code, e.g. 2840 (United States).",
      );
    request = {
      provider,
      login: values.login,
      password: await readSecret(io, "DataForSEO API password", envName),
      locationCode: location,
      languageCode: values.language ?? "en",
    };
  } else if (provider === "posthog") {
    if (values.region !== "us" && values.region !== "eu")
      throw new UsageError("posthog needs --region us|eu");
    if (!values["posthog-project"])
      throw new UsageError("posthog needs --posthog-project <id>");
    request = {
      provider,
      region: values.region,
      posthogProjectId: values["posthog-project"],
      apiKey: await readSecret(io, "PostHog personal API key", envName),
    };
  } else if (provider === "plausible") {
    request = {
      provider,
      apiKey: await readSecret(io, "Plausible API key", envName),
      ...(values["site-domain"] ? { siteDomain: values["site-domain"] } : {}),
    };
  } else {
    request = {
      provider,
      apiKey: await readSecret(io, `${provider} API key`, envName),
    } as CredentialRequest;
  }
  if (
    provider === "bing" ||
    provider === "crux" ||
    provider === "plausible" ||
    provider === "posthog"
  )
    (request as { idempotencyKey?: string }).idempotencyKey =
      newIdempotencyKey();
  const ctx = context(io, Boolean(values.json));
  const project = await resolveProject(ctx, values.project);
  const result = await ctx.client.connect(project.id, request);
  ctx.out.result(result, () => {
    ctx.out.line(
      `Connected ${provider} for project ${project.id}. The key is stored encrypted and is never shown again.`,
    );
    const sync = result.sync as
      | { id?: string; status?: string }
      | null
      | undefined;
    if (sync?.id)
      ctx.out.line(
        `First sync: ${sync.status ?? "requested"} (operation ${sync.id})`,
      );
  });
}

async function geoCommand(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      project: { type: "string" },
      engine: { type: "string" },
      daily: { type: "string" },
      off: { type: "boolean" },
      prompt: { type: "string" },
      state: { type: "string" },
      "accept-charges": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const [area, action, ...rest] = positionals;
  const engine = values.engine;
  const requireEngine = () => {
    if (!engine || !(GEO_ENGINES as readonly string[]).includes(engine))
      throw new UsageError(`--engine must be one of ${GEO_ENGINES.join(", ")}`);
    return engine;
  };
  if (area === "prompts") {
    const ctx = context(io, Boolean(values.json));
    const project = await resolveProject(ctx, values.project);
    if (!action || action === "list") {
      const state = (values.state ?? "all") as "all" | "active" | "inactive";
      if (!["all", "active", "inactive"].includes(state))
        throw new UsageError("--state must be all, active or inactive");
      const result = await ctx.client.prompts(project.id, state);
      ctx.out.result(result, () => {
        if (!result.prompts.length)
          ctx.out.line(
            'No prompts yet. Add one: paradigma geo prompts add "best X for Y"',
          );
        for (const prompt of result.prompts)
          ctx.out.line(
            `${prompt.id}  ${prompt.active === false ? "inactive" : "active  "}  ${prompt.text}`,
          );
      });
      return;
    }
    if (action === "add") {
      const text = rest.join(" ").trim();
      if (text.length < 5)
        throw new UsageError(
          'Usage: paradigma geo prompts add "question your customers ask"',
        );
      printOperation(
        ctx,
        "Prompt",
        await ctx.client.addPrompt(project.id, text, newIdempotencyKey()),
      );
      return;
    }
    throw new UsageError("Usage: paradigma geo prompts [list|add TEXT]");
  }
  if (area === "schedule") {
    const chosen = requireEngine();
    const daily = Number(values.daily ?? "1");
    if (!(GEO_DAILY_LIMITS as readonly number[]).includes(daily))
      throw new UsageError(
        `--daily must be one of ${GEO_DAILY_LIMITS.join(", ")}`,
      );
    if (!values.off && !values["accept-charges"])
      throw new UsageError(
        "Automatic sampling uses your provider key and can incur recurring charges (up to --daily calls per day). Re-run with --accept-charges to confirm, or --off to disable.",
      );
    const ctx = context(io, Boolean(values.json));
    const project = await resolveProject(ctx, values.project);
    printOperation(
      ctx,
      values.off
        ? `GEO schedule off (${chosen})`
        : `GEO schedule ${chosen} ×${daily}/day`,
      await ctx.client.geoSchedule(project.id, {
        engine: chosen,
        dailyLimit: daily,
        enabled: !values.off,
        acceptCharges: Boolean(values["accept-charges"]),
        idempotencyKey: newIdempotencyKey(),
      }),
    );
    return;
  }
  if (area === "sample") {
    const chosen = requireEngine();
    if (!values.prompt || !UUID.test(values.prompt))
      throw new UsageError(
        "--prompt <id> is required (see `paradigma geo prompts list`).",
      );
    if (!values["accept-charges"])
      throw new UsageError(
        "A sample calls the provider on your key and may be charged even if it fails. Re-run with --accept-charges to confirm.",
      );
    const ctx = context(io, Boolean(values.json));
    const project = await resolveProject(ctx, values.project);
    printOperation(
      ctx,
      `GEO sample (${chosen})`,
      await ctx.client.geoSample(project.id, {
        promptId: values.prompt,
        engine: chosen,
        acceptCharges: true,
        idempotencyKey: newIdempotencyKey(),
      }),
    );
    return;
  }
  throw new UsageError("Usage: paradigma geo prompts|schedule|sample …");
}

async function alertsCommand(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      org: { type: "string" },
      project: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const [action, raw] = positionals;
  const weekly = Number(raw);
  if (
    action !== "budget" ||
    !Number.isInteger(weekly) ||
    weekly < 0 ||
    weekly > 3
  )
    throw new UsageError("Usage: paradigma alerts budget 0|1|2|3 [--org ID]");
  const ctx = context(io, Boolean(values.json));
  const orgId = await resolveOrg(ctx, values);
  const result = await ctx.client.alertBudget(orgId, weekly);
  ctx.out.result(result, () =>
    ctx.out.line(`Weekly alert budget set to ${weekly}.`),
  );
}

async function billingCommand(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      org: { type: "string" },
      project: { type: "string" },
      plan: { type: "string" },
      open: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const action = positionals[0];
  if (action !== "checkout" && action !== "portal")
    throw new UsageError(
      "Usage: paradigma billing checkout --plan pro|agency | billing portal [--org ID] [--open]",
    );
  if (
    action === "checkout" &&
    values.plan !== "pro" &&
    values.plan !== "agency"
  )
    throw new UsageError("--plan must be pro or agency");
  const ctx = context(io, Boolean(values.json));
  const orgId = await resolveOrg(ctx, values);
  const result =
    action === "checkout"
      ? await ctx.client.checkout(orgId, values.plan as "pro" | "agency")
      : await ctx.client.portal(orgId);
  ctx.out.result(result, () => {
    const label =
      result.state === "checkout"
        ? "Open to pay"
        : result.state === "portal"
          ? "Open the billing portal"
          : `Billing state: ${result.state}`;
    ctx.out.line(`${label}: ${result.url}`);
  });
  if (values.open) io.openUrl(result.url);
}

async function autopilotCommand(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      repo: { type: "string" },
      project: { type: "string" },
      reason: { type: "string" },
      "confirm-full-autopilot": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const [action, raw] = positionals;
  if (action !== "level" && action !== "pause" && action !== "resume")
    throw new UsageError(
      "Usage: paradigma autopilot level 0|1|2|3 | pause | resume [--repo owner/name]",
    );
  let level: number | undefined;
  if (action === "level") {
    level = Number(raw);
    if (![0, 1, 2, 3].includes(level))
      throw new UsageError("Level must be 0, 1, 2 or 3.");
    if (level === 0 && !values["confirm-full-autopilot"])
      throw new UsageError(
        "Level 0 (Full autopilot) merges without human review. Re-run with --confirm-full-autopilot to confirm (allowlisted accounts only).",
      );
  }
  const ctx = context(io, Boolean(values.json));
  const repoId = await resolveRepo(ctx, values);
  if (action === "level") {
    const result = await ctx.client.autopilotPolicy(repoId, {
      enabled: true,
      level,
      ...(level === 0 ? { confirmFullAutopilot: true } : {}),
    });
    const names = ["Full autopilot", "Autopilot", "Open PR", "Notify"];
    ctx.out.result(result, () =>
      ctx.out.line(
        `Autopilot on at level ${level} (${names[level as number]}) for repository ${repoId}.`,
      ),
    );
    return;
  }
  const result =
    action === "pause"
      ? await ctx.client.autopilotPause(repoId, values.reason)
      : await ctx.client.autopilotResume(repoId);
  ctx.out.result(result, () =>
    ctx.out.line(
      action === "pause"
        ? "Autopilot paused on the server for this repository (all runners)."
        : "Autopilot resumed on the server for this repository.",
    ),
  );
}

export function printMcpResult(out: Reporter, result: McpInstallResult) {
  if (result.status === "failed") {
    out.warn(`MCP for ${result.agent} not installed: ${result.error}`);
    return;
  }
  out.line(
    result.status === "already_configured"
      ? `MCP already configured for ${result.agent} (${result.action}).`
      : `MCP ${result.status} for ${result.agent}: ${result.action}`,
  );
  if (result.next) out.line(`  Next: ${result.next}`);
}

async function mcpCommand(io: Io, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      agent: { type: "string" },
      server: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals[0] !== "install")
    throw new UsageError(
      "Usage: paradigma mcp install --agent claude|codex|cursor",
    );
  const agent = (values.agent ?? hostAgent(io.env)) as McpAgent | null;
  if (!agent || !(MCP_AGENTS as readonly string[]).includes(agent))
    throw new UsageError("--agent must be claude, codex or cursor");
  const config = loadConfig();
  const server = new PlatformClient({ server: values.server ?? config.server })
    .server;
  const out = new Reporter(io, Boolean(values.json));
  const result = await installMcp(agent, server, {
    env: io.env as NodeJS.ProcessEnv,
  });
  out.result(result, () => printMcpResult(out, result));
  if (result.status === "failed") process.exitCode = 1;
}

const COMMANDS: Record<string, (io: Io, args: string[]) => Promise<void>> = {
  links: linksCommand,
  projects: projectsCommand,
  verify: verifyCommand,
  audit: auditCommand,
  sync: syncCommand,
  connect: connectCommand,
  geo: geoCommand,
  alerts: alertsCommand,
  billing: billingCommand,
  autopilot: autopilotCommand,
  mcp: mcpCommand,
};

export function isPlatformCommand(command: string | undefined) {
  return command !== undefined && Object.hasOwn(COMMANDS, command);
}

/**
 * With --json, failures are also written to stdout as
 * `{"ok":false,"error":code,"message":…}` so agents can parse them; the
 * error is rethrown for the exit code and the stderr message.
 */
export async function withJsonErrors(
  args: string[],
  io: Io,
  run: (io: Io) => Promise<void>,
) {
  try {
    await run(io);
  } catch (error) {
    if (args.includes("--json")) {
      const code =
        error instanceof PlatformError
          ? error.code
          : error instanceof ActionRequired
            ? "action_required"
            : error instanceof UsageError ||
                (error as { code?: string })?.code?.startsWith?.(
                  "ERR_PARSE_ARGS",
                )
              ? "usage"
              : "error";
      io.stdout(
        `${JSON.stringify({
          ok: false,
          error: code,
          message: (error as Error).message,
          ...(error instanceof ActionRequired ? error.detail : {}),
        })}\n`,
      );
    }
    throw error;
  }
}

export function platformCommand(command: string, args: string[], io: Io) {
  return withJsonErrors(args, io, (io) => COMMANDS[command](io, args));
}
