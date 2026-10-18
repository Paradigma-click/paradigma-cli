import type { ActionCaps } from "./contract/fix-action";
import { type FixConversation, FixModelError } from "./fix-model";
import type { FixWorkspace } from "./fix-tools";

/**
 * One attempt of the Paradigma agent's tool loop in the Action (the hosted loop's rules, docs/36
 * §6): turns are capped per attempt, tokens across both attempts, and each turn's output by what
 * is left. It stops when the agent calls `finish_task`, ends its turn without a tool call, or a
 * cap would be crossed. Tool calls run against the workspace, which enforces the limits.
 */

export interface FixTotals {
  input: number;
  output: number;
}

export interface AttemptResult {
  turns: number;
  /** Why the attempt ended. */
  stop: "finished" | "no_tool_call" | "turns" | "tokens";
}

export function maxTokensFor(caps: ActionCaps, totals: FixTotals): number {
  return Math.max(
    256,
    Math.min(caps.maxOutputPerTurn, caps.maxOutputTokens - totals.output),
  );
}

/** Whether the next turn could cross a token cap (the context only grows). */
export function tokensSpent(
  caps: ActionCaps,
  totals: FixTotals,
  last: { input: number; output: number } | null,
): boolean {
  const next = last ? last.input + last.output + 2_000 : 0;
  return (
    totals.input + next > caps.maxInputTokens ||
    totals.output >= caps.maxOutputTokens
  );
}

export async function runAttempt(input: {
  conversation: FixConversation;
  workspace: FixWorkspace;
  caps: ActionCaps;
  totals: FixTotals;
  onTool?: (name: string) => void;
}): Promise<AttemptResult> {
  const { conversation, workspace, caps, totals } = input;
  let last: { input: number; output: number } | null = null;
  for (let turn = 1; turn <= caps.maxTurns; turn++) {
    if (tokensSpent(caps, totals, last))
      return { turns: turn - 1, stop: "tokens" };
    let step: Awaited<ReturnType<FixConversation["step"]>>;
    try {
      step = await conversation.step(maxTokensFor(caps, totals));
    } catch (error) {
      // The proxy enforces the run's caps on the server too: a spent cap ends the attempt.
      if (error instanceof FixModelError && error.category === "caps")
        return { turns: turn - 1, stop: "tokens" };
      throw error;
    }
    totals.input += step.usage.input;
    totals.output += step.usage.output;
    last = step.usage;
    if (step.calls.length === 0) return { turns: turn, stop: "no_tool_call" };
    const results: { id: string; output: unknown }[] = [];
    for (const call of step.calls) {
      input.onTool?.(call.name);
      results.push({
        id: call.id,
        output: await workspace.call(call.name, call.input),
      });
    }
    conversation.addToolResults(results);
    if (step.calls.some((call) => call.name === "finish_task"))
      return { turns: turn, stop: "finished" };
  }
  return { turns: caps.maxTurns, stop: "turns" };
}
