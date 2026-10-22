import {
  type ActionBudget,
  DEFAULT_ACTION_BUDGET,
  type GiveUpReason,
} from "./contract/fix-action";

export { DEFAULT_ACTION_BUDGET };

/**
 * When the Paradigma agent in the Action stops making progress and should give up before the
 * caps (docs/36 §15, 22/10/2026). Pure: the loop reports each model turn and each tool call with
 * its result, and asks before the next turn whether to stop.
 *
 * Why: on 19 to 22/10 four onSET runs spent about 145k input tokens each (the cap is 150k) on
 * reads and searches and never wrote a file, and three cleanups spent the same while their checks
 * kept failing. The two runs that opened a verified pull request wrote by their third turn and
 * used about 25k input tokens. The hosted loop already stops on repeated unknown checks (18/10);
 * this loop had no such rule.
 *
 * The rules, across both attempts of a run:
 * - `no_edit`: no accepted write within `editByTurn` turns or `editByInputTokens` input tokens;
 * - `budget`: the next turn could cross the run's input budget (the context only grows);
 * - `unverifiable`: check_html answered unknown twice for one acceptance item (hosted parity);
 * - `check_stalled`: check_html failed twice in a row without fewer problems than its best;
 * - `repeated_call`: the same read, search, listing or brief three times since the last write;
 * - `check_refused`: Paradigma refused the same check_html call twice.
 */

/** Unknown answers for one acceptance item before the run stops (the hosted loop's rule). */
export const UNKNOWN_ANSWERS_BEFORE_STOP = 2;
/** Failing checks in a row that do not beat the best one, before the run stops. */
export const CHECK_STALLS_BEFORE_STOP = 2;
/** Identical read-only calls since the last write, before the run stops. */
export const REPEATS_BEFORE_STOP = 3;
/** Identical refusals of check_html, before the run stops. */
export const REFUSALS_BEFORE_STOP = 2;

/** Tools that only read: calling one again with the same input returns the same thing. */
const READ_ONLY_TOOLS = new Set([
  "get_task_brief",
  "list_files",
  "read_file",
  "search",
]);

/** JSON with sorted keys, so `{a,b}` and `{b,a}` are the same call. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

interface CheckOutput {
  passed?: unknown;
  results?: { id?: unknown; status?: unknown }[];
  feedback?: unknown[];
  ok?: unknown;
  error?: unknown;
}

export class FixProgress {
  private turns = 0;
  private lastTurn: { input: number; output: number } | null = null;
  private edited = false;
  private gaveUp: GiveUpReason | null = null;
  private readonly repeats = new Map<string, number>();
  private readonly unknowns = new Map<string, number>();
  private readonly refusals = new Map<string, number>();
  /** Per check target (the edited files, or a URL): the fewest problems seen, and stalls since. */
  private readonly checks = new Map<string, { best: number; stalls: number }>();

  constructor(readonly budget: ActionBudget = DEFAULT_ACTION_BUDGET) {}

  /** Whether an accepted write happened in this run. */
  get hasEdit(): boolean {
    return this.edited;
  }

  /** One model turn finished, with its usage. */
  turn(usage: { input: number; output: number }) {
    this.turns += 1;
    this.lastTurn = usage;
  }

  /** One tool call and the result the model gets back. */
  tool(name: string, input: unknown, output: unknown) {
    if (this.gaveUp) return;
    if (name === "write_file") {
      if ((output as { ok?: unknown } | null)?.ok === true) {
        this.edited = true;
        // The files changed: reading them again, or checking again, is new information.
        this.repeats.clear();
        this.refusals.clear();
      }
      return;
    }
    if (READ_ONLY_TOOLS.has(name)) {
      const key = `${name}:${stableJson(input ?? {})}`;
      const count = (this.repeats.get(key) ?? 0) + 1;
      this.repeats.set(key, count);
      if (count >= REPEATS_BEFORE_STOP) this.gaveUp = "repeated_call";
      return;
    }
    if (name === "check_html") this.check(input, output as CheckOutput | null);
  }

  private check(input: unknown, output: CheckOutput | null) {
    if (!output || typeof output !== "object") return;
    if (output.ok === false) {
      const key = `${stableJson(input ?? {})}:${String(output.error ?? "")}`;
      const count = (this.refusals.get(key) ?? 0) + 1;
      this.refusals.set(key, count);
      if (count >= REFUSALS_BEFORE_STOP) this.gaveUp = "check_refused";
      return;
    }
    if (!Array.isArray(output.results)) return;
    for (const result of output.results)
      if (result?.status === "unknown") {
        const id = String(result.id ?? "");
        const count = (this.unknowns.get(id) ?? 0) + 1;
        this.unknowns.set(id, count);
        if (count >= UNKNOWN_ANSWERS_BEFORE_STOP) this.gaveUp = "unverifiable";
      }
    if (this.gaveUp) return;
    const url = (input as { url?: unknown } | null)?.url;
    const target = typeof url === "string" ? `url:${url}` : "files";
    if (output.passed === true) {
      // A later failure is a new problem: it starts its own count.
      this.checks.delete(target);
      return;
    }
    const problems =
      output.results.filter((result) => result?.status !== "pass").length +
      (Array.isArray(output.feedback) ? output.feedback.length : 0);
    const seen = this.checks.get(target);
    if (!seen || problems < seen.best) {
      this.checks.set(target, { best: problems, stalls: 0 });
      return;
    }
    seen.stalls += 1;
    if (seen.stalls >= CHECK_STALLS_BEFORE_STOP) this.gaveUp = "check_stalled";
  }

  /** Why the run should stop before its next turn, or null to go on. */
  stop(totals: { input: number }): GiveUpReason | null {
    if (this.gaveUp) return this.gaveUp;
    if (
      !this.edited &&
      (this.turns >= this.budget.editByTurn ||
        totals.input >= this.budget.editByInputTokens)
    )
      return "no_edit";
    const next = this.lastTurn
      ? this.lastTurn.input + this.lastTurn.output + 2_000
      : 0;
    if (totals.input + next > this.budget.inputTokens) return "budget";
    return null;
  }
}
