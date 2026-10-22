import type { ActionCaps, GiveUpReason } from "./contract/fix-action";
import {
  type FixConversation,
  FixModelError,
  type FixModelErrorCategory,
} from "./fix-model";
import type { FixProgress } from "./fix-progress";
import type { FixWorkspace } from "./fix-tools";

/**
 * One attempt of the Paradigma agent's tool loop in the Action (the hosted loop's rules, docs/36
 * §6): turns are capped per attempt, tokens across both attempts, and each turn's output by what
 * is left. It stops when the agent calls `finish_task`, ends its turn without a tool call, a cap
 * would be crossed, or the run stops making progress (`FixProgress`, docs/36 §15, 22/10/2026).
 * Tool calls run against the workspace, which enforces the limits.
 */

export interface FixTotals {
  input: number;
  output: number;
}

export interface AttemptResult {
  turns: number;
  /** Why the attempt ended. */
  stop: "finished" | "no_tool_call" | "turns" | "tokens" | "gave_up" | "model";
  /** With `gave_up`: why the run stopped making progress. */
  gaveUp?: GiveUpReason;
  /** With `model`: the model call failed after its retries (the edit so far may still pass). */
  modelError?: FixModelErrorCategory;
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
  /** The run's progress across both attempts; without it only the caps stop the loop. */
  progress?: FixProgress;
  onTool?: (name: string) => void;
}): Promise<AttemptResult> {
  const { conversation, workspace, caps, totals, progress } = input;
  let last: { input: number; output: number } | null = null;
  for (let turn = 1; turn <= caps.maxTurns; turn++) {
    const gaveUp = progress?.stop(totals);
    if (gaveUp) return { turns: turn - 1, stop: "gave_up", gaveUp };
    if (tokensSpent(caps, totals, last))
      return { turns: turn - 1, stop: "tokens" };
    let step: Awaited<ReturnType<FixConversation["step"]>>;
    try {
      step = await conversation.step(maxTokensFor(caps, totals));
    } catch (error) {
      if (!(error instanceof FixModelError)) throw error;
      // The proxy enforces the run's caps and its budget on the server too: either ends the
      // attempt. A budget refusal says which rule refused the turn.
      if (error.category === "caps")
        return error.budget
          ? { turns: turn - 1, stop: "gave_up", gaveUp: error.budget }
          : { turns: turn - 1, stop: "tokens" };
      // A dead token ends the run. Any other model failure (after the retries) ends the attempt:
      // the caller decides whether what was written so far is worth the final check.
      if (error.category === "token_expired") throw error;
      return { turns: turn - 1, stop: "model", modelError: error.category };
    }
    totals.input += step.usage.input;
    totals.output += step.usage.output;
    last = step.usage;
    progress?.turn(step.usage);
    if (step.calls.length === 0) return { turns: turn, stop: "no_tool_call" };
    const results: { id: string; output: unknown }[] = [];
    for (const call of step.calls) {
      input.onTool?.(call.name);
      const output = await workspace.call(call.name, call.input);
      progress?.tool(call.name, call.input, output);
      results.push({ id: call.id, output });
    }
    conversation.addToolResults(results);
    if (step.calls.some((call) => call.name === "finish_task"))
      return { turns: turn, stop: "finished" };
  }
  return { turns: caps.maxTurns, stop: "turns" };
}
