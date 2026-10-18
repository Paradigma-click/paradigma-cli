import {
  ACTION_MODEL_MAX_TOOL_RESULT,
  type ActionModelMessage,
  type ActionTool,
  actionModelResponseSchema,
  FIX_ACTION_PATHS,
  type OwnModelProvider,
} from "./contract/fix-action";
import type { FetchLike } from "./io";

/**
 * The model behind `paradigma fix` (docs/36 §7), over plain fetch:
 * - by default the Paradigma model, through Paradigma's model proxy with the run's task token
 *   (the hosted agent's provider, models, caps and zero data retention; no secret);
 * - with "Use my own key", the customer's own provider straight from the runner: the Anthropic
 *   Messages API (`ANTHROPIC_API_KEY`) or OpenRouter's chat completions (`OPENROUTER_API_KEY`).
 *
 * A conversation keeps its own message format; the loop only sees tool calls, text and usage.
 * Provider errors become a category: their bodies can echo the request (repository text), so they
 * never reach a log or the report.
 */

export type FixProvider = "paradigma" | OwnModelProvider;

export interface FixToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface FixTurn {
  calls: FixToolCall[];
  usage: { input: number; output: number };
}

export interface FixConversation {
  readonly provider: FixProvider;
  readonly model: string;
  /** One model call; the assistant's message is kept in the conversation. */
  step(maxTokens: number): Promise<FixTurn>;
  /** The results of the last turn's tool calls, in order. */
  addToolResults(results: { id: string; output: unknown }[]): void;
}

export type FixModelErrorCategory =
  | "no_model_key"
  | "rate_limited"
  | "provider_error"
  /** The Paradigma model is not available (the hosted provider is down or not configured). */
  | "model_unavailable"
  /** The run's token or turn cap is spent (the proxy enforces the hosted caps). */
  | "caps"
  /** The task token was refused: the task moved on or expired. */
  | "token_expired";

export class FixModelError extends Error {
  constructor(readonly category: FixModelErrorCategory) {
    super(`Model call failed: ${category}`);
    this.name = "FixModelError";
  }
}

const OWN_KEY_ENV: Record<OwnModelProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * The customer's own provider and key from the environment ("Use my own key"): the provider
 * Paradigma names, or else Anthropic first, then OpenRouter. Null without a key.
 */
export function fixModelKey(
  env: Record<string, string | undefined>,
  provider: OwnModelProvider | null = null,
): { provider: OwnModelProvider; key: string } | null {
  const order: OwnModelProvider[] = provider
    ? [provider]
    : ["anthropic", "openrouter"];
  for (const name of order) {
    const key = env[OWN_KEY_ENV[name]]?.trim();
    if (key) return { provider: name, key };
  }
  return null;
}

/**
 * The GitHub Actions workflow command that masks a value in the job's logs: every later line
 * that contains it shows `***`. Printed before the value is used anywhere.
 */
export function maskCommand(value: string): string {
  const escaped = value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  return `::add-mask::${escaped}\n`;
}

/** The category of a failed HTTP call, from its status only. */
export function modelErrorCategory(status: number): FixModelErrorCategory {
  if (status === 401 || status === 403) return "no_model_key";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

const MAX_TOOL_RESULT_CHARS = ACTION_MODEL_MAX_TOOL_RESULT;

/** The tool's JSON Schema without the `$schema` marker some providers refuse. */
function toolSchema(tool: ActionTool): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = tool.inputSchema;
  return schema;
}

