import { describe, expect, it } from "vitest";
import { briefSections, parseBrief } from "./brief";
import { formatStartedTask } from "./tasks";
import { startTaskResponseSchema } from "./tasks-api";
import { brief, taskId } from "./test/brief";

describe("task brief", () => {
  it("reads only briefs for this task", () => {
    expect(parseBrief(brief, taskId)).toEqual(brief);
    expect(parseBrief({ ...brief, taskId: "x" }, taskId)).toBeNull();
    expect(parseBrief({ v: 2 }, taskId)).toBeNull();
  });

  it("only mentions check_html when asked", () => {
    expect(briefSections(brief).join("\n")).not.toContain("check_html`");
  });

  it("reads a brief on started tasks tolerantly", () => {
    const started = {
      id: taskId,
      title: "t",
      branch: "paradigma/55555555",
    };
    expect(
      startTaskResponseSchema.parse({ task: { ...started, brief } }).task.brief,
    ).toEqual(brief);
    expect(
      startTaskResponseSchema.parse({ task: { ...started, brief: { v: 9 } } })
        .task.brief,
    ).toBeNull();
    expect(
      startTaskResponseSchema.parse({ task: started }).task.brief,
    ).toBeUndefined();
  });

  it("prints the brief after the instructions of a started task", () => {
    const started = startTaskResponseSchema.parse({
      task: { id: taskId, title: "t", branch: "paradigma/55555555", brief },
    }).task;
    const lines = formatStartedTask(started).join("\n");
    expect(lines).toContain("## Playbook: Astro: <head> in the layout");
    expect(lines).toContain("`metadata.description`");
    expect(lines.indexOf("Instructions:")).toBeLessThan(
      lines.indexOf("## Playbook"),
    );
  });
});
