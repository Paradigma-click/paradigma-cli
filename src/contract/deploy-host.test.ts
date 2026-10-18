import { describe, expect, it } from "vitest";
import {
  deployHostFiles,
  deployHostLabel,
  detectDeployHost,
  workflowDeploy,
} from "./deploy-host";

const PAGES_WORKFLOW = `name: Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/deploy-pages@v4
`;

const VERCEL_WORKFLOW = `on: [push]
jobs:
  ship:
    steps:
      - run: npx vercel deploy --prod --token=\${{ secrets.VERCEL_TOKEN }}
`;

describe("detectDeployHost", () => {
  it("finds nothing in a bare repository", () => {
    expect(
      detectDeployHost({ paths: ["package.json", "app/page.tsx"] }),
    ).toEqual({ host: null, evidence: [], workflow: null });
  });

  it("reads committed host config at the app root or the repo root", () => {
    expect(detectDeployHost({ paths: ["vercel.json"] })).toMatchObject({
      host: "vercel",
      evidence: ["vercel.json"],
    });
    expect(
      detectDeployHost({
        paths: ["apps/web/netlify.toml", "apps/web/package.json"],
        appRoot: "apps/web",
      }),
    ).toMatchObject({ host: "netlify", evidence: ["apps/web/netlify.toml"] });
    expect(
      detectDeployHost({ paths: ["wrangler.jsonc"], appRoot: "site" }),
    ).toMatchObject({ host: "cloudflare", evidence: ["wrangler.jsonc"] });
    expect(
      detectDeployHost({ paths: ["fly.toml", "Dockerfile"] }),
    ).toMatchObject({ host: "fly", evidence: ["fly.toml"] });
    expect(detectDeployHost({ paths: ["render.yaml"] }).host).toBe("render");
  });

  it("prefers the app's own directory over the repository root", () => {
    const paths = ["vercel.json", "apps/docs/netlify.toml"];
    expect(detectDeployHost({ paths, appRoot: "apps/docs" }).host).toBe(
      "netlify",
    );
    expect(detectDeployHost({ paths }).host).toBe("vercel");
    expect(detectDeployHost({ paths, appRoot: "apps/web" }).host).toBe(
      "vercel",
    );
  });

  it("prefers the host CLI link file the CLI sees locally", () => {
    expect(
      detectDeployHost({
        paths: [".vercel/project.json", "vercel.json", "netlify.toml"],
      }),
    ).toMatchObject({
      host: "vercel",
      evidence: [".vercel/project.json", "vercel.json"],
    });
    expect(detectDeployHost({ paths: [".netlify/state.json"] }).host).toBe(
      "netlify",
    );
  });

  it("uses deploy workflows when no host config exists", () => {
    const path = ".github/workflows/pages.yml";
    expect(
      detectDeployHost({
        paths: [path, ".github/workflows/ci.yml"],
        contents: {
          [path]: PAGES_WORKFLOW,
          ".github/workflows/ci.yml": "on: pull_request\n",
        },
      }),
    ).toEqual({
      host: "github-pages",
      evidence: [path],
      workflow: { path, host: "github-pages", onPush: true },
    });
  });

  it("attaches a workflow that deploys to the configured host", () => {
    const path = ".github/workflows/deploy.yml";
    const result = detectDeployHost({
      paths: ["vercel.json", path],
      contents: { [path]: VERCEL_WORKFLOW },
    });
    expect(result).toEqual({
      host: "vercel",
      evidence: ["vercel.json", path],
      workflow: { path, host: "vercel", onPush: true },
    });
    // A workflow for another host does not count for this one.
    expect(
      detectDeployHost({
        paths: ["vercel.json", path],
        contents: { [path]: PAGES_WORKFLOW },
      }).workflow,
    ).toBeNull();
  });

  it("falls back to a Dockerfile", () => {
    expect(detectDeployHost({ paths: ["Dockerfile"] })).toMatchObject({
      host: "docker",
      evidence: ["Dockerfile"],
    });
  });
});

describe("workflowDeploy", () => {
  it("recognizes hosts and push triggers", () => {
    const at = ".github/workflows/x.yml";
    expect(
      workflowDeploy(
        at,
        "on: push\nsteps:\n  - uses: cloudflare/wrangler-action@v3\n",
      ),
    ).toEqual({
      path: at,
      host: "cloudflare",
      onPush: true,
    });
    expect(
      workflowDeploy(
        at,
        "on:\n  workflow_dispatch:\nsteps:\n  - run: flyctl deploy --remote-only\n",
      ),
    ).toEqual({
      path: at,
      host: "fly",
      onPush: false,
    });
    expect(
      workflowDeploy(
        at,
        "on:\n  push:\n    branches: [main]\njobs:\n  netlify:\n    steps:\n      - run: netlify deploy --prod\n",
      )?.host,
    ).toBe("netlify");
    expect(
      workflowDeploy(
        ".github/workflows/deploy.yml",
        "on: push\njobs:\n  rsync: {}\n",
      ),
    ).toEqual({
      path: ".github/workflows/deploy.yml",
      host: "github-actions",
      onPush: true,
    });
    expect(
      workflowDeploy(at, "on: pull_request\njobs:\n  test: {}\n"),
    ).toBeNull();
  });

  it("reads only top-level workflow files, capped", () => {
    const paths = [
      ".github/workflows/a.yml",
      ".github/workflows/b.yaml",
      ".github/workflows/nested/c.yml",
      ".github/workflows/readme.md",
      ...Array.from({ length: 12 }, (_, i) => `.github/workflows/w${i}.yml`),
    ];
    const files = deployHostFiles(paths);
    expect(files).toHaveLength(10);
    expect(files).not.toContain(".github/workflows/nested/c.yml");
    expect(files).not.toContain(".github/workflows/readme.md");
  });
});

it("labels stored host ids", () => {
  expect(deployHostLabel("vercel")).toBe("Vercel");
  expect(deployHostLabel("github-pages")).toBe("GitHub Pages");
  expect(deployHostLabel("someday-host")).toBeNull();
  expect(deployHostLabel(null)).toBeNull();
});