function resultText(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)`
    : text;
}

export interface ConversationOptions {
  provider: FixProvider;
  /** The customer's key (their own provider), or the run's task token (the Paradigma proxy). */
  key: string;
  model: string;
  system: string;
  prompt: string;
  tools: readonly ActionTool[];
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  /** Base URLs (tests); defaults are the providers' public APIs. */
  anthropicUrl?: string;
  openrouterUrl?: string;
  /** The Paradigma origin that issued the task (the model proxy). */
  paradigmaUrl?: string;
  timeoutMs?: number;
}

const RETRIES = 4;

async function post(
  options: ConversationOptions,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  let last: FixModelErrorCategory = "provider_error";
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0)
      await options.sleep(Math.min(30_000, 2_000 * 2 ** attempt));
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
    } catch {
      last = "provider_error";
      continue;
    }
    if (response.ok) {
      try {
        return (await response.json()) as Record<string, unknown>;
      } catch {
        throw new FixModelError("provider_error");
      }
    }
    last = modelErrorCategory(response.status);
    // Drain without reading it anywhere: the body may echo the request.
    await response.body?.cancel().catch(() => undefined);
    if (last === "no_model_key") break;
    if (response.status < 500 && response.status !== 429) break;
  }
  throw new FixModelError(last);
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

class AnthropicConversation implements FixConversation {
  readonly provider = "anthropic" as const;
  private readonly messages: { role: "user" | "assistant"; content: unknown }[];

  constructor(private readonly options: ConversationOptions) {
    this.messages = [{ role: "user", content: options.prompt }];
  }

  get model() {
    return this.options.model;
  }

  async step(maxTokens: number): Promise<FixTurn> {
    const data = await post(
      this.options,
      `${this.options.anthropicUrl ?? "https://api.anthropic.com"}/v1/messages`,
      { "x-api-key": this.options.key, "anthropic-version": "2023-06-01" },
      {
        model: this.options.model,
        max_tokens: maxTokens,
        temperature: 0,
        system: this.options.system,
        tools: this.options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: toolSchema(tool),
        })),
        messages: this.messages,
      },
    );
    const content = Array.isArray(data.content)
      ? (data.content as AnthropicBlock[])
      : [];
    this.messages.push({ role: "assistant", content });
    const usage = (data.usage ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    return {
      calls: content
        .filter((block) => block.type === "tool_use")
        .map((block) => {
          const call = block as Extract<AnthropicBlock, { type: "tool_use" }>;
          return { id: call.id, name: call.name, input: call.input };
        }),
      usage: {
        input:
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        output: usage.output_tokens ?? 0,
      },
    };
  }

  addToolResults(results: { id: string; output: unknown }[]) {
    if (results.length === 0) return;
    this.messages.push({
      role: "user",
      content: results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.id,
        content: resultText(result.output),
      })),
    });
  }
}

class OpenRouterConversation implements FixConversation {
  readonly provider = "openrouter" as const;
  private readonly messages: Record<string, unknown>[];

  constructor(private readonly options: ConversationOptions) {
    this.messages = [
      { role: "system", content: options.system },
      { role: "user", content: options.prompt },
    ];
  }

  get model() {
    return this.options.model;
  }

  async step(maxTokens: number): Promise<FixTurn> {
    const data = await post(
      this.options,
      `${this.options.openrouterUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`,
      {
        authorization: `Bearer ${this.options.key}`,
        "x-title": "Paradigma fix",
        "http-referer": "https://paradigma.click",
      },
      {
        model: this.options.model,
        max_tokens: maxTokens,
        temperature: 0,
        tools: this.options.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: toolSchema(tool),
          },
        })),
        messages: this.messages,
        usage: { include: true },
      },
    );
    const choice = (Array.isArray(data.choices) ? data.choices[0] : null) as {
      message?: {
        content?: string | null;
        tool_calls?: {
          id: string;
          function: { name: string; arguments: string };
        }[];
      };
    } | null;
    const message = choice?.message ?? {};
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    this.messages.push({
      role: "assistant",
      content: message.content ?? "",
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    const usage = (data.usage ?? {}) as {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
    return {
      calls: toolCalls.map((call) => {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = {};
        }
        return { id: call.id, name: call.function.name, input };
      }),
      usage: {
        input: usage.prompt_tokens ?? 0,
        output: usage.completion_tokens ?? 0,
      },
    };
  }

  addToolResults(results: { id: string; output: unknown }[]) {
    for (const result of results)
      this.messages.push({
        role: "tool",
        tool_call_id: result.id,
        content: resultText(result.output),
      });
  }
}

/** The category of a failed proxy call, from its status and error code only. */
export function proxyErrorCategory(
  status: number,
  code: unknown,
): FixModelErrorCategory {
  if (status === 401 || status === 403 || status === 404 || status === 410)
    return "token_expired";
  if (code === "caps") return "caps";
  if (code === "model_unavailable" || code === "own_model" || status === 503)
    return "model_unavailable";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

/**
 * The Paradigma model, through the model proxy. The system prompt and the tools stay on the
 * server (the proxy uses its own), so only the conversation travels: over TLS, in memory, never
 * stored. The proxy enforces the run's caps and records tokens and cost.
 */
class ParadigmaConversation implements FixConversation {
  readonly provider = "paradigma" as const;
  private readonly messages: ActionModelMessage[];
  private lastCalls = new Map<string, string>();
  private servedModel: string;

  constructor(private readonly options: ConversationOptions) {
    this.messages = [{ role: "user", content: options.prompt }];
    this.servedModel = options.model;
  }

  get model() {
    return this.servedModel;
  }

  async step(maxTokens: number): Promise<FixTurn> {
    const url = `${this.options.paradigmaUrl ?? "https://paradigma.click"}${FIX_ACTION_PATHS.model}`;
    let last: FixModelErrorCategory = "provider_error";
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0)
        await this.options.sleep(Math.min(30_000, 2_000 * 2 ** attempt));
      let response: Response;
      try {
        response = await this.options.fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.key}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ messages: this.messages, maxTokens }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
        });
      } catch {
        last = "provider_error";
        continue;
      }
      if (response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new FixModelError("provider_error");
        }
        const parsed = actionModelResponseSchema.safeParse(body);
        if (!parsed.success) throw new FixModelError("provider_error");
        const turn = parsed.data;
        this.servedModel = turn.model;
        this.messages.push({
          role: "assistant",
          text: turn.text,
          toolCalls: turn.toolCalls,
        });
        this.lastCalls = new Map(
          turn.toolCalls.map((call) => [call.id, call.name]),
        );
        return {
          calls: turn.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            input: call.input,
          })),
          usage: { input: turn.usage.input, output: turn.usage.output },
        };
      }
      let code: unknown = null;
      try {
        code = ((await response.json()) as { error?: unknown }).error;
      } catch {
        code = null;
      }
      last = proxyErrorCategory(response.status, code);
      if (last !== "rate_limited" && last !== "provider_error") break;
      if (response.status < 500 && response.status !== 429) break;
    }
    throw new FixModelError(last);
  }

  addToolResults(results: { id: string; output: unknown }[]) {
    if (results.length === 0) return;
    this.messages.push({
      role: "tool",
      results: results.map((result) => ({
        id: result.id,
        name: this.lastCalls.get(result.id) ?? "unknown",
        output: resultText(result.output),
      })),
    });
  }
}

export function startConversation(
  options: ConversationOptions,
): FixConversation {
  if (options.provider === "paradigma")
    return new ParadigmaConversation(options);
  return options.provider === "anthropic"
    ? new AnthropicConversation(options)
    : new OpenRouterConversation(options);
}
