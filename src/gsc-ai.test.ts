import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "./config";
import {
  GSC_AI_MAX_BYTES,
  gscAiCommand,
  gscAiImportDue,
  gscAiStatusLines,
} from "./gsc-ai";
import { UsageError } from "./io";
import { fakeIo, fakeServer } from "./test/platform";

const SERVER = "https://app.paradigma.test";
const TOKEN = `pdg_rt_${"c".repeat(43)}`;
const PROJECT = "11111111-1111-4111-8111-111111111111";
const PAGES = "Top pages,Impressions\nhttps://acme.test/private-guide,12";
const REPORT_URL =
  "https://search.google.com/search-console/performance/search-analytics/ai?resource_id=sc-domain%3Aacme.test";

const project = {
  id: PROJECT,
  orgId: "22222222-2222-4222-8222-222222222222",
  repoId: "33333333-3333-4333-8333-333333333333",
  repoFullName: "acme/web",
  appRoot: "",
  name: "Acme",
  productionUrl: "https://acme.test",
  verified: true,
};

function status(lastImport: { importedAt: string } | null) {
  return {
    projectId: PROJECT,
    productionUrl: "https://acme.test",
    verified: true,
    searchConsoleConnected: true,
    property: "sc-domain:acme.test",
    reportUrl: REPORT_URL,
    lastImport: lastImport
      ? {
          fromDate: "2026-06-01",
          toDate: "2026-09-19",
          pages: 120,
          days: 111,
          ...lastImport,
        }
      : null,
    settingsUrl: `${SERVER}/dashboard/sites/${PROJECT}/settings#gsc-ai`,
  };
}

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "paradigma-gsc-ai-"));
  vi.stubEnv("PARADIGMA_HOME", join(root, "home"));
  await saveConfig({
    server: SERVER,
    token: TOKEN,
    runnerId: "r",
    publicKey: "k".repeat(43),
    repos: {},
    repoNames: {},
    checks: {},
    paused: false,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

function server(last: { importedAt: string } | null = null) {
  return fakeServer({
    "GET /api/cli/v1/projects": () => ({ body: { projects: [project] } }),
    [`GET /api/cli/v1/projects/${PROJECT}/gsc-ai`]: () => ({
      body: status(last),
    }),
    [`POST /api/cli/v1/projects/${PROJECT}/gsc-ai`]: () => ({
      body: {
        projectId: PROJECT,
        imported: true,
        fromDate: "2026-06-01",
        toDate: "2026-09-19",
        pages: 1,
        days: 111,
        settingsUrl: `${SERVER}/dashboard/sites/${PROJECT}/settings#gsc-ai`,
      },
    }),
  });
}

describe("paradigma gsc-ai", () => {
  it("prints the last import and the exact export steps with the deep link", async () => {
    const api = server();
    const t = fakeIo({ fetch: api.fetch, cwd: root });
    await gscAiCommand(t.io, []);
    const output = t.stdout();
    expect(output).toContain("never imported");
    expect(output).toContain(REPORT_URL);
    expect(output).toContain("Export and download the .zip");
    expect(output).toContain(
      `npx paradigma-cli gsc-ai import <file.zip> --project ${PROJECT}`,
    );
    // Due: exit 3 so an agent knows to act.
    expect(process.exitCode).toBe(3);
  });

  it("is not due within 30 days of the last import", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(gscAiImportDue(null, now)).toBe(true);
    expect(gscAiImportDue("2026-09-20T08:00:00Z", now)).toBe(false);
    expect(gscAiImportDue("2026-09-16T12:00:00Z", now)).toBe(true);
    const lines = gscAiStatusLines(
      status({ importedAt: "2026-09-20T08:00:00Z" }),
      now,
    );
    expect(lines[0]).toContain(
      "last import 2026-09-20 (2026-06-01 to 2026-09-19, 120 pages)",
    );
    expect(lines).toContain("Next export (monthly):");
  });

  it("sends the export as base64 and never prints its contents", async () => {
    const file = join(root, "Pages.csv");
    writeFileSync(file, PAGES);
    const api = server();
    const t = fakeIo({ fetch: api.fetch, cwd: root });
    await gscAiCommand(t.io, ["import", "Pages.csv", "--json"]);
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({
      files: [
        { name: "Pages.csv", base64: Buffer.from(PAGES).toString("base64") },
      ],
    });
    const printed = t.stdout() + t.stderr();
    expect(printed).toContain('"imported":true');
    expect(printed).not.toContain("private-guide");
  });

  it("passes the report dates when given, both or neither", async () => {
    writeFileSync(join(root, "Pages.csv"), PAGES);
    const api = server();
    const t = fakeIo({ fetch: api.fetch, cwd: root });
    await gscAiCommand(t.io, [
      "import",
      "Pages.csv",
      "--from",
      "2026-09-01",
      "--to",
      "2026-09-30",
    ]);
    expect(api.calls.find((c) => c.method === "POST")?.body).toMatchObject({
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    });
    expect(t.stdout()).toContain("Imported the Search Console AI report");
    await expect(
      gscAiCommand(t.io, ["import", "Pages.csv", "--from", "2026-09-01"]),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("checks files before any network call", async () => {
    writeFileSync(join(root, "notes.txt"), "x");
    writeFileSync(join(root, "big.zip"), Buffer.alloc(GSC_AI_MAX_BYTES + 1));
    writeFileSync(join(root, "empty.csv"), "");
    const api = server();
    const t = fakeIo({ fetch: api.fetch, cwd: root });
    for (const args of [
      ["import"],
      ["import", "notes.txt"],
      ["import", "missing.csv"],
      ["import", "big.zip"],
      ["import", "empty.csv"],
      ["export"],
    ])
      await expect(gscAiCommand(t.io, args)).rejects.toBeInstanceOf(UsageError);
    expect(api.calls).toEqual([]);
  });
});
