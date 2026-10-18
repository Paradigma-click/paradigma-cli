/**
 * Pure: how a site is published, from file paths and a few small config
 * files. Shared by the CLI (`paradigma doctor deploy`, which also sees the
 * git-ignored link files `.vercel/` and `.netlify/`) and the server (GitHub
 * App tree reads, persisted as `site_apps.deploy_host`). Never executes
 * anything; dependency-free.
 */

export const DEPLOY_HOSTS = [
  "vercel",
  "netlify",
  "cloudflare",
  "github-pages",
  "fly",
  "render",
  "github-actions",
  "docker",
] as const;
export type DeployHost = (typeof DEPLOY_HOSTS)[number];

export const DEPLOY_HOST_LABELS: Record<DeployHost, string> = {
  vercel: "Vercel",
  netlify: "Netlify",
  cloudflare: "Cloudflare",
  "github-pages": "GitHub Pages",
  fly: "Fly.io",
  render: "Render",
  "github-actions": "GitHub Actions",
  docker: "Docker",
};

export function isDeployHost(value: unknown): value is DeployHost {
  return (
    typeof value === "string" &&
    (DEPLOY_HOSTS as readonly string[]).includes(value)
  );
}

/** "Vercel" for a stored id; null for none or an id from a newer detector. */
export function deployHostLabel(
  host: string | null | undefined,
): string | null {
  return isDeployHost(host) ? DEPLOY_HOST_LABELS[host] : null;
}

/** Link files the host CLIs write; git-ignored, so only the CLI sees them. */
const LINK_FILES: [string, DeployHost][] = [
  [".vercel/project.json", "vercel"],
  [".vercel/repo.json", "vercel"],
  [".netlify/state.json", "netlify"],
];

/** Committed host configuration, strongest first. */
const CONFIG_FILES: [string, DeployHost][] = [
  ["vercel.json", "vercel"],
  ["netlify.toml", "netlify"],
  ["wrangler.toml", "cloudflare"],
  ["wrangler.json", "cloudflare"],
  ["wrangler.jsonc", "cloudflare"],
  ["fly.toml", "fly"],
  ["render.yaml", "render"],
];

/** Deploy steps in a GitHub Actions workflow, by host. */
const WORKFLOW_DEPLOYS: [RegExp, DeployHost][] = [
  [
    /\bvercel(?:@[\w.]+)?\s+(?:deploy\b|--prod\b)|amondnet\/vercel-action|BetaHuhn\/deploy-to-vercel-action/,
    "vercel",
  ],
  [
    /\bnetlify(?:-cli)?(?:@[\w.]+)?\s+deploy\b|nwtgck\/actions-netlify|netlify\/actions\//,
    "netlify",
  ],
  [
    /cloudflare\/(?:wrangler-action|pages-action)|\bwrangler(?:@[\w.]+)?\s+(?:pages\s+)?(?:deploy|publish)\b/,
    "cloudflare",
  ],
  [
    /actions\/deploy-pages|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action/,
    "github-pages",
  ],
  [/superfly\/flyctl-actions|\bfly(?:ctl)?\s+deploy\b/, "fly"],
  [/api\.render\.com\/deploy|render-deploy-action/, "render"],
];

const WORKFLOW_DIR = ".github/workflows/";
const MAX_WORKFLOWS = 10;

export interface DeployWorkflow {
  path: string;
  host: DeployHost;
  /** Runs on push, so merges to the default branch ship through it. */
  onPush: boolean;
}

