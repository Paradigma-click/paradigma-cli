import { describe, expect, it } from "vitest";
import {
  CHECK_STALLS_BEFORE_STOP,
  DEFAULT_ACTION_BUDGET,
  FixProgress,
  REPEATS_BEFORE_STOP,
} from "./fix-progress";

const WROTE = { ok: true, path: "a.html" };
const failing = (ids: string[], feedback: string[] = []) => ({
  mode: "static",
  passed: false,
  results: ids.map((id) => ({ id, status: "fail" })),
  feedback,
});

describe("FixProgress", () => {
  it("defaults to the budget the server sends (docs/36 §15)", () => {
    expect(DEFAULT_ACTION_BUDGET).toEqual({
      inputTokens: 100_000,
      editByInputTokens: 60_000,
      editByTurn: 8,
    });
    expect(new FixProgress().budget).toBe(DEFAULT_ACTION_BUDGET);
  });

  it("gives up without an accepted write after the edit window's turns", () => {
    const progress = new FixProgress();
    for (let turn = 1; turn < 8; turn++) {
      progress.turn({ input: 1_000, output: 50 });
      progress.tool("read_file", { path: `f${turn}` }, { ok: true });
      expect(progress.stop({ input: turn * 1_000 })).toBeNull();
    }
    progress.turn({ input: 1_000, output: 50 });
    expect(progress.stop({ input: 8_000 })).toBe("no_edit");
  });

  it("gives up without an accepted write after the edit window's tokens", () => {
    const progress = new FixProgress();
    progress.turn({ input: 5_000, output: 10 });
    expect(progress.stop({ input: 59_999 })).toBeNull();
    expect(progress.stop({ input: 60_000 })).toBe("no_edit");
  });

  it("a refused write does not open the window; an accepted one does", () => {
    const progress = new FixProgress();
    progress.turn({ input: 5_000, output: 10 });
    progress.tool(
      "write_file",
      { path: "a" },
      { ok: false, reason: "path_not_allowed" },
    );
    expect(progress.stop({ input: 70_000 })).toBe("no_edit");
    progress.tool("write_file", { path: "a" }, WROTE);
    expect(progress.hasEdit).toBe(true);
    expect(progress.stop({ input: 70_000 })).toBeNull();
  });

  it("gives up when the next turn could cross the input budget", () => {
    const progress = new FixProgress({
      inputTokens: 50_000,
      editByInputTokens: 30_000,
      editByTurn: 5,
    });
    progress.tool("write_file", { path: "a" }, WROTE);
    progress.turn({ input: 20_000, output: 500 });
    // 20k so far, the next turn about 22.5k: within 50k.
    expect(progress.stop({ input: 20_000 })).toBeNull();
    progress.turn({ input: 22_000, output: 500 });
    // 42k so far, the next turn about 24.5k: past 50k.
    expect(progress.stop({ input: 42_000 })).toBe("budget");
  });

  it("gives up on the same read-only call, whatever the key order", () => {
    const progress = new FixProgress();
    for (let i = 1; i < REPEATS_BEFORE_STOP; i++) {
      progress.tool("search", { query: "x", glob: "*.tsx" }, { matches: [] });
      expect(progress.stop({ input: 0 })).toBeNull();
    }
    progress.tool("search", { glob: "*.tsx", query: "x" }, { matches: [] });
    expect(progress.stop({ input: 0 })).toBe("repeated_call");
  });

  it("a write resets the repeat count: re-reading an edited file is new", () => {
    const progress = new FixProgress();
    progress.tool("read_file", { path: "a" }, {});
    progress.tool("read_file", { path: "a" }, {});
    progress.tool("write_file", { path: "a" }, WROTE);
    progress.tool("read_file", { path: "a" }, {});
    progress.tool("read_file", { path: "a" }, {});
    expect(progress.stop({ input: 0 })).toBeNull();
  });

  it("gives up on two unknown answers for one acceptance item (hosted parity)", () => {
    const progress = new FixProgress();
    const unknown = {
      passed: false,
      results: [
        { id: "sitemap.valid", status: "unknown" },
        { id: "sitemap.exists", status: "pass" },
      ],
      feedback: [],
    };
    progress.tool("write_file", { path: "a" }, WROTE);
    progress.tool("check_html", {}, unknown);
    expect(progress.stop({ input: 0 })).toBeNull();
    progress.tool("check_html", {}, unknown);
    expect(progress.stop({ input: 0 })).toBe("unverifiable");
  });

  it("gives up after failing checks that do not get closer", () => {
    const progress = new FixProgress();
    progress.tool("write_file", { path: "a" }, WROTE);
    progress.tool("check_html", {}, failing(["a", "b"], ["x"]));
    // Fewer problems: progress, the stall count starts over.
    progress.tool("check_html", {}, failing(["a"], ["x"]));
    for (let i = 1; i < CHECK_STALLS_BEFORE_STOP; i++) {
      progress.tool("check_html", {}, failing(["a"], ["x"]));
      expect(progress.stop({ input: 0 })).toBeNull();
    }
    progress.tool("check_html", {}, failing(["b"], ["y"]));
    expect(progress.stop({ input: 0 })).toBe("check_stalled");
  });

  it("tracks each check target on its own and resets on a pass", () => {
    const progress = new FixProgress();
    progress.tool("write_file", { path: "a" }, WROTE);
    progress.tool("check_html", {}, failing(["a"]));
    progress.tool("check_html", { url: "/x" }, failing(["a"]));
    progress.tool("check_html", { url: "/y" }, failing(["a"]));
    progress.tool("check_html", {}, failing(["a"]));
    progress.tool(
      "check_html",
      {},
      { passed: true, results: [], feedback: [] },
    );
    progress.tool("check_html", {}, failing(["a"]));
    progress.tool("check_html", {}, failing(["a"]));
    expect(progress.stop({ input: 0 })).toBeNull();
  });

  it("gives up when Paradigma refuses the same check twice", () => {
    const progress = new FixProgress();
    const refused = { ok: false, error: "The URL is not valid." };
    progress.tool("check_html", { url: "nope" }, refused);
    progress.tool("check_html", { url: "other" }, refused);
    expect(progress.stop({ input: 0 })).toBeNull();
    progress.tool("check_html", { url: "nope" }, refused);
    expect(progress.stop({ input: 0 })).toBe("check_refused");
  });

  it("keeps the first reason it gave up for", () => {
    const progress = new FixProgress();
    progress.tool("read_file", { path: "a" }, {});
    progress.tool("read_file", { path: "a" }, {});
    progress.tool("read_file", { path: "a" }, {});
    progress.tool("check_html", {}, { ok: false, error: "x" });
    progress.tool("check_html", {}, { ok: false, error: "x" });
    expect(progress.stop({ input: 0 })).toBe("repeated_call");
  });
});
