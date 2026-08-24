import "server-only";

import type { RequestActor } from "@/lib/auth";
import { PreflightError } from "@/lib/providers/provider-errors";
import { getRepositoryProvider } from "@/lib/providers/provider-registry";
import { getGiteaBranches, getGiteaCommits } from "@/lib/providers/gitea/gitea.client";
import { resolvePreflightGiteaCredential } from "@/lib/providers/token-check";
import { configuredInternalBaseUrl, resolveServerReachableGiteaUrl } from "@/lib/providers/gitea-compose-url";
import type { PreflightResult, ServerCredentialContext } from "@/lib/providers/provider.types";
import { normalizeSourceRootPath, validateSourceBaseUrl } from "@/lib/source-access-policy";
import type { SourceImportRequest } from "@/lib/validation/source-connection";

function canonicalBaseUrl(url: URL) {
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export type SourceImportPreflight = {
  result: PreflightResult;
  /** The address actually reachable from this server process right now (may
   * be the internal Compose alias); use this only to make provider calls. */
  baseUrl: string;
  /** The durable, worker-revalidatable address -- always the public root,
   * never the internal Compose alias. Persist this on a new SourceConnection. */
  durableBaseUrl: string;
  sourceConnectionId: string | null;
  /** The requested branch/tag, independent of any pinned commit. This is the
   * anchor for the branch picker and the "Choose commit" list -- it never
   * becomes a raw commit SHA, even while `result.ref` is pinned to one. */
  displayRef: string;
  availableRefs: string[];
  /** Commit history of `displayRef`'s branch, bounded for the Import
   * Preview's "Choose commit" picker. Provider metadata only. Always scoped
   * to the branch, never rebased onto a pinned commit, so pinning an older
   * commit does not shrink the list. */
  availableCommits: Array<{ sha: string; message: string }>;
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
  let durableBaseUrl: string;
  let sourceConnectionId: string | null = null;

  if (input.credentialMode === "EXISTING_SOURCE_CONNECTION") {
    credential = await resolvePreflightGiteaCredential(actor, input.sourceConnectionId!);
    baseUrl = credential.baseUrl;
    // Not used to persist a new connection in this branch -- the existing row
    // is reused as-is -- but kept equal to baseUrl for a consistent return shape.
    durableBaseUrl = baseUrl;
    sourceConnectionId = credential.connectionId;
  } else {
    const reachable = resolveServerReachableGiteaUrl(input.serverUrl!);
    if (reachable.usesConfiguredInternalUrl) {
      const configured = configuredInternalBaseUrl(reachable.baseUrl);
      if (!configured) throw new PreflightError("UNSAFE_REPOSITORY_URL");
      baseUrl = configured;
      // `reachable.usesConfiguredInternalUrl` already proved `input.serverUrl`
      // canonically equals GITEA_PUBLIC_URL. That public root -- never the
      // internal Compose alias just resolved above -- is the durable address
      // a new SourceConnection must persist, since only the public root
      // survives the worker's later SSRF re-validation.
      const publicRoot = configuredInternalBaseUrl(process.env.GITEA_PUBLIC_URL!);
      if (!publicRoot) throw new PreflightError("UNSAFE_REPOSITORY_URL");
      durableBaseUrl = publicRoot;
    } else {
      const address = await validateSourceBaseUrl(reachable.baseUrl);
      if (!address.ok) throw new PreflightError("UNSAFE_REPOSITORY_URL");
      baseUrl = canonicalBaseUrl(address.value);
      durableBaseUrl = baseUrl;
    }
    if (input.credentialMode === "ONE_TIME_PAT") {
      credential = { connectionId: null, baseUrl, token: input.personalAccessToken! };
    }
  }

  // A pinned commit narrows what gets resolved/previewed (assetPreview,
  // revision), but `input.repository.ref` -- the branch -- stays the anchor
  // for display and for the commit/branch pickers below.
  const result = await getRepositoryProvider("GITEA").preflight({
    provider: "GITEA",
    repository: { owner: input.repository.owner, name: input.repository.repo },
    baseUrl,
    ref: input.repository.commit ?? input.repository.ref,
    rootPath: root.value || null,
    credential,
  });
  const displayRef = input.repository.ref;
  let availableCommits: Array<{ sha: string; message: string }>;
  try {
    availableCommits = await getGiteaCommits(baseUrl, { owner: input.repository.owner, name: input.repository.repo }, displayRef, credential);
  } catch (error) {
    // A repository can be valid even when its provider refuses commit listing.
    // Fall back to the verified resolved revision as a safe, usable picker option.
    if (error instanceof PreflightError) throw error;
    availableCommits = [];
  }
  if (result.ref.revision && !availableCommits.some((commit) => commit.sha === result.ref.revision)) {
    availableCommits.unshift({ sha: result.ref.revision, message: "Current commit" });
  }
  let availableRefs: string[];
  try {
    availableRefs = await getGiteaBranches(baseUrl, { owner: input.repository.owner, name: input.repository.repo }, credential);
  } catch (error) {
    // A repository can be valid even when its provider refuses branch listing.
    // Preserve the verified selected ref as a safe, usable picker option.
    if (error instanceof PreflightError) throw error;
    availableRefs = [displayRef];
  }
  if (!availableRefs.includes(displayRef)) availableRefs.unshift(displayRef);
  return { result, baseUrl, durableBaseUrl, sourceConnectionId, displayRef, availableRefs, availableCommits };
}
