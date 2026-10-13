import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { run } from "./exec";
import { originFullName } from "./git";

/**
 * Local, read-only inference for `paradigma init`: which repository and app
 * this is, and candidate production URLs and brand names. Only the extracted
 * values are used; file contents are never sent anywhere or stored.
 */

export type Candidate = { value: string; source: string };

export type SiteCandidates = {
  urls: Candidate[];
  brands: Candidate[];
  descriptions: Candidate[];
};

const MAX_FILE_BYTES = 256 * 1024;

function readSmall(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  const text = readSmall(path);
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function gitTopLevel(dir: string): Promise<string | null> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    timeoutMs: 10_000,
  });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

export type DetectedRepo = {
  root: string;
  fullName: string;
  /** Path of the working directory inside the repository (posix, "" at root). */
  relativeDir: string;
};

export async function detectRepo(dir: string): Promise<DetectedRepo | null> {
  const root = await gitTopLevel(dir);
  if (!root) return null;
  const fullName = await originFullName(root);
  if (!fullName) return null;
  const rel = relative(root, dir).split(sep).join("/");
  return {
    root,
    fullName,
    relativeDir: rel.startsWith("..") ? "" : rel,
  };
}

/**
 * The app root that contains the working directory (longest match), or the
 * only app. Null when the choice is ambiguous.
 */
export function chooseAppRoot(
  appRoots: readonly string[],
  relativeDir: string,
): string | null {
  const matches = appRoots
    .filter(
      (root) =>
        root === "" ||
        relativeDir === root ||
        relativeDir.startsWith(`${root}/`),
    )
    .sort((a, b) => b.length - a.length);
  if (matches.length) return matches[0];
  return appRoots.length === 1 ? appRoots[0] : null;
}

const URL_DENYLIST =
  /(^|\.)(github\.com|githubusercontent\.com|shields\.io|npmjs\.(com|org)|vercel\.com|nextjs\.org|localhost|example\.(com|org|net)|twitter\.com|x\.com|linkedin\.com|discord\.(gg|com)|youtube\.com|youtu\.be|google\.com|badgen\.net|codecov\.io|opensource\.org|reactjs\.org|react\.dev|tailwindcss\.com|vercel\.app)$/i;

/** HTTPS origin of a public-looking URL, or null. */
export function productionOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (!/\./.test(url.hostname) || /^[\d.]+$/.test(url.hostname)) return null;
  return url.origin;
}

function addUrl(
  list: Candidate[],
  raw: string,
  source: string,
  allowAny = false,
) {
  const origin = productionOrigin(raw);
  if (!origin) return;
  const host = new URL(origin).hostname;
  if (!allowAny && URL_DENYLIST.test(host)) return;
  if (!list.some((candidate) => candidate.value === origin))
    list.push({ value: origin, source });
}

