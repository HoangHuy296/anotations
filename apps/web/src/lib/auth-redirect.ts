const DEFAULT_AUTHENTICATED_PATH = "/dashboard";

/**
 * Accept only an application-relative path. This value is navigation state,
 * never an authorization claim, so an invalid value safely falls back.
 */
export function safeReturnTarget(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return DEFAULT_AUTHENTICATED_PATH;
  }

  try {
    const candidate = new URL(value, "https://annotationplatform.local");
    if (candidate.origin !== "https://annotationplatform.local") {
      return DEFAULT_AUTHENTICATED_PATH;
    }
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return DEFAULT_AUTHENTICATED_PATH;
  }
}

export { DEFAULT_AUTHENTICATED_PATH };
