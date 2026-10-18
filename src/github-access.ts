import { run } from "./exec";

export interface AppInstallation {
  installationId: number;
  accountId: number;
  accountLogin: string;
}

/**
 * The GitHub page that adds one repository to the Paradigma app. With an
 * installation on the owner's account, GitHub opens that installation with
 * the repository already selected, so the user confirms instead of hunting
 * through settings. GitHub only lets the account owner grant access, so this
 * is as far as an app can go.
 */
export function appAccessUrl(input: {
  installUrl: string | null;
  owner: string;
  installations: readonly AppInstallation[];
  repositoryId: number | null;
}): string | null {
  if (!input.installUrl) return null;
  const installation = input.installations.find(
    (item) => item.accountLogin.toLowerCase() === input.owner.toLowerCase(),
  );
  if (!installation) return input.installUrl;
  const url = new URL(`${input.installUrl.replace(/\/$/, "")}/permissions`);
  url.searchParams.set("suggested_target_id", String(installation.accountId));
  if (input.repositoryId !== null)
    url.searchParams.append("repository_ids[]", String(input.repositoryId));
  return url.toString();
}

/** The repository's GitHub id through the GitHub CLI, when it is signed in. */
export async function githubRepositoryId(
  fullName: string,
  cwd: string,
): Promise<number | null> {
  const result = await run("gh", ["api", `repos/${fullName}`, "--jq", ".id"], {
    cwd,
    timeoutMs: 10_000,
  });
  const id = Number(result.stdout.trim());
  return result.code === 0 && Number.isSafeInteger(id) && id > 0 ? id : null;
}
