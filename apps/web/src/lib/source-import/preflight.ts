import "server-only";

import type { RequestActor } from "@/lib/auth";
import { PreflightError } from "@/lib/providers/provider-errors";
import { getRepositoryProvider } from "@/lib/providers/provider-registry";
import { getGiteaBranches } from "@/lib/providers/gitea/gitea.client";
import { resolvePreflightGiteaCredential } from "@/lib/providers/token-check";
import type { PreflightResult, ServerCredentialContext } from "@/lib/providers/provider.types";
import { normalizeSourceRootPath, validateSourceBaseUrl } from "@/lib/source-access-policy";
import type { SourceImportRequest } from "@/lib/validation/source-connection";

function canonicalBaseUrl(url: URL) {
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Compose exposes Gitea to the browser at a public loopback URL while the web
 * container must reach it by its private service address. This substitution is
 * server-controlled and exact: browser input can only select the configured
 * public Gitea root; it cannot choose an arbitrary internal destination.
 */
function resolveServerReachableGiteaUrl(raw: string): { baseUrl: string; usesConfiguredInternalUrl: boolean } {
  const configuredPublic = process.env.GITEA_PUBLIC_URL;
  const configuredInternal = process.env.GITEA_INTERNAL_URL;
  // A host-run `next dev` can already reach Gitea at localhost. Only a
  // Compose process needs the private Docker service hostname.
  if (process.env.FIELDFRAME_RUNTIME !== "compose" || !configuredPublic || !configuredInternal) return { baseUrl: raw, usesConfiguredInternalUrl: false };
  try {
    return canonicalBaseUrl(new URL(raw)) === canonicalBaseUrl(new URL(configuredPublic))
      ? { baseUrl: configuredInternal, usesConfiguredInternalUrl: true }
      : { baseUrl: raw, usesConfiguredInternalUrl: false };
  } catch {
    return { baseUrl: raw, usesConfiguredInternalUrl: false };
  }
}

function configuredInternalBaseUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return canonicalBaseUrl(url);
  } catch {
    return null;
  }
}

export type SourceImportPreflight = {
  result: PreflightResult;
  baseUrl: string;
  sourceConnectionId: string | null;
  availableRefs: string[];
};

/**
 * Single read-only provider check used both before preview and immediately
 * before durable Start Import. One-time tokens stay only in this call stack.
 */
export async function preflightSourceImport(
  actor: RequestActor,
  input: SourceImportRequest,
): Promise<SourceImportPreflight> {
  const root = normalizeSourceRootPath(input.repository.rootPath ?? "");
  if (!root.ok) throw new PreflightError("UNSAFE_REPOSITORY_URL");

  let credential: ServerCredentialContext | null = null;
  let baseUrl: string;
  let sourceConnectionId: string | null = null;

  if (input.credentialMode === "EXISTING_SOURCE_CONNECTION") {
    credential = await resolvePreflightGiteaCredential(actor, input.sourceConnectionId!);
    baseUrl = credential.baseUrl;
    sourceConnectionId = credential.connectionId;
  } else {
    const reachable = resolveServerReachableGiteaUrl(input.serverUrl!);
    if (reachable.usesConfiguredInternalUrl) {
      const configured = configuredInternalBaseUrl(reachable.baseUrl);
      if (!configured) throw new PreflightError("UNSAFE_REPOSITORY_URL");
      baseUrl = configured;
    } else {
      const address = await validateSourceBaseUrl(reachable.baseUrl);
      if (!address.ok) throw new PreflightError("UNSAFE_REPOSITORY_URL");
      baseUrl = canonicalBaseUrl(address.value);
    }
    if (input.credentialMode === "ONE_TIME_PAT") {
      credential = { connectionId: null, baseUrl, token: input.personalAccessToken! };
    }
  }

  const result = await getRepositoryProvider("GITEA").preflight({
    provider: "GITEA",
    repository: { owner: input.repository.owner, name: input.repository.repo },
    baseUrl,
    ref: input.repository.ref,
    rootPath: root.value || null,
    credential,
  });
  let availableRefs: string[];
  try {
    availableRefs = await getGiteaBranches(baseUrl, { owner: input.repository.owner, name: input.repository.repo }, credential);
  } catch (error) {
    // A repository can be valid even when its provider refuses branch listing.
    // Preserve the verified selected ref as a safe, usable picker option.
    if (error instanceof PreflightError) throw error;
    availableRefs = [result.ref.resolved];
  }
  if (!availableRefs.includes(result.ref.resolved)) availableRefs.unshift(result.ref.resolved);
  return { result, baseUrl, sourceConnectionId, availableRefs };
}
