import { ActionRequired, type Io, type Reporter } from "./io";
import { type PlatformClient, PlatformError } from "./platform";

/**
 * `paradigma connect bing` with Microsoft OAuth: the server creates the
 * consent, the CLI opens the URL and polls until it is connected. Tokens go
 * from Microsoft to the server only. Returns false when the server has no
 * Bing OAuth client (or predates it): the caller falls back to an API key.
 */

const POLL_MS = 5_000;
const WAIT_MS = 10 * 60 * 1000;

function transient(error: unknown) {
  return (
    error instanceof PlatformError &&
    (error.code === "network" ||
      error.code === "timeout" ||
      (error.status !== undefined && error.status >= 500))
  );
}

/** The account lacked the domain and Paradigma added it: what happens next. */
export const BING_VERIFYING_LINE =
  "Bing: Paradigma added the site to your Bing Webmaster Tools. An agent adds Bing's verification file (setup task setup/bing-verify); Bing connects by itself after the next deploy. Or in Bing Webmaster Tools: Import from Google Search Console.";

const FAILURES: Record<string, string> = {
  no_property:
    "Add the site in Bing Webmaster Tools (https://www.bing.com/webmasters), or use Import from Google Search Console there.",
  declined: "Bing access was not approved.",
  failed: "Bing could not be connected.",
  expired: "The Bing link expired.",
};

export async function runConnectBing(input: {
  io: Io;
  out: Reporter;
  client: PlatformClient;
  projectId: string;
}): Promise<boolean> {
  const { io, out, client, projectId } = input;
  let started: Awaited<ReturnType<PlatformClient["bingOAuthStart"]>>;
  try {
    started = await client.bingOAuthStart(projectId);
  } catch (error) {
    // An older server without the endpoint: keep the API-key flow.
    if (error instanceof PlatformError && error.status === 404) return false;
    throw error;
  }
  if (!started.available) return false;
  const url = started.authorizationUrl;
  out.event("bing", {
    status: "action_required",
    url,
    requestId: started.requestId,
    expiresAt: started.expiresAt,
  });
  out.line(
    "Connect Bing Webmaster Tools (approve in the browser, signed in to Paradigma):",
  );
  out.line(`    ${url}`);
  if (io.interactive && !out.json) io.openUrl(url);
  out.line("Waiting up to 10 min for Bing…");
  const deadline = io.now() + WAIT_MS;
  let last = "pending";
  let told = false;
  while (io.now() < deadline) {
    await io.sleep(POLL_MS);
    try {
      last = (await client.bingOAuthStatus(started.requestId)).status;
    } catch (error) {
      if (!transient(error)) throw error;
      continue;
    }
    if (last === "choose" && !told) {
      told = true;
      out.line("Several Bing properties match: pick one in the browser.");
    }
    if (last === "connected" || last === "verifying" || last in FAILURES) break;
  }
  out.event("bing", { status: last });
  if (last === "connected") {
    out.result({ ok: true, projectId, provider: "bing", connected: true }, () =>
      out.line(
        `✓ Bing connected for project ${projectId}. The first sync runs in the background.`,
      ),
    );
    return true;
  }
  if (last === "verifying") {
    out.result(
      {
        ok: true,
        projectId,
        provider: "bing",
        connected: false,
        verifying: true,
        setupTask: "setup/bing-verify",
      },
      () => out.line(BING_VERIFYING_LINE),
    );
    return true;
  }
  throw new ActionRequired(
    `${FAILURES[last] ?? "Bing is not connected yet."} Run \`paradigma connect bing\` again, or pass --key-env NAME to use an API key.`,
    { url },
  );
}
