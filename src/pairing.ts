import { arch, platform } from "node:os";
import { ApiClient, ApiError } from "./api";
import { RUNNER_TOKEN_PREFIX } from "./contract/autopilot";
import type { Io } from "./io";
import { VERSION } from "./version";

export type PairedCredentials = {
  runnerId: string;
  runnerToken: string;
  publicKey: string;
};

/**
 * Device pairing: shows a code, opens the browser and polls until the person
 * approves. Used by `setup`, and by `init` when no setup token is given.
 */
export async function pairDevice(input: {
  server: string;
  name: string;
  io: Pick<Io, "openUrl" | "sleep" | "now">;
  /** Human lines (the code and URL must reach the person even in --json). */
  say: (line: string) => void;
}): Promise<PairedCredentials> {
  const anonymous = new ApiClient({
    server: input.server,
    userAgent: `paradigma-cli/${VERSION}`,
  });
  const start = await anonymous.pairStart(
    input.name,
    `${platform()}-${arch()}`,
  );
  input.say(`Open ${start.verificationUrl} and confirm the code:`);
  input.say("");
  input.say(`    ${start.userCode}`);
  input.say("");
  input.io.openUrl(start.verificationUrl);
  input.say("Waiting for approval…");

  const deadline = input.io.now() + start.expiresInSeconds * 1000;
  let approved: PairedCredentials | undefined;
  while (input.io.now() < deadline) {
    await input.io.sleep(start.intervalSeconds * 1000);
    let poll: Awaited<ReturnType<ApiClient["pairPoll"]>>;
    try {
      poll = await anonymous.pairPoll(start.deviceCode);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code !== "network" &&
        error.code !== "timeout"
      )
        throw error;
      continue;
    }
    if (poll.status === "pending") continue;
    if (poll.status === "denied") throw new Error("Pairing was denied.");
    if (poll.status === "expired")
      throw new Error("The pairing code expired. Run setup again.");
    approved = poll;
    break;
  }
  if (!approved) throw new Error("The pairing code expired. Run setup again.");
  if (!approved.runnerToken.startsWith(RUNNER_TOKEN_PREFIX))
    throw new Error("The server returned an unexpected token format.");

  try {
    const current = await anonymous.publicKey();
    if (current.publicKey !== approved.publicKey)
      throw new Error(
        "The signing key from pairing does not match the server's public key. Aborting.",
      );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    input.say(`! Could not cross-check the public key: ${error.message}`);
  }
  return approved;
}
