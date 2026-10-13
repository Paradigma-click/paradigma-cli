import { describe, expect, it } from "vitest";
import {
  addedLines,
  checkBudget,
  checkPaths,
  findSecret,
  isForbiddenPath,
  isOutsideRepo,
  matchesGlob,
  redactSecrets,
  runGuards,
} from "./guards";

describe("matchesGlob", () => {
  it.each([
    ["app/page.tsx", "app/*.tsx", true],
    ["app/blog/page.tsx", "app/*.tsx", false],
    ["app/blog/page.tsx", "app/**/*.tsx", true],
    ["app/page.tsx", "app/**/*.tsx", true],
    ["app/page.tsx", "app/**", true],
    ["app/page.tsx", "app/**/page.tsx", true],
    ["app/a/b/page.tsx", "app/**/page.tsx", true],
    ["src/app/(marketing)/page.tsx", "src/app/*/page.tsx", true],
    ["src/app/[slug]/page.tsx", "src/app/*/page.tsx", true],
    ["src/app/blog/[slug]/page.tsx", "src/app/*/page.tsx", false],
    ["application/page.tsx", "app/**", false],
    ["public/robots.txt", "**/robots.txt", true],
    ["robots.txt", "**/robots.txt", true],
    ["src/app/sitemap.ts", "src/app/sitemap.{ts,tsx,js}", true],
    ["src/app/sitemap.jsx", "src/app/sitemap.{ts,tsx,js}", false],
    ["src/app/a/layout.tsx", "src/app/{a,b/c}/layout.tsx", true],
    ["src/app/b/c/layout.tsx", "src/app/{a,b/c}/layout.tsx", true],
    ["img1.png", "img?.png", true],
    ["img10.png", "img?.png", false],
    ["img/1.png", "img?.png", false],
    ["file1.ts", "file[0-9].ts", true],
    ["filea.ts", "file[!0-9].ts", true],
    ["file1.ts", "file[!0-9].ts", false],
    ["app/.well-known/llms.txt", "app/**", true],
    ["a.b", "a?b", true],
    ["axb", "a.b", false],
    ["public/llms.txt", "./public/llms.txt", true],
    ["anything/deep/x", "**", true],
    ["src/(marketing)/page.tsx", "src/(marketing)/*.tsx", true],
    ["src/[slug]/page.tsx", "src/\\[slug\\]/*.tsx", true],
  ])("%s vs %s → %s", (path, glob, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });
});

describe("path guards", () => {
  it("rejects paths that escape the repository", () => {
    for (const path of [
      "../x",
      "a/../../x",
      "/etc/passwd",
      "C:/x",
      "a\\b",
      "",
      "a//b",
    ])
      expect(isOutsideRepo(path)).toBe(true);
    expect(isOutsideRepo("app/page.tsx")).toBe(false);
  });

  it("protects manifests, lockfiles, CI, env and agent config", () => {
    for (const path of [
      "package.json",
      "apps/web/package.json",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lockb",
      ".github/workflows/ci.yml",
      ".env",
      ".env.local",
      "apps/web/.env.production",
      ".gitlab-ci.yml",
      ".circleci/config.yml",
      ".husky/pre-commit",
      ".claude/settings.json",
      "AGENTS.md",
      ".npmrc",
    ])
      expect(isForbiddenPath(path), path).toBe(true);
    for (const path of [
      "app/layout.tsx",
      "public/robots.txt",
      "env.ts",
      "docs/github.md",
    ])
      expect(isForbiddenPath(path), path).toBe(false);
  });

  it("checks outside, forbidden and allowed in that order", () => {
    expect(checkPaths(["app/page.tsx"], ["app/**"])).toEqual({ ok: true });
    expect(checkPaths(["lib/x.ts"], ["app/**"])).toMatchObject({
      ok: false,
      reason: "path_not_allowed",
    });
    expect(checkPaths(["package.json"], ["**"])).toMatchObject({
      ok: false,
      reason: "forbidden_path",
    });
    expect(checkPaths(["../x"], ["**"])).toMatchObject({
      ok: false,
      reason: "path_outside_repo",
    });
  });
});

describe("budget", () => {
  const files = [
    { path: "a", additions: 10, deletions: 5 },
    { path: "b", additions: 3, deletions: 0 },
  ];
  it("enforces file and line limits", () => {
    expect(checkBudget(files, { maxFiles: 2, maxLines: 18 })).toEqual({
      ok: true,
    });
    expect(checkBudget(files, { maxFiles: 1, maxLines: 100 })).toMatchObject({
      reason: "too_many_files",
    });
    expect(checkBudget(files, { maxFiles: 5, maxLines: 17 })).toMatchObject({
      reason: "too_many_lines",
    });
  });
});

describe("secrets", () => {
  const fake = (prefix: string, length: number) =>
    `${prefix}${"a1B2".repeat(length).slice(0, length)}`;
  it.each([
    ["aws_access_key", `const id = "AKIA${"ABCDEFGHIJKLMNOP"}"`],
    ["private_key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["private_key", "-----BEGIN PRIVATE KEY-----"],
    ["github_token", fake("ghp_", 36)],
    ["api_key", fake("sk-", 40)],
    ["api_key", fake("sk-ant-", 40)],
    ["slack_token", fake("xoxb-", 30)],
    ["paradigma_token", fake("pdg_rt_", 43)],
    ["generic_secret", `apiKey: "${fake("", 32)}"`],
  ])("finds %s", (kind, line) => {
    expect(findSecret(["ok", line])).toBe(kind);
  });

  it("ignores ordinary code", () => {
    expect(
      findSecret([
        'export const metadata = { title: "Pricing" };',
        "const token = useToken();",
        "description: 'Plans for teams of every size'",
      ]),
    ).toBeNull();
  });

  it("reads only added lines from a diff", () => {
    const diff = [
      "--- a/x",
      "+++ b/x",
      "@@ -1 +1 @@",
      `-old ${fake("ghp_", 36)}`,
      "+new line",
    ].join("\n");
    expect(addedLines(diff)).toEqual(["new line"]);
    expect(findSecret(addedLines(diff))).toBeNull();
  });

  it("redacts secrets from report text", () => {
    expect(redactSecrets(`token ${fake("ghp_", 36)} leaked`)).toBe(
      "token [redacted] leaked",
    );
  });
});

describe("runGuards", () => {
  const base = {
    allowedPaths: ["app/**"],
    budget: { maxFiles: 3, maxLines: 50 },
  };
  it("passes a clean, in-scope diff", () => {
    expect(
      runGuards({
        ...base,
        files: [{ path: "app/layout.tsx", additions: 2, deletions: 1 }],
        paths: ["app/layout.tsx"],
        diff: "+++ b/app/layout.tsx\n+  title: 'Home',\n",
      }),
    ).toEqual({ ok: true });
  });
  it("fails on the old side of a rename outside scope", () => {
    expect(
      runGuards({
        ...base,
        files: [{ path: "app/x.tsx", additions: 0, deletions: 0 }],
        paths: ["app/x.tsx", "lib/x.tsx"],
        diff: "",
      }),
    ).toMatchObject({ ok: false, reason: "path_not_allowed" });
  });
  it("fails on secrets", () => {
    expect(
      runGuards({
        ...base,
        files: [{ path: "app/x.tsx", additions: 1, deletions: 0 }],
        paths: ["app/x.tsx"],
        diff: "+-----BEGIN OPENSSH PRIVATE KEY-----\n",
      }),
    ).toMatchObject({ ok: false, reason: "secret_detected" });
  });
});
