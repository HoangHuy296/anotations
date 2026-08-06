import "server-only";

function canonicalUrl(url: URL) {
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Compose exposes Gitea to the browser at a public loopback URL while any web
 * or worker process must reach it by its private Compose service address.
 * This substitution is server-controlled and exact: a caller can only ever
 * select the one configured public Gitea root; it can never choose an
 * arbitrary internal destination.
 *
 * Shared by the browser-submitted `serverUrl` path (`source-import/preflight.ts`)
 * and every durable `SourceConnection.baseUrl` re-validation path. A stored
 * connection always persists the public root, never the internal alias (see
 * `preflight.ts`'s `durableBaseUrl`), so the same substitution applies there
 * too whenever the stored value is being resolved back to a reachable address.
 */
export function resolveServerReachableGiteaUrl(raw: string): { baseUrl: string; usesConfiguredInternalUrl: boolean } {
  const configuredPublic = process.env.GITEA_PUBLIC_URL;
  const configuredInternal = process.env.GITEA_INTERNAL_URL;
  if (process.env.FIELDFRAME_RUNTIME !== "compose" || !configuredPublic || !configuredInternal) return { baseUrl: raw, usesConfiguredInternalUrl: false };
  try {
    return canonicalUrl(new URL(raw)) === canonicalUrl(new URL(configuredPublic))
      ? { baseUrl: configuredInternal, usesConfiguredInternalUrl: true }
      : { baseUrl: raw, usesConfiguredInternalUrl: false };
  } catch {
    return { baseUrl: raw, usesConfiguredInternalUrl: false };
  }
}

/**
 * Format-validates and canonicalizes a trusted, server-controlled URL (never
 * arbitrary input) without running it through the general SSRF policy.
 */
export function configuredInternalBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return canonicalUrl(url);
  } catch {
    return null;
  }
}
