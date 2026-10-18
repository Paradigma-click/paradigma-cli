import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIX_ACTION_USES, fixActionWorkflow } from "./contract/fix-action";
import { VERSION } from "./version";

const root = join(__dirname, "..");
const action = readFileSync(join(root, "action", "action.yml"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  repository: { url: string };
  bin: Record<string, string>;
};

/** A GitHub Actions expression, e.g. `${{ inputs.task }}`. */
function expr(body: string): string {
  return body ? `\${{ ${body} }}` : "${{";
}

/** The input names declared under `inputs:` (two-space keys). */
function inputNames(text: string): string[] {
  const block = text.split(/^inputs:\n/m)[1]?.split(/^\S/m)[0] ?? "";
  return [...block.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]);
}

describe("cli/action/action.yml", () => {
  it("is a composite action whose task token only travels through env", () => {
    expect(action).toMatch(/^ {2}using: composite$/m);
    const runLines = action.split("\n").filter((line) => /^\s+run:/.test(line));
    expect(runLines.length).toBeGreaterThan(0);
    for (const line of runLines) expect(line).not.toContain(expr("").trim());
    expect(action).toContain(`PARADIGMA_FIX_TASK: ${expr("inputs.task")}`);
    expect(action).toContain(`echo "::add-mask::\${PARADIGMA_FIX_TASK}"`);
    expect(action).toContain(`GITHUB_TOKEN: ${expr("github.token")}`);
  });

  it("runs the CLI version this package releases", () => {
    const match = /cli-version:\n(?:\s+\w+:.*\n)*?\s+default: "([^"]+)"/.exec(
      action,
    );
    expect(match?.[1]).toBe(pkg.version);
  });

  it("lives where the workflow template points, with every input it passes", () => {
    expect(pkg.repository.url).toContain("Paradigma-click/paradigma-cli");
    expect(FIX_ACTION_USES).toBe("Paradigma-click/paradigma-cli/action@v1");
    const workflow = fixActionWorkflow({ appUrl: "https://paradigma.click/x" });
    const withBlock = workflow
      .split("        with:\n")[1]
      .split("        env:")[0];
    const passed = [...withBlock.matchAll(/^ {10}([a-z-]+):/gm)].map(
      (m) => m[1],
    );
    expect(passed.length).toBeGreaterThan(0);
    for (const name of passed) expect(inputNames(action)).toContain(name);
    expect(workflow).toContain("api-url: https://paradigma.click\n");
  });
});

it("keeps VERSION in sync with cli/package.json", () => {
  expect(pkg.version).toBe(VERSION);
  expect(pkg.bin).toEqual({ paradigma: "dist/paradigma.mjs" });
});
