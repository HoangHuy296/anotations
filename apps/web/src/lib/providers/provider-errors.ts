import "server-only";

export type PreflightFailureCode =
  | "UNSUPPORTED_PROVIDER"
  | "UNSAFE_REPOSITORY_URL"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_ACCESS_DENIED"
  | "SOURCE_TOKEN_EXPIRED"
  | "SOURCE_TOKEN_INVALID"
  | "REF_NOT_FOUND"
  | "ROOT_PATH_NOT_FOUND"
  | "SOURCE_CONNECTION_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE";

export class PreflightError extends Error {
  constructor(public readonly code: PreflightFailureCode) {
    super(code);
    this.name = "PreflightError";
  }
}

export type ProviderTransportKind = "NOT_FOUND" | "UNAUTHORIZED" | "FORBIDDEN" | "UNAVAILABLE" | "INVALID_RESPONSE" | "UNSAFE";

/** Internal only: it deliberately carries no provider URL, body, or token. */
export class ProviderTransportError extends Error {
  constructor(public readonly kind: ProviderTransportKind) {
    super(kind);
    this.name = "ProviderTransportError";
  }
}

export function toPreflightError(
  error: unknown,
  stage: "repository" | "ref" | "root",
  hasCredential: boolean,
): PreflightError {
  if (error instanceof PreflightError) return error;
  if (!(error instanceof ProviderTransportError)) return new PreflightError("PROVIDER_UNAVAILABLE");
  if (error.kind === "UNSAFE") return new PreflightError("UNSAFE_REPOSITORY_URL");
  if (error.kind === "UNAVAILABLE" || error.kind === "INVALID_RESPONSE") return new PreflightError("PROVIDER_UNAVAILABLE");
  // Provider 401 does not safely prove expiry rather than revocation or a bad
  // token. Credential failures intentionally share SOURCE_TOKEN_INVALID.
  if (error.kind === "UNAUTHORIZED") return new PreflightError(hasCredential ? "SOURCE_TOKEN_INVALID" : "REPOSITORY_ACCESS_DENIED");
  if (error.kind === "FORBIDDEN") return new PreflightError(hasCredential ? "SOURCE_TOKEN_INVALID" : "REPOSITORY_ACCESS_DENIED");
  // Credential/ciphertext failures deliberately collapse to
  // SOURCE_TOKEN_INVALID. Selector failures intentionally remain distinct:
  // a syntactically valid ref or root can be independently corrected without
  // changing a credential, and neither code reveals provider internals.
  if (stage === "ref") return new PreflightError("REF_NOT_FOUND");
  if (stage === "root") return new PreflightError("ROOT_PATH_NOT_FOUND");
  return new PreflightError("REPOSITORY_NOT_FOUND");
}

export function safePreflightFailure(error: unknown): { status: number; code: PreflightFailureCode; message: string } {
  const failure = error instanceof PreflightError ? error : new PreflightError("PROVIDER_UNAVAILABLE");
  const details: Record<PreflightFailureCode, { status: number; message: string }> = {
    UNSUPPORTED_PROVIDER: { status: 400, message: "The selected repository provider is not supported." },
    UNSAFE_REPOSITORY_URL: { status: 400, message: "The repository address is not allowed." },
    REPOSITORY_NOT_FOUND: { status: 404, message: "The repository was not found." },
    REPOSITORY_ACCESS_DENIED: { status: 403, message: "The repository cannot be accessed." },
    SOURCE_TOKEN_EXPIRED: { status: 422, message: "The source token has expired." },
    SOURCE_TOKEN_INVALID: { status: 422, message: "The source token is invalid." },
    REF_NOT_FOUND: { status: 404, message: "The requested revision was not found." },
    ROOT_PATH_NOT_FOUND: { status: 404, message: "The requested root path was not found." },
    SOURCE_CONNECTION_NOT_FOUND: { status: 404, message: "The requested source connection was not found." },
    PROVIDER_UNAVAILABLE: { status: 503, message: "The repository provider is unavailable." },
  };
  return { code: failure.code, ...details[failure.code] };
}
