import { z } from "zod";

/**
 * A2 durable pre-publication media verification — DOMAIN FOUNDATION ONLY (frozen contract: specs/029-modality-specific-datasets/contracts/premedia-verification-a2.md,
 * sections 3-9). This module defines the representation, the state machine and its consistency rules as pure functions. It creates no Job, performs no I/O and
 * enables nothing: web admission, the verifier, sealing/publishing, the cap-50 admission and the polling UX are later increments.
 */

export const MEDIA_VERIFICATION_JOB_TYPE = "VERIFY_UPLOADED_MEDIA" as const;
export const MEDIA_VERIFICATION_CONTRACT_VERSION = 1 as const;
export const MEDIA_VERIFICATION_POLICY_VERSION = "premedia-verify.v2" as const;

/** Queue payload is strictly `{ jobId }`; the authoritative record is the MediaVerification row. `Job.input` carries only this. */
export const mediaVerificationJobInputSchema = z.object({
  verificationId: z.string().uuid(),
  contractVersion: z.literal(MEDIA_VERIFICATION_CONTRACT_VERSION),
}).strict();
export type MediaVerificationJobInput = z.infer<typeof mediaVerificationJobInputSchema>;

export const MEDIA_VERIFICATION_STATUSES = ["PENDING", "SEALED", "VERIFIED", "PUBLISHED", "REJECTED", "STALE", "CANCELED", "EXPIRED"] as const;
export type MediaVerificationStatus = (typeof MEDIA_VERIFICATION_STATUSES)[number];
export const MEDIA_VERIFICATION_SOURCES = ["DIRECT_UPLOAD", "LOCAL_FOLDER_ITEM"] as const;
export type MediaVerificationSource = (typeof MEDIA_VERIFICATION_SOURCES)[number];

/** Counted by the cap (contract section 8): the status column is the only source of truth. */
export const NON_TERMINAL_STATUSES = ["PENDING", "SEALED", "VERIFIED"] as const satisfies readonly MediaVerificationStatus[];
export const TERMINAL_STATUSES = ["PUBLISHED", "REJECTED", "STALE", "CANCELED", "EXPIRED"] as const satisfies readonly MediaVerificationStatus[];
export type NonTerminalMediaVerificationStatus = (typeof NON_TERMINAL_STATUSES)[number];

/** Allowed edges only (section 5). Terminal rows never change; a re-upload after a terminal non-PUBLISHED outcome is generation + 1, never a transition. */
export const MEDIA_VERIFICATION_TRANSITIONS: Readonly<Record<NonTerminalMediaVerificationStatus, readonly MediaVerificationStatus[]>> = Object.freeze({
  PENDING: Object.freeze(["SEALED", "STALE", "CANCELED", "EXPIRED"] as const),
  SEALED: Object.freeze(["VERIFIED", "REJECTED", "STALE", "CANCELED", "EXPIRED"] as const),
  VERIFIED: Object.freeze(["PUBLISHED", "REJECTED", "STALE", "CANCELED", "EXPIRED"] as const),
});

export const isNonTerminalStatus = (status: string): status is NonTerminalMediaVerificationStatus => (NON_TERMINAL_STATUSES as readonly string[]).includes(status);
export const isTerminalStatus = (status: string): boolean => (TERMINAL_STATUSES as readonly string[]).includes(status);

export function canTransitionMediaVerification(from: MediaVerificationStatus, to: MediaVerificationStatus): boolean {
  return isNonTerminalStatus(from) && (MEDIA_VERIFICATION_TRANSITIONS[from] as readonly string[]).includes(to);
}

export class MediaVerificationTransitionError extends Error {
  constructor(readonly from: MediaVerificationStatus, readonly to: MediaVerificationStatus) {
    super("MEDIA_VERIFICATION_TRANSITION_REFUSED");
    this.name = "MediaVerificationTransitionError";
  }
}
export function assertMediaVerificationTransition(from: MediaVerificationStatus, to: MediaVerificationStatus): void {
  if (!canTransitionMediaVerification(from, to)) throw new MediaVerificationTransitionError(from, to);
}

