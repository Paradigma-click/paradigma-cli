import {
  type CliProjectScan,
  projectScanResponseSchema,
} from "../contract/cli-api";

const counts = (pass: number, partial: number, fail: number, na: number) => ({
  pass,
  partial,
  fail,
  na,
});

/** A completed scan of an unverified project, as GET /projects/<id>/scan answers. */
export function sampleScan(
  projectId: string,
  overrides: Partial<CliProjectScan> = {},
): CliProjectScan {
  return projectScanResponseSchema.parse({
    projectId,
    productionUrl: "https://acme.test",
    status: "completed",
    scannedAt: "2026-10-16T09:12:00.000Z",
    pillars: [
      {
        pillar: "seo",
        name: "SEO",
        score: 92,
        label: "Strong",
        counts: counts(28, 2, 1, 4),
      },
      {
        pillar: "aeo",
        name: "AEO",
        score: 71,
        label: "Ready with gaps",
        counts: counts(9, 2, 2, 3),
      },
      {
        pillar: "geo",
        name: "GEO",
        score: 48,
        label: "Likely to struggle",
        counts: counts(6, 3, 5, 2),
      },
      {
        pillar: "agents",
        name: "Agents",
        score: 96,
        label: "Strong",
        counts: counts(29, 6, 10, 22),
      },
    ],
    fixes: [
      {
        id: "geo/access/robots-ai-crawlers",
        title: "AI crawlers may read your pages",
        pillar: "geo",
        pillars: ["geo", "agents"],
        status: "fail",
        summary: "robots.txt blocks GPTBot and ClaudeBot",
        fix: "Allow GPTBot, ClaudeBot and PerplexityBot in robots.txt.",
        autopilot: true,
      },
      {
        id: "aeo/extractability/faq",
        title: "Questions get a direct answer",
        pillar: "aeo",
        pillars: ["aeo"],
        status: "partial",
        summary: "3 of 8 pages answer their question in the first paragraph",
        fix: "Open each page with a one-sentence answer.",
        autopilot: false,
      },
      {
        id: "seo/understanding/meta-description",
        title: "Every page has a description",
        pillar: "seo",
        pillars: ["seo"],
        status: "partial",
        summary: "2 of 12 pages have no meta description",
        fix: "Add a meta description to /pricing and /about.",
        autopilot: true,
      },
      {
        id: "agents/discover/llms-txt",
        title: "The site has an llms.txt",
        pillar: "agents",
        pillars: ["agents"],
        status: "fail",
        summary: "No /llms.txt",
        fix: null,
        autopilot: false,
      },
    ],
    openFixes: 9,
    dashboardUrl: `https://app.paradigma.test/dashboard/sites/${projectId}`,
    locked: true,
    next: {
      id: "verify_domain",
      label: "Verify the domain to unlock these fixes as tasks",
      command: `npx paradigma-cli verify --project ${projectId}`,
    },
    ...overrides,
  });
}

/** No completed scan yet; the onboarding scan is `status`. */
export function pendingScan(
  projectId: string,
  status: CliProjectScan["status"] = "running",
): CliProjectScan {
  return sampleScan(projectId, {
    status,
    scannedAt: null,
    pillars: [],
    fixes: [],
    openFixes: 0,
  });
}
