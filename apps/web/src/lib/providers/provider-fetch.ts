import "server-only";

import { ProviderTransportError } from "@/lib/providers/provider-errors";
import { validateSourceBaseUrl } from "@/lib/source-access-policy";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;

function isRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function assertSafeDestination(url: URL) {
  if (url.username || url.password) throw new ProviderTransportError("UNSAFE");
  const destination = new URL(url);
  // Query strings are valid on provider API calls, but policy deliberately
  // evaluates only the destination authority/path, not transient API query.
  destination.search = "";
  destination.hash = "";
  if (isConfiguredGiteaInternalDestination(destination)) return;
  const safe = await validateSourceBaseUrl(destination.toString());
  if (!safe.ok) throw new ProviderTransportError("UNSAFE");
}

/**
 * The only production HTTP exception is the deployment-owned Compose Gitea
 * endpoint. It is never supplied by the browser: source-import preflight
 * selects it only after an exact match against GITEA_PUBLIC_URL. Redirects to
 * another host still go through the normal SSRF policy above.
 */
function isConfiguredGiteaInternalDestination(destination: URL) {
  if (process.env.ANNOTATIONPLATFORM_RUNTIME !== "compose") return false;
  const raw = process.env.GITEA_INTERNAL_URL;
  if (!raw) return false;
  try {
    const configured = new URL(raw);
    if (configured.username || configured.password || configured.search || configured.hash) return false;
    const basePath = configured.pathname.replace(/\/+$/, "");
    const candidatePath = destination.pathname;
    return destination.origin === configured.origin && (basePath === "" || candidatePath === basePath || candidatePath.startsWith(`${basePath}/`));
  } catch {
    return false;
  }
}

function classifyStatus(status: number): ProviderTransportError {
  if (status === 401) return new ProviderTransportError("UNAUTHORIZED");
  if (status === 403) return new ProviderTransportError("FORBIDDEN");
  if (status === 404) return new ProviderTransportError("NOT_FOUND");
  return new ProviderTransportError("UNAVAILABLE");
}

async function parseBoundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_RESPONSE_BYTES) throw new ProviderTransportError("INVALID_RESPONSE");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new ProviderTransportError("INVALID_RESPONSE");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderTransportError("INVALID_RESPONSE");
  }
}

/** Bounded, manual redirect fetch. It never exposes upstream response data. */
export async function requestProviderJson(input: {
  baseUrl: string;
  path: string;
  headers?: HeadersInit;
}): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(input.path, input.baseUrl);
  } catch {
    throw new ProviderTransportError("UNSAFE");
  }
  const credentialOrigin = url.origin;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertSafeDestination(url);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        // A token may stay on the original provider origin only. Even a
        // policy-approved cross-origin redirect never receives credentials.
        headers: { Accept: "application/json", ...(url.origin === credentialOrigin ? input.headers : undefined) },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderTransportError("UNAVAILABLE");
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location || hop === MAX_REDIRECTS) throw new ProviderTransportError("UNSAFE");
      try {
        url = new URL(location, url);
      } catch {
        throw new ProviderTransportError("UNSAFE");
      }
      // Validate before making the next request; an unsafe target is never
      // contacted, including a loopback/private redirect.
      await assertSafeDestination(url);
      continue;
    }
    if (!response.ok) throw classifyStatus(response.status);
    return parseBoundedJson(response);
  }
  throw new ProviderTransportError("UNSAFE");
}

export function encodePath(...segments: string[]) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}
