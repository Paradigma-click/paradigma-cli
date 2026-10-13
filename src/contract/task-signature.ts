import { createPublicKey, verify } from "node:crypto";
import type { SignedTask } from "./autopilot";

/**
 * Autopilot tasks are signed by the Paradigma server with Ed25519. The CLI
 * pins the server's raw public key (base64url) at pairing time and only runs
 * tasks whose exact `body` verifies against it.
 */
export function verifySignedTask(task: SignedTask, publicKey: string): boolean {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey },
      format: "jwk",
    });
    return verify(
      null,
      Buffer.from(task.body),
      key,
      Buffer.from(task.signature, "base64url"),
    );
  } catch {
    return false;
  }
}
