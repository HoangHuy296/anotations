import "server-only";

import { requestProviderJson, encodePath } from "@/lib/providers/provider-fetch";
import { ProviderTransportError } from "@/lib/providers/provider-errors";
import type { RepositoryIdentity, ServerCredentialContext } from "@/lib/providers/provider.types";

type GitHubRepository = { defaultBranch: string; isPrivate: boolean };

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderTransportError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

export async function getGithubRepository(baseUrl: string, repository: RepositoryIdentity): Promise<GitHubRepository> {
  const body = asRecord(await requestProviderJson({ baseUrl, path: `repos/${encodePath(repository.owner, repository.name)}` }));
  if (typeof body.default_branch !== "string" || typeof body.private !== "boolean") throw new ProviderTransportError("INVALID_RESPONSE");
  return { defaultBranch: body.default_branch, isPrivate: body.private };
}

export async function getGithubRevision(baseUrl: string, repository: RepositoryIdentity, ref: string): Promise<string | null> {
  const body = asRecord(await requestProviderJson({ baseUrl, path: `repos/${encodePath(repository.owner, repository.name)}/commits/${encodeURIComponent(ref)}` }));
  return typeof body.sha === "string" && body.sha.length <= 128 ? body.sha : null;
}

export async function githubRootExists(baseUrl: string, repository: RepositoryIdentity, ref: string, rootPath: string): Promise<boolean> {
  const path = rootPath ? `/contents/${rootPath.split("/").map(encodeURIComponent).join("/")}` : "/contents";
  await requestProviderJson({
    baseUrl,
    path: `repos/${encodePath(repository.owner, repository.name)}${path}?ref=${encodeURIComponent(ref)}`,
  });
  return true;
}

/** GitHub credentials are not available in Phase 014. This remains explicit. */
export async function validateGithubToken(input: { credential: ServerCredentialContext | null }) {
  void input;
  return { valid: false as const, reason: "INVALID" as const };
}
