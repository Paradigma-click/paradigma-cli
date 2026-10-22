import { parseArgs } from "node:util";
import { DEFAULT_SERVER } from "./config";
import {
  type ActionCheckResponse,
  type ActionReason,
  type ActionReportRequest,
  type ActionTaskResponse,
  actionCheckResponseSchema,
  actionTaskResponseSchema,
  FIX_ACTION_KEY_SECRETS,
  FIX_ACTION_PATHS,
  FIX_ACTION_TOKEN_PREFIX,
  type GiveUpReason,
  type OwnModelProvider,
} from "./contract/fix-action";
import { type ExecResult, run } from "./exec";
import {
  commitFix,
  type Exec,
  FixGitError,
  openFixPull,
  pushFix,
} from "./fix-github";
import { type FixTotals, runAttempt } from "./fix-loop";
import {
  type ConversationOptions,
  type FixConversation,
  FixModelError,
  type FixModelErrorCategory,
  fixModelKey,
  maskCommand,
  startConversation,
} from "./fix-model";
import { DEFAULT_ACTION_BUDGET, FixProgress } from "./fix-progress";
import { FixReportableError, FixWorkspace } from "./fix-tools";
import { type FetchLike, type Io, UsageError } from "./io";

/**
 * `paradigma fix --task <token>`: the Paradigma agent in the customer's GitHub Actions (docs/36
 * §7). It fetches the task from Paradigma (system prompt, brief, tools and limits are built on
 * the server; no playbook or rule ships in this CLI), runs the tool loop over the checked-out
 * repository, may run their build and tests, asks Paradigma's server to check the edit, commits
 * to `paradigma/fix-<task>`, opens the pull request with the workflow's token and reports the
 * outcome. The report is metadata only: never contents, diffs or provider text.
 *
 * The model is the one the task names (`modelAccess`): the Paradigma model through the model
 * proxy (no secret; repository secrets are ignored), or, with "Use my own key" turned on in
 * Paradigma, the customer's own provider called straight from the runner with their secret,
 * masked in the job's logs before any use.
 */

const BUILD_TIMEOUT_MS = 15 * 60_000;

/** Env names a build or test command never sees: model keys, the workflow token, the task. */
const HIDDEN_FROM_BUILD = new Set([
  ...FIX_ACTION_KEY_SECRETS,
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "PARADIGMA_FIX_TASK",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
]);

export function buildEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !HIDDEN_FROM_BUILD.has(name)) out[name] = value;
  return out;
}

export interface FixDeps {
  io: Io;
  fetch: FetchLike;
  exec: Exec;
  /** Repository root (GITHUB_WORKSPACE, else the working directory). */
  root: string;
  sleep: (ms: number) => Promise<void>;
  /** Base URLs of the customer's model providers (tests). */
  providerUrls?: Pick<ConversationOptions, "anthropicUrl" | "openrouterUrl">;
}

export interface FixOptions {
  token: string;
  server: string;
  build: string | null;
  test: string | null;
}

export type FixRunResult = {
  outcome: ActionReportRequest["outcome"];
  reason: ActionReason | null;
  prUrl: string | null;
  reported: boolean;
};

/** Statuses that mean the tool call itself was wrong, answered back to the model. */
const SOFT_STATUSES = new Set([400, 409, 413, 422, 429]);

/** A tool call Paradigma refused; its message goes back to the model as the tool's result. */
export class FixToolRefused extends Error {
  override readonly name = "FixToolRefused";
}

class FixServer {
  constructor(
    private readonly fetch: FetchLike,
    private readonly server: string,
    private readonly token: string,
  ) {}

