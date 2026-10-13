import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const AGENT_NAMES = ["claude", "codex", "cursor", "custom"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const DEFAULT_SERVER = "https://paradigma.click";

const configSchema = z.object({
  server: z.string().default(DEFAULT_SERVER),
  runnerId: z.string().optional(),
  token: z.string().optional(),
  /** Ed25519 key (base64url) pinned at pairing; every task must verify. */
  publicKey: z.string().optional(),
  /** Server repository id → absolute local clone path. */
  repos: z.record(z.string(), z.string()).default({}),
  /** Display names for mapped repositories (owner/name), for status output. */
  repoNames: z.record(z.string(), z.string()).default({}),
  agent: z.enum(AGENT_NAMES).optional(),
  /** Per repository id: shell commands that replace detected checks. */
  checks: z.record(z.string(), z.array(z.string())).default({}),
  paused: z.boolean().default(false),
  schedule: z
    .object({
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .optional(),
  lastRunAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  /** Project chosen by `init`, used when a command gets no --project. */
  defaultProjectId: z.string().optional(),
});
export type Config = z.infer<typeof configSchema>;

export function paradigmaHome(): string {
  return process.env.PARADIGMA_HOME || join(homedir(), ".paradigma");
}

export function homePath(...parts: string[]) {
  return join(paradigmaHome(), ...parts);
}

/** Creates a private directory (0700) under the Paradigma home. */
export function ensurePrivateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

export function configPath() {
  return homePath("config.json");
}

export function loadConfig(): Config {
  const file = configPath();
  if (!existsSync(file)) return configSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON. Fix or delete it.`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`${file} has an invalid shape. Fix or delete it.`);
  return parsed.data;
}

/** Writes atomically with mode 0600; the home directory is kept at 0700. */
export async function saveConfig(config: Config) {
  ensurePrivateDir(paradigmaHome());
  const file = configPath();
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temp, 0o600);
  await rename(temp, file);
  chmodSync(file, 0o600);
}

export async function updateConfig(change: (config: Config) => void) {
  const config = loadConfig();
  change(config);
  await saveConfig(config);
  return config;
}

export type PairedConfig = Config & {
  runnerId: string;
  token: string;
  publicKey: string;
};

export function isPaired(config: Config): config is PairedConfig {
  return Boolean(config.runnerId && config.token && config.publicKey);
}

/** Platform commands need only the CLI credential (no pinned key). */
export function requireToken(config: Config): Config & { token: string } {
  if (!config.token)
    throw new Error(
      "Not signed in. Run `npx paradigma-cli init` (or `paradigma setup`) first.",
    );
  return config as Config & { token: string };
}

export function requirePaired(config: Config): PairedConfig {
  if (!isPaired(config))
    throw new Error("This machine is not paired. Run `paradigma setup` first.");
  return config;
}
