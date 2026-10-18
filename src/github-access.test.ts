import { describe, expect, it } from "vitest";
import { appAccessUrl } from "./github-access";

const installUrl = "https://github.com/apps/paradigma-click/installations/new";
const installations = [
  { installationId: 171069043, accountId: 123134059, accountLogin: "alifoo" },
];

describe("appAccessUrl", () => {
  it("pre-selects the repository on the owner's existing installation", () => {
    const url = new URL(
      appAccessUrl({
        installUrl,
        owner: "Alifoo",
        installations,
        repositoryId: 1291805823,
      }) ?? "",
    );
    expect(url.pathname).toBe(
      "/apps/paradigma-click/installations/new/permissions",
    );
    expect(url.searchParams.get("suggested_target_id")).toBe("123134059");
    expect(url.searchParams.getAll("repository_ids[]")).toEqual(["1291805823"]);
  });

  it("still targets the account when the repository id is unknown", () => {
    const url = new URL(
      appAccessUrl({
        installUrl,
        owner: "alifoo",
        installations,
        repositoryId: null,
      }) ?? "",
    );
    expect(url.searchParams.get("suggested_target_id")).toBe("123134059");
    expect(url.searchParams.has("repository_ids[]")).toBe(false);
  });

  it("falls back to a fresh install when the account has none", () => {
    expect(
      appAccessUrl({
        installUrl,
        owner: "acme",
        installations,
        repositoryId: 1,
      }),
    ).toBe(installUrl);
    expect(
      appAccessUrl({
        installUrl: null,
        owner: "acme",
        installations,
        repositoryId: 1,
      }),
    ).toBeNull();
  });
});