export interface DeployHostDetection {
  host: DeployHost | null;
  /** Repo-relative files that gave it away, strongest first. */
  evidence: string[];
  /** A workflow that deploys to `host` (or decided it), if any. */
  workflow: DeployWorkflow | null;
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

/** The app root, then the repository root (monorepos keep config in either). */
function roots(appRoot: string): string[] {
  return appRoot ? [appRoot, ""] : [""];
}

function isWorkflow(path: string) {
  return (
    path.startsWith(WORKFLOW_DIR) &&
    !path.slice(WORKFLOW_DIR.length).includes("/") &&
    /\.ya?ml$/.test(path)
  );
}

/** Small files whose contents detection reads: the deploy workflows. */
export function deployHostFiles(paths: readonly string[]): string[] {
  return paths.filter(isWorkflow).sort().slice(0, MAX_WORKFLOWS);
}

/** Pure: which host a workflow deploys to, and whether a push triggers it. */
export function workflowDeploy(
  path: string,
  source: string,
): DeployWorkflow | null {
  const match = WORKFLOW_DEPLOYS.find(([pattern]) => pattern.test(source));
  let host = match?.[1] ?? null;
  // A job or workflow named "deploy" that is not one of the known hosts.
  if (
    !host &&
    (/(^|\/)deploy[\w.-]*\.ya?ml$/i.test(path) ||
      /^\s*(?:name:\s*[^\n]*\bdeploy\b|deploy[\w-]*:\s*$)/im.test(source))
  )
    host = "github-actions";
  if (!host) return null;
  return { path, host, onPush: triggersOnPush(source) };
}

/** `on: push`, `on: [push, …]` or a `push:` key under `on:`. */
function triggersOnPush(source: string): boolean {
  if (
    /^["']?on["']?\s*:\s*(?:\[[^\]\n]*\bpush\b[^\]\n]*\]|push\b)/m.test(source)
  )
    return true;
  const block = /^["']?on["']?\s*:\s*\n((?:[ \t]+[^\n]*\n?|\s*\n)+)/m.exec(
    source,
  );
  return Boolean(block && /^[ \t]+push\s*:?/m.test(block[1] ?? ""));
}

/**
 * Detects the host for the app at `appRoot` ("" = repository root). `paths`
 * are repo-relative; `contents` holds the workflows from `deployHostFiles`
 * (missing ones are skipped). Precedence: the app directory before the
 * repository root, and in each a host CLI link file before committed host
 * config; then a deploy workflow, then a Dockerfile.
 */
export function detectDeployHost(input: {
  paths: readonly string[];
  contents?: Readonly<Record<string, string>>;
  appRoot?: string;
}): DeployHostDetection {
  const files = new Set(input.paths);
  const appRoot = input.appRoot ?? "";
  // The app's own directory wins over the repository root.
  const found = roots(appRoot).flatMap((root) =>
    [...LINK_FILES, ...CONFIG_FILES]
      .map(([name, host]) => ({ path: join(root, name), host }))
      .filter(({ path }) => files.has(path)),
  );
  const workflows = deployHostFiles(input.paths)
    .map((path) => {
      const source = input.contents?.[path];
      return source === undefined ? null : workflowDeploy(path, source);
    })
    .filter((item): item is DeployWorkflow => item !== null);

  const configured = found[0]?.host ?? null;
  if (configured) {
    const ofHost = workflows.filter((item) => item.host === configured);
    const workflow = ofHost.find((item) => item.onPush) ?? ofHost[0] ?? null;
    return {
      host: configured,
      evidence: [
        ...new Set(
          found.filter((f) => f.host === configured).map((f) => f.path),
        ),
        ...(workflow ? [workflow.path] : []),
      ],
      workflow,
    };
  }
  // No host config: a known host's deploy on push, any deploy on push, any deploy.
  const workflow =
    workflows.find((item) => item.onPush && item.host !== "github-actions") ??
    workflows.find((item) => item.onPush) ??
    workflows[0] ??
    null;
  if (workflow)
    return { host: workflow.host, evidence: [workflow.path], workflow };
  const dockerfile = roots(appRoot)
    .map((root) => join(root, "Dockerfile"))
    .find((path) => files.has(path));
  return dockerfile
    ? { host: "docker", evidence: [dockerfile], workflow: null }
    : { host: null, evidence: [], workflow: null };
}
