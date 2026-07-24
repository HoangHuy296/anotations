import "server-only";

import type { RequestActor } from "@/lib/auth";
import { PreflightError } from "@/lib/providers/provider-errors";
import { getRepositoryProvider } from "@/lib/providers/provider-registry";
import { resolvePreflightGiteaCredential } from "@/lib/providers/token-check";
import type { PreflightInput, PreflightResult } from "@/lib/providers/provider.types";
import type { RepositoryPreflightRequest } from "@/lib/validation/repository-preflight";
import { normalizeSourceRootPath, validateSourceBaseUrl } from "@/lib/source-access-policy";

function canonicalBaseUrl(url: URL) {
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

async function safeBaseUrl(raw: string) {
  const validated = await validateSourceBaseUrl(raw);
  if (!validated.ok) throw new PreflightError("UNSAFE_REPOSITORY_URL");
  return canonicalBaseUrl(validated.value);
}

function githubBaseUrl() {
  // Deployment configuration controls a test fixture override; the browser
  // cannot provide a GitHub base URL in a preflight request. Bracket access
  // intentionally keeps this server-only setting runtime-configurable in a
  // standalone Next.js build instead of baking a local fixture into it.
  return process.env["GITHUB_API_BASE_URL"] || "https://api.github.com";
}

/**
 * The only Phase-014 coordination boundary. It does no persistence, enqueue,
 * storage work, clone, or download. Inputs are already strict-Zod validated.
 */
export async function preflightRepository(
  actor: RequestActor,
  request: RepositoryPreflightRequest,
): Promise<PreflightResult> {
  const rootPath = request.rootPath === undefined
    ? null
    : (() => {
      const normalized = normalizeSourceRootPath(request.rootPath);
      if (!normalized.ok) throw new PreflightError("UNSAFE_REPOSITORY_URL");
      return normalized.value || null;
    })();

  let credential = null;
  let baseUrl: string;
  if (request.provider === "GITEA") {
    credential = request.sourceConnectionId
      ? await resolvePreflightGiteaCredential(actor, request.sourceConnectionId)
      : null;
    if (credential && request.repository.baseUrl) {
      const requestedBaseUrl = await safeBaseUrl(request.repository.baseUrl);
      if (requestedBaseUrl !== credential.baseUrl) throw new PreflightError("REPOSITORY_ACCESS_DENIED");
    }
    baseUrl = credential?.baseUrl ?? await safeBaseUrl(request.repository.baseUrl!);
  } else {
    baseUrl = await safeBaseUrl(githubBaseUrl());
  }

  const input: PreflightInput = {
    provider: request.provider,
    repository: { owner: request.repository.owner, name: request.repository.name },
    baseUrl,
    ref: request.ref ?? null,
    rootPath,
    credential,
  };
  return getRepositoryProvider(input.provider).preflight(input);
}
