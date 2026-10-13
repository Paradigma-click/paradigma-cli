import type { TaskPayload } from "../contract/autopilot";

export const RUNNER_ID = "11111111-1111-4111-8111-111111111111";
export const REPO_ID = "22222222-2222-4222-8222-222222222222";

export function taskPayload(overrides: Partial<TaskPayload> = {}): TaskPayload {
  const now = Date.now();
  return {
    v: 1,
    taskId: "33333333-3333-4333-8333-333333333333",
    runnerId: RUNNER_ID,
    repo: {
      id: REPO_ID,
      owner: "acme",
      name: "site",
      defaultBranch: "main",
      appRoot: "",
    },
    kind: "metadata.title",
    category: "metadata",
    risk: "low",
    mode: "notify",
    title: "Add a descriptive title to the home page",
    instructions: "Set metadata.title in app/layout.tsx to describe the site.",
    acceptance: ["app/layout.tsx exports metadata with a non-empty title"],
    allowedPaths: ["app/**"],
    diffBudget: { maxFiles: 3, maxLines: 40 },
    impact: { impressions: 1200 },
    findingId: null,
    revertsPrNumber: null,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    ...overrides,
  };
}
