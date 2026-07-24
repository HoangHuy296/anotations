import "server-only";

import { PreflightError } from "@/lib/providers/provider-errors";
import type { RepositoryProvider, RepositoryProviderAdapter } from "@/lib/providers/provider.types";
import { githubProvider } from "@/lib/providers/github/github.provider";
import { giteaProvider } from "@/lib/providers/gitea/gitea.provider";

const providers: Record<RepositoryProvider, RepositoryProviderAdapter> = {
  GITHUB: githubProvider,
  GITEA: giteaProvider,
};

export function getRepositoryProvider(provider: string): RepositoryProviderAdapter {
  if (provider !== "GITHUB" && provider !== "GITEA") throw new PreflightError("UNSUPPORTED_PROVIDER");
  return providers[provider];
}
