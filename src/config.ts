import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_SERVER = "https://paradigma.click";

/**
 * The CLI's settings. Loose on purpose: keys this version does not know are kept as they are when
 * it saves, so older and newer versions can share the file.
 */
export const configSchema = z.looseObject({
  server: z.string().default(DEFAULT_SERVER),
  /** Id of the CLI credential (from `init` or device pairing). */
  runnerId: z.string().optional(),
  token: z.string().optional(),
  /** Ed25519 key (base64url) pinned at sign-in. */
  publicKey: z.string().optional(),
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

/** Reads the config file with `schema` (defaults when the file does not exist). */
export function readConfigFile<T>(schema: z.ZodType<T>): T {
  const file = configPath();
  if (!existsSync(file)) return schema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON. Fix or delete it.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`${file} has an invalid shape. Fix or delete it.`);
  return parsed.data;
}

export function loadConfig(): Config {
  return readConfigFile(configSchema);
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

/** Platform commands need only the CLI credential (no pinned key). */
export function requireToken<C extends Config>(
  config: C,
): C & { token: string } {
  if (!config.token)
    throw new Error("Not signed in. Run `npx paradigma-cli init` first.");
  return config as C & { token: string };
}