// ---- Limits (policy may only be lowered, never raised: contract sections 6.1, 7, 8)
export const MEDIA_VERIFICATION_ALLOWANCE_MS = 30 * 60 * 1000;
export const MEDIA_VERIFICATION_MAX_NON_TERMINAL = 50;
export const MEDIA_VERIFICATION_PROBE_TIMEOUT_MS = 120_000;
export const MEDIA_VERIFICATION_SOURCE_CAP_BYTES = 100 * 1024 * 1024;
export const MEDIA_VERIFICATION_PROBE_OUTPUT_CAP_BYTES = 64 * 1024;
export const MEDIA_VERIFICATION_MAX_STREAMS = 16;

// ---- Result codes and reasons (section 6.4)
export const MEDIA_REASONS = ["CONTAINER_UNSUPPORTED", "CODEC_UNSUPPORTED", "STILL_OR_COVER_ART", "MEDIA_UNREADABLE", "MEDIA_POLICY_REJECTED", "CLASS_MISMATCH"] as const;
export const PATH_REASONS = ["RELATIVE_PATH_INVALID"] as const;
export const EVIDENCE_REASONS = ["SOURCE_STAGED_CHANGED", "SOURCE_SEALED_CHANGED", "DATASET_EVIDENCE_CHANGED"] as const;
export const CANCEL_REASONS = ["DATASET_INACTIVE", "REQUESTED", "IMPORT_ENDED"] as const;
export const EXPIRY_REASONS = ["ALLOWANCE_ELAPSED"] as const;
/** Operational (never authoritative) reasons: recorded as `lastFailureReason`, never as the `resultReason` of a REJECTED row. */
export const OPERATIONAL_REASONS = ["UPLOAD_VERIFICATION_PROBE_TIMEOUT", "UPLOAD_VERIFICATION_PROBE_FAILED", "UPLOAD_VERIFICATION_STORAGE_FAILED", "UPLOAD_VERIFICATION_LEASE_LOST"] as const;
/** Job error codes whose FAILED Job leaves the verification retryable inside its allowance (section 9). Everything else is non-retryable. */
export const RETRYABLE_VERIFICATION_ERROR_CODES = ["VERIFICATION_INFRASTRUCTURE_FAILED", "VERIFICATION_EXECUTION_EXHAUSTED", "RECOVERY_EXHAUSTED", "MAX_RUNTIME_EXCEEDED"] as const;

const MEDIA_REASON_SET: ReadonlySet<string> = new Set(MEDIA_REASONS);
const PATH_REASON_SET: ReadonlySet<string> = new Set(PATH_REASONS);
export const isMediaReason = (value: unknown): boolean => typeof value === "string" && MEDIA_REASON_SET.has(value);
export const isPathReason = (value: unknown): boolean => typeof value === "string" && PATH_REASON_SET.has(value);

/** Section 9: `extractRetryContext` returns a context only for these error codes AND while the verification is non-terminal and inside its allowance. */
export function isMediaVerificationRetryEligible(input: { errorCode: string | null; verificationStatus: MediaVerificationStatus; now: Date; verificationDeadlineAt: Date }): boolean {
  return input.errorCode !== null
    && (RETRYABLE_VERIFICATION_ERROR_CODES as readonly string[]).includes(input.errorCode)
    && isNonTerminalStatus(input.verificationStatus)
    && input.now.getTime() < input.verificationDeadlineAt.getTime();
}

export type MediaVerificationApiStatus = "PENDING" | "VERIFYING" | "VERIFICATION_FAILED" | "PUBLISHED" | "REJECTED" | "STALE" | "CANCELED" | "EXPIRED";

/**
 * The status endpoint's view (section 10). `VERIFICATION_FAILED` is DERIVED, never stored: a non-terminal row whose current Job is FAILED with a retryable
 * operational code, before the deadline. It keeps its cap slot until the row is terminal.
 */
export function deriveMediaVerificationApiStatus(input: { status: MediaVerificationStatus; jobStatus: string | null; jobErrorCode: string | null; now: Date; verificationDeadlineAt: Date }): MediaVerificationApiStatus {
  if (input.status === "PENDING" || input.status === "SEALED" || input.status === "VERIFIED") {
    if (isMediaVerificationRetryEligible({ errorCode: input.jobStatus === "FAILED" ? input.jobErrorCode : null, verificationStatus: input.status, now: input.now, verificationDeadlineAt: input.verificationDeadlineAt })) return "VERIFICATION_FAILED";
    return input.status === "PENDING" ? "PENDING" : "VERIFYING";
  }
  return input.status;
}

