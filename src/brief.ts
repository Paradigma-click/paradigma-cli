import { type TaskBrief, taskBriefSchema } from "./contract/harness";

/**
 * The task brief (docs/36 §5.1) in the CLI: read from a started task and turned into prompt
 * sections. Without a brief, the task's own instructions still apply, exactly as before.
 */

/** Reads a brief body, checks its shape and that it belongs to this task; null otherwise. */
export function parseBrief(value: unknown, taskId: string): TaskBrief | null {
  const parsed = taskBriefSchema.safeParse(value);
  return parsed.success && parsed.data.taskId === taskId ? parsed.data : null;
}

function list(items: readonly string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}

/** Prompt sections for a brief, in Markdown. */
export function briefSections(
  brief: TaskBrief,
  options: { checkHtml?: "mcp" | "none" } = {},
): string[] {
  const sections: string[] = [];
  if (brief.playbook)
    sections.push(
      [
        `## Playbook: ${brief.playbook.title}`,
        `Framework: ${brief.framework.label}`,
        brief.playbook.anchorFiles.length
          ? `Where this fix usually lives (relative to the app root):\n${list(brief.playbook.anchorFiles)}`
          : "",
        `Steps:\n${list(brief.playbook.steps)}`,
        brief.playbook.pitfalls.length
          ? `Avoid:\n${list(brief.playbook.pitfalls)}`
          : "",
        brief.playbook.verify.length
          ? `Before finishing:\n${list(brief.playbook.verify)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  if (brief.acceptance.length)
    sections.push(
      `## Acceptance items\nEach item has a stable id; the task passes when every item passes.\n${list(
        brief.acceptance.map(
          (item) =>
            `\`${item.id}\` (${item.scope}, ${item.url}): ${item.checks} Passing means: ${item.passMeans}`,
        ),
      )}`,
    );
  if (brief.evidence.length)
    sections.push(
      `## Evidence\n${list(
        brief.evidence.map(
          (record) =>
            `${record.id} (${record.source}, coverage ${record.coverage}): ${record.seen}${
              record.unknowns.length
                ? ` Not seen: ${record.unknowns.join("; ")}.`
                : ""
            }`,
        ),
      )}`,
    );
  if (brief.untrusted.blocks.length)
    sections.push(
      `## Untrusted data\n${brief.untrusted.note}\n\n${brief.untrusted.blocks
        .map((block) => `${block.label}:\n${block.text}`)
        .join("\n\n")}`,
    );
  if (options.checkHtml === "mcp")
    sections.push(
      `## Checking your work\nIf the Paradigma MCP tools are available to you, call \`check_html\` with \`{ "taskId": "${brief.taskId}", "url": "<an acceptance item's URL>", "html": "<the page's rendered HTML>" }\` (or only \`url\` for a public page). It answers pass, fail or unknown per acceptance id with evidence. It is the only network call allowed; skip it when the tool is not available, Paradigma checks the result after you finish.`,
    );
  return sections;
}
