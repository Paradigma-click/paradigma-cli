import {
  type SignedTask,
  type TaskPayload,
  taskPayloadSchema,
} from "./contract/autopilot";
import { verifySignedTask } from "./contract/task-signature";

export type VerifyResult =
  | { ok: true; payload: TaskPayload }
  | {
      ok: false;
      reason: "bad_signature" | "invalid_payload" | "wrong_runner" | "expired";
      /** Only set once the signature verified, so it can be trusted. */
      payload?: TaskPayload;
    };

/**
 * Checks the Ed25519 signature against the key pinned at pairing BEFORE
 * parsing, then the payload shape, the runner id and the expiry.
 */
export function verifyTask(
  task: SignedTask,
  expected: { publicKey: string; runnerId: string; now?: Date },
): VerifyResult {
  if (!verifySignedTask(task, expected.publicKey))
    return { ok: false, reason: "bad_signature" };
  let raw: unknown;
  try {
    raw = JSON.parse(task.body);
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }
  const parsed = taskPayloadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid_payload" };
  const payload = parsed.data;
  if (payload.runnerId !== expected.runnerId)
    return { ok: false, reason: "wrong_runner" };
  const now = expected.now ?? new Date();
  if (Date.parse(payload.expiresAt) <= now.getTime())
    return { ok: false, reason: "expired", payload };
  return { ok: true, payload };
}
