import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformCommand } from "./commands";
import { saveConfig } from "./config";
import { ActionRequired } from "./io";
import { fakeIo, fakeServer } from "./test/platform";

const SERVER = "https://app.paradigma.test";
const TOKEN = `pdg_rt_${"c".repeat(43)}`;
const SECRET = "bing-KEY-secretVALUE-0123456789";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const REQUEST = "77777777-7777-4777-8777-777777777777";
const AUTH_URL =
  "https://www.bing.com/webmasters/OAuth/authorize?response_type=code&client_id=c&redirect_uri=https%3A%2F%2Fapp.paradigma.test%2Fdashboard%2Fconnect%2Fbing%2Fcallback&scope=webmaster.manage&state=s";

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

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "paradigma-bing-"));
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

function server(statuses: string[], available = true) {
  const queue = [...statuses];
  return fakeServer({
    "GET /api/cli/v1/projects": () => ({ body: { projects: [project] } }),
    [`POST /api/cli/v1/projects/${PROJECT}/bing/oauth`]: () => ({
      body: available
        ? {
            available: true,
            requestId: REQUEST,
            authorizationUrl: AUTH_URL,
            expiresAt: "2026-10-15T10:10:00.000Z",
            projectId: PROJECT,
          }
        : { available: false },
    }),
    [`GET /api/cli/v1/bing/oauth/${REQUEST}`]: () => ({
      body: {
        requestId: REQUEST,
        status: queue.shift() ?? "pending",
        projectId: PROJECT,
        expiresAt: "2026-10-15T10:10:00.000Z",
      },
    }),
    [`POST /api/cli/v1/projects/${PROJECT}/credentials`]: () => ({
      body: { projectId: PROJECT, connected: true, sync: null },
    }),
  });
}

describe("paradigma connect bing", () => {
  it("opens Microsoft's consent and polls until connected", async () => {
    const api = server(["pending", "choose", "connected"]);
    const t = fakeIo({ fetch: api.fetch, cwd: root, interactive: true });
    await platformCommand("connect", ["bing"], t.io);
    expect(t.opened).toEqual([AUTH_URL]);
    const output = t.stdout() + t.stderr();
    expect(output).toContain(AUTH_URL);
    expect(output).toContain("pick one in the browser");
    expect(output).toContain("Bing connected");
    expect(api.calls.some((c) => c.path.endsWith("/credentials"))).toBe(false);
  });

  it("reports a site Paradigma added to Bing as verifying, with the import alternative", async () => {
    const api = server(["pending", "verifying"]);
    const t = fakeIo({ fetch: api.fetch, cwd: root });
    await platformCommand("connect", ["bing"], t.io);
    const output = t.stdout();
    expect(output).toContain("Paradigma added the site");
    expect(output).toContain("setup/bing-verify");
    expect(output).toContain("Import from Google Search Console");
    expect(process.exitCode).toBeUndefined();
    const json = fakeIo({ fetch: server(["verifying"]).fetch, cwd: root });
    await platformCommand("connect", ["bing", "--json"], json.io);
    expect(json.stdout()).toContain('"verifying":true');
  });

  it("says what to do in Bing when no property matches", async () => {
    const t = fakeIo({ fetch: server(["no_property"]).fetch, cwd: root });
    const error = await platformCommand("connect", ["bing"], t.io)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionRequired);
    expect((error as Error).message).toContain(
      "Import from Google Search Console",
    );
  });

  it("asks to retry when the consent is declined", async () => {
    const api = server(["declined"]);
    const t = fakeIo({ fetch: api.fetch, cwd: root });
    const error = await platformCommand("connect", ["bing", "--json"], t.io)
      .then(() => null)
      .catch((e: unknown) => e);
    // Non-interactive runs print the URL for the agent; nothing is opened.
    expect(t.opened).toEqual([]);
    if (error) {
      expect(error).toBeInstanceOf(ActionRequired);
      expect((error as Error).message).toContain(
        "Bing access was not approved",
      );
    } else expect(process.exitCode).toBe(3);
  });

  it("falls back to the API key when the server has no Bing OAuth client", async () => {
    vi.stubEnv("BING_KEY", SECRET);
    const api = server([], false);
    const t = fakeIo({
      fetch: api.fetch,
      cwd: root,
      interactive: true,
      answers: [SECRET],
    });
    await platformCommand("connect", ["bing"], t.io);
    const credentials = api.calls.find((c) => c.path.endsWith("/credentials"));
    expect(credentials?.body).toMatchObject({
      provider: "bing",
      apiKey: SECRET,
    });
    expect(t.stdout() + t.stderr()).not.toContain(SECRET);
  });

  it("keeps --key-env and a piped key on the API-key flow", async () => {
    const api = server([]);
    const t = fakeIo({
      fetch: api.fetch,
      cwd: root,
      env: { ...process.env, BING_KEY: SECRET },
    });
    await platformCommand("connect", ["bing", "--key-env", "BING_KEY"], t.io);
    const piped = fakeIo({ fetch: api.fetch, cwd: root, stdin: `${SECRET}\n` });
    await platformCommand("connect", ["bing"], piped.io);
    expect(api.calls.some((c) => c.path.includes("/bing/oauth"))).toBe(false);
    expect(
      api.calls.filter((c) => c.path.endsWith("/credentials")),
    ).toHaveLength(2);
  });
});
