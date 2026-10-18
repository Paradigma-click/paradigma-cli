import {
  type CliAiEngines,
  type CliProject,
  type CredentialRequest,
  OPENROUTER_ENGINES,
} from "./contract/cli-api";
import { ActionRequired, type Io, type Reporter } from "./io";
import { type PlatformClient, PlatformError } from "./platform";

/**
 * `paradigma connect ai`: AI visibility without copying keys.
 * 0. When the plan includes AI visibility (Paradigma's key, docs/03), it
 *    says so and stops: nothing to connect. `--own` goes on to the steps
 *    below, so the customer's own keys or OpenRouter take over.
 * 1. Keys already in this process's environment are uploaded through the
 *    existing credentials API, after confirmation. Only variable names are
 *    ever printed; .env files and shell profiles are never read.
 * 2. Engines still missing get one OpenRouter consent: the server creates the
 *    PKCE handshake, the CLI opens the URL and polls until it is connected.
 *    The OpenRouter key goes to the server only.
 * 3. It prints each project's engines and how they are called.
 */

type KeyProvider = "openai" | "anthropic" | "gemini" | "perplexity";

/** Variable names per provider, in the order they are preferred. */
export const AI_ENV_VARIABLES: {
  provider: KeyProvider;
  engine: (typeof OPENROUTER_ENGINES)[number];
  names: readonly string[];
}[] = [
  { provider: "openai", engine: "openai", names: ["OPENAI_API_KEY"] },
  { provider: "anthropic", engine: "claude", names: ["ANTHROPIC_API_KEY"] },
  {
    provider: "gemini",
    engine: "gemini",
    names: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    provider: "perplexity",
    engine: "perplexity",
    names: ["PERPLEXITY_API_KEY"],
  },
];

export type DetectedAiKey = {
  provider: KeyProvider;
  engine: (typeof OPENROUTER_ENGINES)[number];
  /** The variable's name; its value is read only when uploading. */
  variable: string;
};

/** First non-empty variable per provider, from the process environment only. */
export function detectAiEnvKeys(
  env: Record<string, string | undefined>,
): DetectedAiKey[] {
  return AI_ENV_VARIABLES.flatMap(({ provider, engine, names }) => {
    const variable = names.find((name) => Boolean(env[name]?.trim()));
    return variable ? [{ provider, engine, variable }] : [];
  });
}

const ENGINE_LABELS: Record<string, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  claude: "Claude",
  perplexity: "Perplexity",
  google_ai_overview: "Google AI Overviews",
  google_ai_mode: "Google AI Mode",
};

function engineLine(engines: CliAiEngines["engines"]): string {
  return engines
    .map(({ engine, transport }) => {
      const route =
        transport === "direct"
          ? "own key"
          : transport === "openrouter"
            ? "OpenRouter"
            : "not connected";
      return `${ENGINE_LABELS[engine] ?? engine} (${route})`;
    })
    .join(", ");
}

/** "Pro" or "Agency"; an internal grant reads as Pro. */
export function includedPlanName(plan: string | undefined): string {
  return plan === "agency" ? "Agency" : "Pro";
}

/** Engines OpenRouter could cover that have no route yet. */
export function missingOpenRouterEngines(engines: CliAiEngines["engines"]) {
  return OPENROUTER_ENGINES.filter(
    (engine) =>
      !engines.some((row) => row.engine === engine && row.transport !== null),
  );
}

const POLL_MS = 5_000;
const WAIT_MS = 10 * 60 * 1000;

function transient(error: unknown) {
  return (
    error instanceof PlatformError &&
    (error.code === "network" ||
      error.code === "timeout" ||
      (error.status !== undefined && error.status >= 500))
  );
}