  private async call(
    path: string,
    init: RequestInit = {},
    soft = false,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(`${this.server}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    } catch {
      throw new FixReportableError(
        "internal_error",
        "Paradigma could not be reached.",
      );
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 410
    )
      throw new FixReportableError(
        "token_expired",
        "This task is no longer available (the task token expired or the task moved on).",
      );
    if (soft && SOFT_STATUSES.has(response.status)) {
      // The tool call was wrong (a bad URL, a quota): tell the model and keep the run going.
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      throw new FixToolRefused(
        detail?.message ??
          detail?.error ??
          `Paradigma refused this call (HTTP ${response.status}).`,
      );
    }
    if (!response.ok)
      throw new FixReportableError(
        "internal_error",
        `Paradigma answered HTTP ${response.status}.`,
      );
    return response.json();
  }

  async task(): Promise<ActionTaskResponse> {
    const parsed = actionTaskResponseSchema.safeParse(
      await this.call(FIX_ACTION_PATHS.task),
    );
    if (!parsed.success)
      throw new FixReportableError(
        "internal_error",
        "Paradigma sent a task this CLI does not understand. Update paradigma-cli.",
      );
    return parsed.data;
  }

  async check(body: Record<string, unknown>): Promise<ActionCheckResponse> {
    const parsed = actionCheckResponseSchema.safeParse(
      await this.call(
        FIX_ACTION_PATHS.check,
        { method: "POST", body: JSON.stringify(body) },
        true,
      ),
    );
    if (!parsed.success)
      throw new FixReportableError(
        "internal_error",
        "Paradigma's check answered in an unknown format.",
      );
    return parsed.data;
  }

  async report(body: ActionReportRequest): Promise<boolean> {
    try {
      await this.call(FIX_ACTION_PATHS.report, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return true;
    } catch {
      return false;
    }
  }
}

interface CommandCheck {
  name: string;
  status: "passed" | "failed" | "skipped" | "timeout";
  durationMs: number;
}

async function runCommandCheck(
  deps: FixDeps,
  name: string,
  command: string,
): Promise<CommandCheck> {
  const result: ExecResult = await deps.exec("bash", ["-c", command], {
    cwd: deps.root,
    timeoutMs: BUILD_TIMEOUT_MS,
    env: buildEnv(deps.io.env) as NodeJS.ProcessEnv,
    maxOutputBytes: 64 * 1024,
  });
  return {
    name,
    status: result.timedOut
      ? "timeout"
      : result.code === 0
        ? "passed"
        : "failed",
    durationMs: Math.min(3_600_000, Math.max(0, Math.round(result.durationMs))),
  };
}

/** The model a run calls, from the task's `modelAccess` (absent: an older server, own key). */
export type ModelAccess =
  | { provider: "paradigma"; model: string }
  | { provider: OwnModelProvider; key: string; model: string };

/**
 * Which model this run calls. The Paradigma model ignores every model key in the environment;
 * "Use my own key" (or a server older than the model proxy) reads the customer's secret, and
 * returns null when none is set.
 */
export function modelAccessFor(
  task: Pick<ActionTaskResponse, "modelAccess" | "models">,
  env: Record<string, string | undefined>,
): ModelAccess | null {
  const access = task.modelAccess ?? { source: "own", provider: null };
  if (access.source === "paradigma")
    return { provider: "paradigma", model: task.models.openrouter };
  const key = fixModelKey(env, access.provider);
  return key ? { ...key, model: task.models[key.provider] } : null;
}

export function modelReason(category: FixModelErrorCategory): ActionReason {
  switch (category) {
    case "rate_limited":
    case "no_model_key":
    case "model_unavailable":
    case "caps":
    case "token_expired":
      return category;
    default:
      return "provider_error";
  }
}

const MODEL_MESSAGES: Record<FixModelErrorCategory, string> = {
  no_model_key:
    "The model provider refused the key. Check the repository secret.",
  rate_limited: "The model provider is rate limiting. Paradigma retries later.",
  provider_error: "The model provider failed.",
  model_unavailable:
    "The Paradigma model is unavailable right now. Paradigma retries later.",
  caps: "The task's token cap is spent.",
  token_expired:
    "This task is no longer available (the task token expired or the task moved on).",
};

/** Why the run gave up, for the job's log (docs/36 §15, 22/10/2026). */
export const GIVE_UP_LINES: Record<GiveUpReason, string> = {
  no_edit: "no file was changed within the task's budget.",
  check_stalled: "the check kept failing without getting closer.",
  unverifiable: "the check cannot judge this result without building the site.",
  repeated_call: "the agent repeated the same call without writing anything.",
  check_refused: "Paradigma refused the same check twice.",
  budget: "the task's token budget is spent.",
};

/** The agent skipped and left nothing changed (a mutable read the compiler cannot narrow). */
function skippedClean(ws: FixWorkspace): boolean {
  return ws.finished?.outcome === "skipped" && ws.changedFiles().length === 0;
}

function feedbackOf(check: ActionCheckResponse): string[] {
  const lines = [...check.feedback];
  for (const result of check.results)
    if (result.status !== "pass")
      lines.push(`${result.id}: ${result.status}. ${result.summary}`);
  return lines.slice(0, 12);
}

/** The whole run, every I/O injected. Always tries to report, also when something fails. */
export async function runFix(
  deps: FixDeps,
  options: FixOptions,
): Promise<FixRunResult> {
  const say = (text: string) => deps.io.stdout(`${text}\n`);
  const server = new FixServer(deps.fetch, options.server, options.token);
  let task: ActionTaskResponse;
  try {
    task = await server.task();
  } catch (error) {
    deps.io.stderr(`${(error as Error).message}\n`);
    return {
      outcome: "failed",
      reason:
        error instanceof FixReportableError ? error.reason : "internal_error",
      prUrl: null,
      reported: false,
    };
  }
  say(`Paradigma fix: ${task.title} (${task.category})`);

  const totals: FixTotals = { input: 0, output: 0 };
  const progress = new FixProgress(task.budget ?? DEFAULT_ACTION_BUDGET);
  const checks: CommandCheck[] = [];
  let model: string | null = null;
  let workspace: FixWorkspace | null = null;
  const finish = async (
    outcome: ActionReportRequest["outcome"],
    reason: ActionReason | null,
    extra: Partial<ActionReportRequest> = {},
  ): Promise<FixRunResult> => {
    const reported = await server.report({
      outcome,
      reason,
      agentOutcome: workspace?.finished?.outcome ?? null,
      changedPaths:
        extra.changedPaths ??
        workspace
          ?.changedFiles()
          .map((file) => file.path)
          .slice(0, 50) ??
        [],
      lines: extra.lines ?? 0,
      model,
      tokens: { input: totals.input, output: totals.output },
      ...(checks.length ? { checks: checks.slice(0, 10) } : {}),
      ...extra,
    });
    if (!reported)
      deps.io.stderr("Could not report the outcome to Paradigma.\n");
    return { outcome, reason, prUrl: extra.prUrl ?? null, reported };
  };

  try {
    const repo = deps.io.env.GITHUB_REPOSITORY;
    if (repo && repo.toLowerCase() !== task.repo.fullName.toLowerCase()) {
      deps.io.stderr(
        `This task is for ${task.repo.fullName}, but the workflow runs in ${repo}.\n`,
      );
      return await finish("failed", "internal_error");
    }
    const access = modelAccessFor(task, deps.io.env);
    if (!access) {
      deps.io.stderr(
        `Use my own key is on in Paradigma, but no model key reached this step. Add the repository secret ${FIX_ACTION_KEY_SECRETS.join(" or ")} (Settings > Secrets and variables > Actions) and uncomment the env lines in .github/workflows/paradigma-fix.yml, or turn Use my own key off.\n`,
      );
      return await finish("failed", "no_model_key");
    }
    // Mask the customer's key in the job's logs before it is used anywhere.
    if (access.provider !== "paradigma")
      deps.io.stdout(maskCommand(access.key));
    model = access.model;
    workspace = new FixWorkspace(
      deps.root,
      {
        allowedPaths: task.allowedPaths,
        diffBudget: task.diffBudget,
        secretGlobs: task.secretGlobs,
        category: task.category,
      },
      task.caps,
      task.brief,
      (body) => server.check(body),
    );
    const ws = workspace;
    const converse = (prompt: string): FixConversation =>
      startConversation({
        provider: access.provider,
        key: access.provider === "paradigma" ? options.token : access.key,
        model: access.model,
        system: task.system,
        prompt,
        tools: task.tools,
        fetch: deps.fetch,
        sleep: deps.sleep,
        paradigmaUrl: options.server,
        ...deps.providerUrls,
      });

    const build = options.build ?? null;
    const test = options.test ?? null;
    const verify = async (): Promise<
      | { ok: true }
      | {
          ok: false;
          feedback: string[];
          reason: ActionReason;
          /** The check could not judge an item statically: a retry cannot fix that. */
          unknown: boolean;
        }
    > => {
      const limits = ws.checkLimits();
      if (!limits.ok)
        return {
          ok: false,
          feedback: [limits.message],
          reason: "limits",
          unknown: false,
        };
      if (limits.changes.length === 0)
        return {
          ok: false,
          feedback: ["Nothing changed."],
          reason: "pre_pr_failed",
          unknown: false,
        };
      for (const [name, command] of [
        ["build", build],
        ["test", test],
      ] as const) {
        if (!command) continue;
        say(`Running the ${name} command…`);
        const check = await runCommandCheck(deps, name, command);
        checks.push(check);
        if (check.status !== "passed") {
          await ws.restoreWritten();
          return {
            ok: false,
            feedback: [
              `The ${name} command ${check.status === "timeout" ? "timed out" : "failed"}. Make sure the edit keeps the project building and its tests passing.`,
            ],
            reason: "build_failed",
            unknown: false,
          };
        }
      }
      // A build or formatter must never change what gets committed.
      await ws.restoreWritten();
      let check: ActionCheckResponse;
      try {
        check = await server.check({ files: ws.changedFiles(), final: true });
      } catch (error) {
        // A refused final check (a bad request, the check quota) is a failed check, not a crash.
        if (!(error instanceof FixToolRefused)) throw error;
        return {
          ok: false,
          feedback: [error.message.slice(0, 400)],
          reason: "pre_pr_failed",
          unknown: false,
        };
      }
      if (check.passed) return { ok: true };
      return {
        ok: false,
        feedback: feedbackOf(check),
        reason: "pre_pr_failed",
        unknown: check.results.some((result) => result.status === "unknown"),
      };
    };
    const giveUp = (why: GiveUpReason) => {
      say(`Gave up: ${GIVE_UP_LINES[why]}`);
      return finish("skipped", "gave_up", { gaveUp: why });
    };
    const changed = () => ws.changedFiles().length > 0;

    if (task.needsBuild && !build && !test)
      say(
        "This fix usually needs a build: set the action's build-command (and test-command) to run them before the pull request opens.",
      );
    const onTool = (name: string) => say(`  ${name}`);
    say(`Attempt 1 with ${access.model}`);
    let attempt = await runAttempt({
      conversation: converse(task.prompt),
      workspace: ws,
      caps: task.caps,
      totals,
      progress,
      onTool,
    });
    if (skippedClean(ws)) return await finish("skipped", "agent_skipped");
    // Nothing written: a second attempt would only explore again (docs/36 §15, 22/10/2026).
    if (!changed()) {
      if (attempt.stop === "model" && attempt.modelError)
        throw new FixModelError(attempt.modelError);
      if (attempt.stop === "tokens" || attempt.stop === "turns")
        return await finish("failed", "caps");
      return await giveUp(attempt.gaveUp ?? "no_edit");
    }
    let verdict = await verify();
    if (!verdict.ok && ws.finished?.outcome !== "skipped") {
      // Whatever stopped the first attempt also rules out a second one.
      if (attempt.stop === "model" && attempt.modelError)
        throw new FixModelError(attempt.modelError);
      const why =
        attempt.gaveUp ??
        (verdict.unknown ? "unverifiable" : progress.stop(totals));
      // A failed build or a limit says more than the give-up: it stays the reason.
      if (why)
        return verdict.reason === "pre_pr_failed"
          ? await giveUp(why)
          : await finish("failed", verdict.reason);
      say("The check failed; one more attempt.");
      ws.finished = null;
      const retry = task.retryPrompt.replace(
        "{feedback}",
        verdict.feedback.map((line) => `- ${line}`).join("\n"),
      );
      attempt = await runAttempt({
        conversation: converse(`${task.prompt}\n\n${retry}`),
        workspace: ws,
        caps: task.caps,
        totals,
        progress,
        onTool,
      });
      if (skippedClean(ws)) return await finish("skipped", "agent_skipped");
      verdict = await verify();
      if (!verdict.ok && attempt.stop === "model" && attempt.modelError)
        throw new FixModelError(attempt.modelError);
      if (!verdict.ok && attempt.gaveUp && verdict.reason === "pre_pr_failed")
        return await giveUp(attempt.gaveUp);
    }
    if (!verdict.ok) {
      const capped =
        !changed() && (attempt.stop === "tokens" || attempt.stop === "turns");
      say(`Not fixed: ${verdict.feedback[0] ?? "the check failed"}`);
      return await finish("failed", capped ? "caps" : verdict.reason);
    }

    const paths = ws.changedFiles().map((file) => file.path);
    say(`Committing ${paths.length} file(s) to ${task.branch}`);
    const commit = await commitFix({
      exec: deps.exec,
      cwd: deps.root,
      branch: task.branch,
      paths,
      message: task.pr.commitMessage,
      allowedPaths: task.allowedPaths,
      diffBudget: task.diffBudget,
    });
    await pushFix(deps.exec, deps.root, task.branch);
    const ghToken = deps.io.env.GITHUB_TOKEN;
    if (!ghToken || !repo)
      throw new FixGitError(
        "pr_failed",
        "GITHUB_TOKEN and GITHUB_REPOSITORY are needed to open the pull request.",
      );
    const pull = await openFixPull({
      fetch: deps.fetch,
      apiUrl: deps.io.env.GITHUB_API_URL || "https://api.github.com",
      token: ghToken,
      repo,
      branch: task.branch,
      base: task.repo.defaultBranch,
      title: task.pr.title,
      body: task.pr.body,
      draft: task.draft,
    });
    say(`Pull request: ${pull.url}`);
    return await finish("pr_opened", null, {
      prUrl: pull.url,
      sha: commit.sha,
      changedPaths: commit.paths.slice(0, 50),
      lines: commit.lines,
    });
  } catch (error) {
    const reason: ActionReason =
      error instanceof FixModelError
        ? modelReason(error.category)
        : error instanceof FixGitError || error instanceof FixReportableError
          ? error.reason
          : "internal_error";
    const message =
      error instanceof FixModelError
        ? MODEL_MESSAGES[error.category]
        : error instanceof FixGitError || error instanceof FixReportableError
          ? error.message
          : "The fix failed unexpectedly.";
    deps.io.stderr(`${message}\n`);
    return await finish("failed", reason);
  }
}

export const FIX_HELP = `paradigma fix --task <token> [--api-url URL] [--build CMD] [--test CMD]
  Runs one Paradigma fix in GitHub Actions (the Paradigma GitHub Action calls it).
  The token comes from Paradigma's repository_dispatch (or env PARADIGMA_FIX_TASK).
  The model comes from Paradigma; no secret is needed. With Use my own key on in
  Paradigma, it reads ANTHROPIC_API_KEY or OPENROUTER_API_KEY instead.
  Needs GITHUB_TOKEN to open the pull request.`;

/** The CLI entry: parses flags and env, runs, returns the exit code. */
export async function fixCommand(
  io: Io,
  args: string[],
  overrides: Partial<FixDeps> = {},
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      task: { type: "string" },
      "api-url": { type: "string" },
      build: { type: "string" },
      test: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) {
    io.stdout(`${FIX_HELP}\n`);
    return 0;
  }
  const token = (values.task ?? io.env.PARADIGMA_FIX_TASK ?? "").trim();
  if (!token.startsWith(FIX_ACTION_TOKEN_PREFIX))
    throw new UsageError(
      "paradigma fix needs --task <token> (or PARADIGMA_FIX_TASK) from Paradigma's dispatch.",
    );
  const rawServer = (
    values["api-url"] ??
    io.env.PARADIGMA_API_URL ??
    DEFAULT_SERVER
  ).trim();
  let server: string;
  try {
    const url = new URL(rawServer);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      throw new Error("insecure");
    server = url.origin;
  } catch {
    throw new UsageError("--api-url must be an https URL.");
  }
  const blank = (value: string | undefined) => {
    const text = value?.trim();
    return text ? text : null;
  };
  const deps: FixDeps = {
    io,
    fetch: io.fetch ?? ((input, init) => fetch(input, init)),
    exec: run,
    root: io.env.GITHUB_WORKSPACE || io.cwd,
    sleep: io.sleep,
    ...overrides,
  };
  const result = await runFix(deps, {
    token,
    server,
    build: blank(values.build ?? io.env.PARADIGMA_BUILD_COMMAND),
    test: blank(values.test ?? io.env.PARADIGMA_TEST_COMMAND),
  });
  return result.outcome === "failed" ? 1 : 0;
}