// ---- Field/state consistency (section 4 table). Enforced in compare-and-swap writes and asserted by tests; there is intentionally no DB CHECK.
export type MediaVerificationRowFacts = {
  status: MediaVerificationStatus;
  boundDatasetModality?: string | null; verificationDeadlineAt?: Date | null;
  stagedBucket?: string | null; stagedKey?: string | null; stagedEtag?: string | null; stagedSizeBytes?: bigint | null; stagedLastModified?: Date | null;
  sealedKey?: string | null; sealedEtag?: string | null; sealedSizeBytes?: bigint | null; sealedLastModified?: Date | null; sealedAt?: Date | null;
  contentSha256?: string | null; probe?: unknown; verifiedModality?: string | null; policyVersion?: string | null; processorVersion?: string | null; verifiedAt?: Date | null;
  assetId?: string | null; publishedAt?: Date | null; finishedAt?: Date | null;
  resultCode?: string | null; resultReason?: string | null;
};
const present = (value: unknown) => value !== null && value !== undefined;

export function validateMediaVerificationRow(row: MediaVerificationRowFacts): { ok: true } | { ok: false; violations: string[] } {
  const violations: string[] = [];
  const need = (...names: Array<keyof MediaVerificationRowFacts>) => { for (const name of names) if (!present(row[name])) violations.push(`${String(name)}:REQUIRED`); };
  const forbid = (...names: Array<keyof MediaVerificationRowFacts>) => { for (const name of names) if (present(row[name])) violations.push(`${String(name)}:MUST_BE_NULL`); };
  need("boundDatasetModality", "verificationDeadlineAt", "stagedBucket", "stagedKey", "stagedEtag", "stagedSizeBytes", "stagedLastModified");
  switch (row.status) {
    case "PENDING":
      forbid("sealedKey", "sealedEtag", "sealedSizeBytes", "sealedLastModified", "sealedAt", "contentSha256", "verifiedModality", "assetId", "resultCode");
      break;
    case "SEALED":
      need("sealedKey", "sealedEtag", "sealedSizeBytes", "sealedLastModified", "sealedAt");
      forbid("contentSha256", "verifiedModality", "assetId", "resultCode");
      break;
    case "VERIFIED":
      need("sealedKey", "sealedEtag", "sealedSizeBytes", "sealedLastModified", "sealedAt", "contentSha256", "probe", "verifiedModality", "policyVersion", "processorVersion", "verifiedAt");
      if (present(row.verifiedModality) && row.verifiedModality !== row.boundDatasetModality) violations.push("verifiedModality:MUST_EQUAL_boundDatasetModality");
      forbid("assetId", "resultCode");
      break;
    case "PUBLISHED":
      need("sealedKey", "contentSha256", "probe", "verifiedModality", "assetId", "publishedAt", "finishedAt");
      forbid("resultCode");
      break;
    case "REJECTED": {
      need("resultCode", "resultReason", "finishedAt");
      forbid("assetId");
      if (row.resultCode === "INVALID_RELATIVE_PATH") {
        // Path-policy refusal of a positively verified object: the media evidence is retained, and only the path hint is refused.
        if (!isPathReason(row.resultReason)) violations.push("resultReason:MUST_BE_A_PATH_REASON");
        need("probe", "contentSha256", "verifiedModality");
      } else {
        if (!isMediaReason(row.resultReason)) violations.push("resultReason:MUST_BE_A_MEDIA_REASON");
        need("probe", "contentSha256"); // a media rejection requires a COMPLETED probe (R5)
        forbid("verifiedModality");
      }
      break;
    }
    case "STALE": case "CANCELED": case "EXPIRED":
      need("resultCode", "resultReason", "finishedAt");
      forbid("verifiedModality", "assetId");
      break;
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

// ---- Release guard (no production creation of verification Jobs in this increment)
export class MediaVerificationNotEnabledError extends Error {
  constructor() { super("MEDIA_VERIFICATION_NOT_ENABLED"); this.name = "MediaVerificationNotEnabledError"; }
}
/**
 * RELEASE GUARD. The database enum addition is not independently rollout-safe once a VERIFY_UPLOADED_MEDIA Job row exists: a web/worker still using the M25-generated client cannot
 * read such a Job. Every future creation site MUST call this first. It is off unless the operator sets `MEDIA_VERIFICATION_ENABLED=1`, which is only legitimate after every
 * web and worker image consuming the database has been rebuilt with the M26 client (see scripts/db-safety/a2-release-guard.mjs). No creation site exists in this increment.
 */
export function assertMediaVerificationJobCreationAllowed(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.MEDIA_VERIFICATION_ENABLED !== "1") throw new MediaVerificationNotEnabledError();
}
export const isMediaVerificationEnabled = (environment: NodeJS.ProcessEnv = process.env): boolean => environment.MEDIA_VERIFICATION_ENABLED === "1";

// ---- A2.4 runtime helpers shared by web admission and the worker verifier (pure; no I/O)
export const SEALED_UPLOAD_PREFIX = "verified-uploads/" as const;
/** Declared types that make an upload ELIGIBLE for verification. They bound resource use only; they are never an input to the verified class (contract section 2). */
export const MEDIA_VERIFICATION_ELIGIBLE_DECLARED_TYPES = ["video/mp4", "video/webm"] as const;
export const MEDIA_VERIFICATION_MAX_ATTEMPTS = 3;
/** Initial worker-side re-delivery backoff between in-place retries (per consumed attempt); the allowance is the only hard bound. */
export const MEDIA_VERIFICATION_RETRY_BACKOFF_MS = [5_000, 20_000] as const;

export function isMediaVerificationEligible(input: { declaredContentType: string; datasetModality: string | null }): boolean {
  return input.datasetModality === "VIDEO" && (MEDIA_VERIFICATION_ELIGIBLE_DECLARED_TYPES as readonly string[]).includes(input.declaredContentType);
}

const UUID_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** Deterministic sealed key (a retried copy rewrites the same key idempotently). Only the worker's verifier identity can write below this prefix. */
export function buildSealedKey(datasetId: string, verificationId: string): string {
  if (!UUID_PART.test(datasetId) || !UUID_PART.test(verificationId)) throw new Error("SEALED_KEY_INPUT_INVALID");
  return `${SEALED_UPLOAD_PREFIX}${datasetId}/${verificationId}/source`;
}

/** Container-derived MIME of a verified object. The declared type is never trusted for the published Asset. */
export function containerMimeType(formatName: string | null | undefined): "video/mp4" | "video/webm" | null {
  if (formatName === "mov,mp4,m4a,3gp,3g2,mj2") return "video/mp4";
  if (formatName === "matroska,webm") return "video/webm";
  return null;
}

/** Stable synthetic fingerprint for an A2-published Asset (contract section 5.3 step 3). */
export function a2SourceFingerprintInput(sealedKey: string, contentSha256: string): string {
  return `a2v1:${sealedKey}:${contentSha256}`;
}

export class MediaVerificationLimitError extends Error {
  constructor(readonly scope: "ACTOR" | "DATASET") { super("UPLOAD_VERIFICATION_LIMIT_REACHED"); this.name = "MediaVerificationLimitError"; }
}

/** Backoff before the next in-place attempt, given the number of attempts already consumed (1-based). Never exceeds the last configured step. */
export function nextRetryDelayMs(attemptsConsumed: number): number {
  const steps = MEDIA_VERIFICATION_RETRY_BACKOFF_MS;
  return steps[Math.min(Math.max(attemptsConsumed, 1), steps.length) - 1]!;
}

/** Contract section 7 (folder deadline interplay). A verification can only start before `deadlineAt`, so the tail never extends past `deadlineAt + allowance`. */
export const IMPORT_VERIFICATION_TAIL_CAP_MS = MEDIA_VERIFICATION_ALLOWANCE_MS;
/**
 * End of the settlement tail of a folder import: the latest verification allowance among its requested verifications, hard-capped at `deadlineAt + 30 min`.
 * `null` when the import has no verification (the plain `deadlineAt` governs). Inside the tail only already-requested verifications may settle and the import may be
 * committed; no NEW item completion is admitted after `deadlineAt`.
 */
export function importVerificationTailEnd(input: { deadlineAt: Date; verificationDeadlines: readonly Date[] }): Date | null {
  if (input.verificationDeadlines.length === 0) return null;
  const latest = Math.max(...input.verificationDeadlines.map((date) => date.getTime()));
  return new Date(Math.min(latest, input.deadlineAt.getTime() + IMPORT_VERIFICATION_TAIL_CAP_MS));
}
