import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import type { SignedTask, TaskPayload } from "../contract/autopilot";

/**
 * Test stand-in for the Paradigma server's task signer: a throwaway Ed25519
 * key pair, so tests exercise the same verification path the CLI uses.
 */
let current: { privateKey: KeyObject; publicKey: string } | undefined;

function keys() {
  if (current) return current;
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  current = { privateKey: pair.privateKey, publicKey: String(jwk.x) };
  return current;
}

/** Raw Ed25519 public key, base64url, as the server hands it out at pairing. */
export function testPublicKey(): string {
  return keys().publicKey;
}

export function signTask(payload: TaskPayload): SignedTask {
  const body = JSON.stringify(payload);
  return {
    body,
    signature: sign(null, Buffer.from(body), keys().privateKey).toString(
      "base64url",
    ),
  };
}

/** Switches to a fresh key pair; earlier signatures no longer verify. */
export function rotateTestSigningKey() {
  current = undefined;
}