export async function runConnectAi(input: {
  io: Io;
  out: Reporter;
  client: PlatformClient;
  /** The project OpenRouter starts from (its workspace is the default scope). */
  anchor: CliProject | { id: string; name?: string };
  /** Projects the environment keys go to and the summary covers. */
  targets: (CliProject | { id: string; name?: string })[];
  scope: "project" | "workspace" | "all";
  yes: boolean;
  /** Use the customer's own keys or OpenRouter even when included. */
  own?: boolean;
}) {
  const { io, out, client, anchor, targets, scope } = input;
  const label = (project: { id: string; name?: string }) =>
    project.name ? `${project.name} (${project.id})` : project.id;

  // 0. Included in the plan ──────────────────────────────────────────────────
  if (!input.own && targets.length > 0) {
    const states = await Promise.all(
      targets.map(async (project) => ({
        project,
        ai: await client.aiEngines(project.id),
      })),
    );
    if (states.every((state) => state.ai.included)) {
      const first = states[0]?.ai.included;
      const plan = includedPlanName(first?.plan);
      out.event("included", { plan: first?.plan ?? null });
      out.result(
        {
          ok: true,
          included: true,
          projects: states.map(({ project, ai }) => ({
            projectId: project.id,
            name: "name" in project ? (project.name ?? null) : null,
            included: ai.included,
          })),
        },
        () => {
          out.line(`Included in your ${plan} plan. No key or account needed.`);
          for (const { project, ai } of states) {
            const included = ai.included;
            if (!included) continue;
            const engines = included.engines
              .map((engine) => ENGINE_LABELS[engine] ?? engine)
              .join(", ");
            out.line(
              `${label(project)}: ${engines || "your own keys"} · ${included.promptsPerDay} prompts a day${
                included.activePrompts === 0
                  ? ' · add prompts to start (paradigma geo prompts add "…")'
                  : included.paused
                    ? " · paused until next month"
                    : ""
              }`,
            );
          }
          out.line(
            "To use your own OpenRouter or keys instead: paradigma connect ai --own",
          );
        },
      );
      return;
    }
  }

  // 1. Keys already in the environment ───────────────────────────────────────
  const detected = detectAiEnvKeys(io.env);
  const uploaded: { projectId: string; provider: KeyProvider }[] = [];
  const failures: { projectId: string; variable: string; message: string }[] =
    [];
  if (detected.length > 0) {
    const names = detected.map((key) => key.variable);
    out.event("env_keys", { variables: names });
    out.line(`Found in your environment: ${names.join(", ")}`);
    const projects =
      targets.length === 1 ? "this project" : `${targets.length} projects`;
    const confirmed =
      input.yes ||
      (io.interactive && !out.json
        ? await out.confirm(`Connect these keys to ${projects}?`, true)
        : false);
    if (!confirmed) {
      out.line("Skipped the environment keys (pass --yes to connect them).");
    } else {
      for (const project of targets)
        for (const key of detected) {
          const apiKey = io.env[key.variable]?.trim();
          if (!apiKey) continue;
          try {
            await client.connect(project.id, {
              provider: key.provider,
              apiKey,
            } as CredentialRequest);
            uploaded.push({ projectId: project.id, provider: key.provider });
          } catch (error) {
            // Server messages never echo the submitted value.
            failures.push({
              projectId: project.id,
              variable: key.variable,
              message:
                error instanceof PlatformError
                  ? error.message
                  : "The key could not be saved.",
            });
          }
        }
      out.event("env_keys_connected", {
        connected: uploaded.length,
        failed: failures.map(({ projectId, variable }) => ({
          projectId,
          variable,
        })),
      });
      if (uploaded.length > 0)
        out.line(
          `✓ Connected ${[...new Set(uploaded.map((u) => u.provider))].join(", ")} to ${projects}`,
        );
      for (const failure of failures)
        out.warn(
          `${failure.variable} was not saved for ${failure.projectId}: ${failure.message}`,
        );
    }
  }

  // 2. OpenRouter for whatever is still missing ──────────────────────────────
  const states = await Promise.all(
    targets.map(async (project) => ({
      project,
      engines: await client.aiEngines(project.id),
    })),
  );
  const missing = states.filter(
    (state) => missingOpenRouterEngines(state.engines.engines).length > 0,
  );
  let openRouter: "connected" | "not_needed" | "pending" = "not_needed";
  let url: string | null = null;
  if (missing.length > 0) {
    const started = await client.openRouterStart({
      projectId: anchor.id,
      scope,
    });
    url = started.authorizationUrl;
    out.event("openrouter", {
      status: "action_required",
      url,
      requestId: started.requestId,
      expiresAt: started.expiresAt,
    });
    out.line(
      `Connect OpenRouter to cover ${missingOpenRouterEngines(
        missing[0].engines.engines,
      )
        .map((engine) => ENGINE_LABELS[engine])
        .join(", ")} (approve in the browser, signed in to Paradigma):`,
    );
    out.line(`    ${url}`);
    if (io.interactive && !out.json) io.openUrl(url);
    out.line("Waiting up to 10 min for OpenRouter…");
    const deadline = io.now() + WAIT_MS;
    openRouter = "pending";
    let last = "pending";
    while (io.now() < deadline) {
      await io.sleep(POLL_MS);
      try {
        const status = await client.openRouterStatus(started.requestId);
        last = status.status;
      } catch (error) {
        if (!transient(error)) throw error;
        continue;
      }
      if (last === "connected") {
        openRouter = "connected";
        break;
      }
      if (last === "declined" || last === "failed" || last === "expired") break;
    }
    out.event("openrouter", { status: last });
    if (openRouter === "connected") out.line("✓ OpenRouter connected");
    else if (last !== "pending" && last !== "exchanging")
      out.warn(
        last === "declined"
          ? "OpenRouter was not approved."
          : last === "expired"
            ? "The OpenRouter link expired."
            : "OpenRouter could not be connected.",
      );
  }

  // 3. What is connected now ──────────────────────────────────────────────────
  const summary = await Promise.all(
    targets.map(async (project) => {
      const known = states.find((state) => state.project.id === project.id);
      const engines =
        openRouter === "not_needed" && known
          ? known.engines
          : await client.aiEngines(project.id);
      return {
        id: project.id,
        name: "name" in project ? project.name : undefined,
        openRouter: engines.openRouter,
        engines: engines.engines,
      };
    }),
  );
  const result = {
    ok: openRouter !== "pending" && failures.length === 0,
    environment: detected.map((key) => key.variable),
    uploaded: uploaded.length,
    openRouter,
    projects: summary.map(({ id, name, openRouter, engines }) => ({
      projectId: id,
      name: name ?? null,
      openRouter: Boolean(openRouter),
      engines,
    })),
  };
  out.result(result, () => {
    out.line();
    for (const project of summary)
      out.line(`${label(project)}: ${engineLine(project.engines)}`);
  });
  if (missing.length > 0 && openRouter !== "connected")
    throw new ActionRequired(
      "OpenRouter is not connected yet. Open the link, approve, then run `paradigma connect ai` again.",
      { url },
    );
}
