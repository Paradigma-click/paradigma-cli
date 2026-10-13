import { z } from "zod";

/**
 * Wire contract for `paradigma init --token …`. Shared with the CLI, so keep
 * it dependency-free apart from zod.
 */

/** Canonical prefix for one-time setup tokens, so leaks are recognizable. */
export const SETUP_TOKEN_PREFIX = "pdg_setup_";
export const SETUP_TOKEN_TTL_SECONDS = 30 * 60;

/** Prefix plus 32 random bytes in base64url (43 characters). */
export function isSetupTokenShape(value: string): boolean {
  return /^pdg_setup_[A-Za-z0-9_-]{43}$/.test(value);
}

export const setupExchangeRequestSchema = z.object({
  token: z.string().min(1).max(200),
  /** Shown in Autopilot's runner list, e.g. "Claude Code on studio-mac". */
  runnerName: z.string().trim().min(1).max(100),
  platform: z.string().trim().min(1).max(40).optional(),
  agents: z
    .array(
      z.object({
        name: z.string().max(40),
        version: z.string().max(80).nullable(),
      }),
    )
    .max(5)
    .default([]),
  cliVersion: z.string().max(40).optional(),
});
export type SetupExchangeRequest = z.infer<typeof setupExchangeRequestSchema>;

export const setupExchangeResponseSchema = z.object({
  runnerId: z.uuid(),
  /** Bearer credential for the CLI; acts as the user who made the token. */
  runnerToken: z.string().min(32),
  /** Ed25519 public key (base64url, raw 32 bytes) that signs Autopilot tasks. */
  publicKey: z.string().min(40).max(60),
  /** Server origin the CLI should keep talking to. */
  server: z.url(),
});
export type SetupExchangeResponse = z.infer<typeof setupExchangeResponseSchema>;