function addText(list: Candidate[], raw: string, source: string, max: number) {
  const value = raw
    .replace(/[`*_[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value || value.length > max || /[,=\r\n]/.test(value)) return;
  if (!list.some((c) => c.value.toLowerCase() === value.toLowerCase()))
    list.push({ value, source });
}

const GENERIC_PACKAGE_NAMES = new Set([
  "web",
  "app",
  "site",
  "www",
  "frontend",
  "client",
  "website",
  "landing",
  "docs",
  "next-app",
  "my-app",
  "nextjs",
  "next",
  "ui",
  "marketing",
]);

/** "acme-cloud" → "Acme Cloud"; generic names fall back to the scope. */
export function brandFromPackageName(name: string): string | null {
  const match = /^(?:@([^/]+)\/)?(.+)$/.exec(name.trim());
  if (!match) return null;
  const [, scope, base] = match;
  const pick = GENERIC_PACKAGE_NAMES.has(base.toLowerCase()) ? scope : base;
  if (!pick) return null;
  return pick
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function stringLiteral(source: string, key: string): string | null {
  const match = new RegExp(
    `\\b${key}\\s*:\\s*(["'\`])([^"'\`$\\n]{1,200})\\1`,
  ).exec(source);
  return match ? match[2] : null;
}

/** Values from a Next.js root layout's `metadata` export, read as text. */
export function layoutMetadata(source: string) {
  const out: {
    metadataBase?: string;
    title?: string;
    siteName?: string;
    description?: string;
  } = {};
  const base = /metadataBase\s*:[^\n]{0,300}/.exec(source)?.[0];
  if (base) {
    const url = /(["'`])(https:\/\/[^"'`\s$]+)\1/.exec(base);
    if (url) out.metadataBase = url[2];
  }
  const titleObject = /\btitle\s*:\s*\{([^}]{0,500})\}/.exec(source)?.[1];
  const title =
    (titleObject && stringLiteral(titleObject, "default")) ??
    stringLiteral(source, "title");
  if (title) out.title = title.replace(/\s+[|–—-]\s+.*$/, "").trim() || title;
  const siteName = stringLiteral(source, "siteName");
  if (siteName) out.siteName = siteName;
  const description = stringLiteral(source, "description");
  if (description) out.description = description;
  return out;
}

const SITE_URL_KEYS =
  /^(?:NEXT_PUBLIC_)?(?:SITE_URL|APP_URL|BASE_URL|URL|PRODUCTION_URL|WEBSITE_URL|DOMAIN)\s*=\s*["']?(https:\/\/[^\s"'#]+)/gm;

/** Candidate production URLs, brands and descriptions for an app directory. */
export function inferSiteCandidates(
  repoRoot: string,
  appRoot: string,
): SiteCandidates {
  const appDir = appRoot ? join(repoRoot, appRoot) : repoRoot;
  const dirs = appDir === repoRoot ? [repoRoot] : [appDir, repoRoot];
  const urls: Candidate[] = [];
  const brands: Candidate[] = [];
  const descriptions: Candidate[] = [];

  for (const base of [join(appDir, "app"), join(appDir, "src", "app")])
    for (const ext of ["tsx", "ts", "jsx", "js"]) {
      const source = readSmall(join(base, `layout.${ext}`));
      if (!source) continue;
      const meta = layoutMetadata(source);
      if (meta.metadataBase)
        addUrl(urls, meta.metadataBase, "metadataBase in app/layout", true);
      if (meta.siteName)
        addText(brands, meta.siteName, "openGraph.siteName", 80);
      if (meta.title) addText(brands, meta.title, "metadata title", 80);
      if (meta.description)
        addText(descriptions, meta.description, "metadata description", 300);
    }

  for (const dir of dirs) {
    const vercel = readJsonFile(join(dir, "vercel.json"));
    const alias = vercel?.alias;
    for (const value of Array.isArray(alias) ? alias : alias ? [alias] : [])
      if (typeof value === "string")
        addUrl(
          urls,
          value.includes("://") ? value : `https://${value}`,
          "vercel.json alias",
          true,
        );
  }

  for (const dir of dirs)
    for (const file of [".env.example", ".env.sample"]) {
      const text = readSmall(join(dir, file));
      if (!text) continue;
      for (const match of text.matchAll(SITE_URL_KEYS))
        addUrl(urls, match[1], file);
    }

  for (const dir of [join(appDir, "public"), join(repoRoot, "public")]) {
    const cname = readSmall(join(dir, "CNAME"))?.trim();
    if (cname && /^[a-z0-9.-]+$/i.test(cname))
      addUrl(urls, `https://${cname}`, "public/CNAME", true);
  }

  for (const dir of dirs) {
    const pkg = readJsonFile(join(dir, "package.json"));
    if (!pkg) continue;
    if (typeof pkg.homepage === "string")
      addUrl(urls, pkg.homepage, "package.json homepage");
    if (typeof pkg.name === "string") {
      const brand = brandFromPackageName(pkg.name);
      if (brand) addText(brands, brand, "package.json name", 80);
    }
    if (typeof pkg.description === "string")
      addText(descriptions, pkg.description, "package.json description", 300);
  }

  for (const dir of dirs) {
    const readme = readSmall(join(dir, "README.md"));
    if (!readme) continue;
    const heading = /^#\s+(.+)$/m.exec(readme)?.[1];
    if (heading && !/!\[/.test(heading))
      addText(
        brands,
        heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
        "README heading",
        80,
      );
    for (const match of readme.matchAll(/https:\/\/[^\s)"'<>\]]+/g)) {
      if (urls.filter((c) => c.source === "README").length >= 3) break;
      addUrl(urls, match[0], "README");
    }
  }

  for (const dir of dirs) {
    const project = readJsonFile(join(dir, ".vercel", "project.json"));
    const name = project?.projectName;
    if (typeof name === "string" && /^[a-z0-9-]{1,100}$/.test(name))
      addUrl(urls, `https://${name}.vercel.app`, ".vercel/project.json", true);
  }

  return { urls, brands, descriptions };
}
