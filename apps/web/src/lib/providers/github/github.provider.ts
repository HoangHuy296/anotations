import "server-only";

import { PreflightError } from "@/lib/providers/provider-errors";
import type { DownloadFileInput, ListFilesInput, PreflightInput, PreflightResult, RepositoryProviderAdapter, ResolveRefInput, ResolvedRef } from "@/lib/providers/provider.types";
import { getGithubRepository, getGithubRevision, githubRootExists, validateGithubToken } from "@/lib/providers/github/github.client";
import { mapGithubFailure } from "@/lib/providers/github/github.mapper";

export const githubProvider: RepositoryProviderAdapter = {
  async preflight(input: PreflightInput): Promise<PreflightResult> {
    let repository;
    try {
      repository = await getGithubRepository(input.baseUrl, input.repository);
    } catch (error) {
      throw mapGithubFailure(error, "repository");
    }
    if (repository.isPrivate) throw new PreflightError("REPOSITORY_ACCESS_DENIED");
    const ref = await this.resolveRef({ ...input, requestedRef: input.ref });
    if (input.rootPath) {
      try {
        await githubRootExists(input.baseUrl, input.repository, ref.resolved, input.rootPath);
      } catch (error) {
        throw mapGithubFailure(error, "root");
      }
    }
    return {
      provider: "GITHUB",
      repository: input.repository,
      visibility: repository.isPrivate ? "PRIVATE" : "PUBLIC",
      ref,
      rootPath: { requested: input.rootPath, normalized: input.rootPath, exists: true },
      assetPreview: null,
    };
  },
  async resolveRef(input: ResolveRefInput): Promise<ResolvedRef> {
    let repository;
    try {
      repository = await getGithubRepository(input.baseUrl, input.repository);
    } catch (error) {
      throw mapGithubFailure(error, "repository");
    }
    const resolved = input.requestedRef ?? repository.defaultBranch;
    try {
      const revision = await getGithubRevision(input.baseUrl, input.repository, resolved);
      if (!revision) throw new PreflightError("PROVIDER_UNAVAILABLE");
      return { requested: input.requestedRef, resolved, revision };
    } catch (error) {
      throw mapGithubFailure(error, "ref");
    }
  },
  async listFiles(input: ListFilesInput) {
    if (input.limit < 1) return [];
    try {
      const exists = await githubRootExists(input.baseUrl, input.repository, input.ref, input.rootPath);
      return exists ? [{ path: input.rootPath, kind: "DIRECTORY" as const }] : [];
    } catch (error) {
      throw mapGithubFailure(error, "root");
    }
  },
  async downloadFile(input: DownloadFileInput) {
    void input;
    throw new PreflightError("PROVIDER_UNAVAILABLE");
  },
  validateToken: validateGithubToken,
};
