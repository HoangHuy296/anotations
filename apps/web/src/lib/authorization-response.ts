import { apiError } from "@/lib/api-response";
export const authRequired = () => apiError(401, "AUTH_REQUIRED", "Authentication is required.");
export const forbidden = () => apiError(403, "FORBIDDEN", "You do not have permission for this action.");
export const hiddenNotFound = () => apiError(404, "GITEA_NOT_FOUND", "The requested resource was not found.");

/**
 * Same-origin guard for state-changing auth routes (password, profile,
 * preferences, refresh). Compares the browser-sent `Origin` against the
 * `Host` header the client actually addressed -- not `new URL(request.url)`,
 * which Next.js can normalize to its own configured/internal origin (e.g.
 * `localhost`) even when the request arrived over a different bound host
 * (a LAN IP, `allowedDevOrigins`, a reverse proxy), producing a false
 * mismatch that 401s a legitimately authenticated same-origin request.
 * A present-but-unparseable Origin is treated as a mismatch (reject), not a crash.
 */
export function isCrossOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host");
  if (!host) return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
