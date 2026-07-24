import "server-only";

import { PreflightError } from "@/lib/providers/provider-errors";
import type { DownloadFileInput, ListFilesInput, PreflightInput, PreflightResult, RepositoryProviderAdapter, ResolveRefInput, ResolvedRef } from "@/lib/providers/provider.types";
import { getGiteaAssetPreview, getGiteaRepository, getGiteaRevision, giteaRootExists, validateGiteaToken } from "@/lib/providers/gitea/gitea.client";
import { mapGiteaFailure } from "@/lib/providers/gitea/gitea.mapper";

async function resolveRef(input: ResolveRefInput): Promise<ResolvedRef> {
  let repository;
  try {
    repository = await getGiteaRepository(input.baseUrl, input.repository, input.credential);
  } catch (error) {
    throw mapGiteaFailure(error, "repository", Boolean(input.credential));
  }
  const resolved = input.requestedRef ?? repository.defaultBranch;
  try {
    const revision = await getGiteaRevision(input.baseUrl, input.repository, resolved, input.credential);
    if (!revision) throw new PreflightError("PROVIDER_UNAVAILABLE");
    return { requested: input.requestedRef, resolved, revision };
  } catch (error) {
    throw mapGiteaFailure(error, "ref", Boolean(input.credential));
  }
}

export const giteaProvider: RepositoryProviderAdapter = {
  async preflight(input: PreflightInput): Promise<PreflightResult> {
    let repository;
    try {
      repository = await getGiteaRepository(input.baseUrl, input.repository, input.credential);
    } catch (error) {
      throw mapGiteaFailure(error, "repository", Boolean(input.credential));
    }
    if (repository.isPrivate && !input.credential) throw new PreflightError("REPOSITORY_ACCESS_DENIED");
    const ref = await resolveRef({ ...input, requestedRef: input.ref });
    if (input.rootPath) {
      try {
        await giteaRootExists(input.baseUrl, input.repository, ref.resolved, input.rootPath, input.credential);
      } catch (error) {
        throw mapGiteaFailure(error, "root", Boolean(input.credential));
      }
    }
    let assetPreview;
    try {
      assetPreview = await getGiteaAssetPreview(input.baseUrl, input.repository, ref.resolved, input.rootPath, input.credential);
    } catch (error) {
      throw mapGiteaFailure(error, "root", Boolean(input.credential));
    }
    return {
      provider: "GITEA",
      repository: input.repository,
      visibility: repository.isPrivate ? "PRIVATE" : "PUBLIC",
      ref,
      rootPath: { requested: input.rootPath, normalized: input.rootPath, exists: true },
      assetPreview,
    };
  },
  resolveRef,
  async listFiles(input: ListFilesInput) {
    if (input.limit < 1) return [];
    try {
      const exists = await giteaRootExists(input.baseUrl, input.repository, input.ref, input.rootPath, input.credential);
      return exists ? [{ path: input.rootPath, kind: "DIRECTORY" as const }] : [];
    } catch (error) {
      throw mapGiteaFailure(error, "root", Boolean(input.credential));
    }
  },
  async downloadFile(input: DownloadFileInput) {
    void input;
    throw new PreflightError("PROVIDER_UNAVAILABLE");
  },
  validateToken: async (input) => validateGiteaToken(input.baseUrl, input.credential),
};
