import "server-only";

export const repositoryProviders = ["GITHUB", "GITEA"] as const;
export type RepositoryProvider = (typeof repositoryProviders)[number];

export type RepositoryIdentity = {
  owner: string;
  name: string;
};

/** A token can exist only in server memory after an owned connection lookup. */
export type ServerCredentialContext = {
  /** Existing connection ID when a credential was persisted. A one-time PAT
   * deliberately has no ID and exists only for the current server request. */
  connectionId: string | null;
  baseUrl: string;
  token: string;
};

export type PreflightInput = {
  provider: RepositoryProvider;
  repository: RepositoryIdentity;
  baseUrl: string;
  ref: string | null;
  rootPath: string | null;
  credential: ServerCredentialContext | null;
};

export type ResolveRefInput = Pick<PreflightInput, "repository" | "baseUrl" | "credential"> & {
  requestedRef: string | null;
};

export type ResolvedRef = {
  requested: string | null;
  resolved: string;
  revision: string | null;
};

/** This descriptor is transient and bounded; it is never persisted as a manifest. */
export type SourceFileManifest = {
  path: string;
  kind: "FILE" | "DIRECTORY";
};

export type ListFilesInput = Pick<PreflightInput, "repository" | "baseUrl" | "credential"> & {
  ref: string;
  rootPath: string;
  limit: number;
};

export type DownloadFileInput = Pick<PreflightInput, "repository" | "baseUrl" | "credential"> & {
  ref: string;
  path: string;
};

export type ValidateTokenInput = Pick<PreflightInput, "baseUrl" | "credential">;

export type TokenValidationResult = { valid: true } | { valid: false; reason: "EXPIRED" | "INVALID" };

export type PreflightResult = {
  provider: RepositoryProvider;
  repository: RepositoryIdentity;
  visibility: "PUBLIC" | "PRIVATE";
  ref: ResolvedRef;
  rootPath: {
    requested: string | null;
    normalized: string | null;
    exists: boolean;
  };
  /** Bounded, transient preview only; never a persisted import manifest. */
  assetPreview: {
    detectedAssetCount: number;
    detectedBytes: number;
    truncated: boolean;
    sample: Array<{ path: string; size: number | null; modality: "IMAGE" | "VIDEO" | "AUDIO" | "TEXT" }>;
  } | null;
};

/**
 * The complete provider contract is future-facing. Phase 014 is allowed to
 * invoke only preflight/resolveRef and a bounded root check. `downloadFile`
 * is intentionally declared but not reachable from this phase.
 */
export interface RepositoryProviderAdapter {
  preflight(input: PreflightInput): Promise<PreflightResult>;
  resolveRef(input: ResolveRefInput): Promise<ResolvedRef>;
  listFiles(input: ListFilesInput): Promise<SourceFileManifest[]>;
  downloadFile(input: DownloadFileInput): Promise<ReadableStream<Uint8Array>>;
  validateToken?(input: ValidateTokenInput): Promise<TokenValidationResult>;
}
