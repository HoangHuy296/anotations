import "server-only";

import type { JobStatus } from "@internal/db";

/**
 * TEXT source readiness (data-model.md "Source document"). A pure projection
 * of verified TextAsset metadata, Asset object presence and the latest
 * relevant TEXT_SOURCE_PREPARE Job — never a second independently writable
 * lifecycle. Readiness failure carries an allowlisted reason only (see
 * safe-job-status.ts), never upstream error text.
 */
export const TEXT_SOURCE_READINESS_STATES = [
  "UNPREPARED",
  "PREPARING",
  "READY",
  "UNAVAILABLE",
  "INVALID_ENCODING",
  "SOURCE_MISMATCH",
  "UNSUPPORTED_SIZE",
  "LEGACY_RECONCILIATION_REQUIRED",
] as const;
export type TextSourceReadiness = (typeof TEXT_SOURCE_READINESS_STATES)[number];

/**
 * A live read (text-source-read-service.ts, T028) re-verifies the object
 * against the previously-verified `sourceIdentity` on every call; that
 * result can promote a nominally READY asset to a failure state for this
 * specific request without a second writable lifecycle. Omit this (or use
 * "not_checked") for a cheap DB-only classification, e.g. an asset list.
 */
export type TextSourceReverification =
  | { kind: "not_checked" }
  | { kind: "matched" }
  | { kind: "mismatch" }
  | { kind: "unavailable" }
  | { kind: "invalid_encoding" }
  | { kind: "oversized" };

export interface DeriveTextSourceReadinessInput {
  asset: { storageBucket: string | null; storageKey: string | null };
  textAsset: { sourceIdentity: string | null; content: string | null } | null;
  latestPrepareJob: { status: JobStatus; errorCode: string | null } | null;
  reverification?: TextSourceReverification;
}

const runningJobStatuses = new Set<JobStatus>(["QUEUED", "RUNNING", "RETRYING", "CANCELING"]);

export function deriveTextSourceReadiness(input: DeriveTextSourceReadinessInput): TextSourceReadiness {
  const hasObject = Boolean(input.asset.storageBucket && input.asset.storageKey);
  const hasLegacyInlineContent = Boolean(input.textAsset?.content && input.textAsset.content.length > 0);
  const isPrepared = Boolean(input.textAsset?.sourceIdentity);
  const reverification = input.reverification ?? { kind: "not_checked" as const };

  if (isPrepared) {
    switch (reverification.kind) {
      case "mismatch":
        return "SOURCE_MISMATCH";
      case "unavailable":
        return "UNAVAILABLE";
      case "invalid_encoding":
        return "INVALID_ENCODING";
      case "oversized":
        return "UNSUPPORTED_SIZE";
      case "matched":
      case "not_checked":
        return "READY";
    }
  }

  if (input.latestPrepareJob) {
    const { status, errorCode } = input.latestPrepareJob;
    if (runningJobStatuses.has(status)) return "PREPARING";
    if (status === "FAILED") {
      if (errorCode === "TEXT_SOURCE_INVALID_ENCODING") return "INVALID_ENCODING";
      if (errorCode === "TEXT_SOURCE_OVERSIZED_BYTES" || errorCode === "TEXT_SOURCE_OVERSIZED_CODE_UNITS") return "UNSUPPORTED_SIZE";
      if (errorCode === "TEXT_SOURCE_STALE") return "SOURCE_MISMATCH";
      // TEXT_SOURCE_MISSING or an unrecognized code: fall through to the
      // object/legacy-content classification below rather than guessing.
    }
  }

  if (!hasObject) {
    return hasLegacyInlineContent ? "LEGACY_RECONCILIATION_REQUIRED" : "UNAVAILABLE";
  }

  return "UNPREPARED";
}
