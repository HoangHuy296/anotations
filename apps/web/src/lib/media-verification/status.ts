import "server-only";

import { deriveMediaVerificationApiStatus, type MediaVerificationApiStatus } from "@annotationplatform/domain/media-verification";

import { loadSafeUploadedAsset, type SafeUploadedAsset } from "@/lib/asset-upload";
import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";

export const VERIFICATION_POLL_AFTER_MS = 1_500;

export type VerificationStatusDto = {
  id: string;
  status: MediaVerificationApiStatus;
  /** Safe, upper-case reason code for a terminal non-PUBLISHED outcome or an operational failure (never a key, bucket, ETag, hash or probe internal). */
  code?: string;
  reason?: string;
  retryable?: boolean;
  expiresAt: string;
  pollAfterMs?: number;
  asset?: SafeUploadedAsset;
};

export async function toVerificationStatusDto(row: {
  id: string; status: Parameters<typeof deriveMediaVerificationApiStatus>[0]["status"]; verificationDeadlineAt: Date; assetId: string | null;
  resultCode: string | null; resultReason: string | null; lastFailureCode: string | null; lastFailureReason: string | null;
  currentJob: { status: string; errorCode: string | null } | null;
}, now = new Date()): Promise<VerificationStatusDto> {
  const status = deriveMediaVerificationApiStatus({ status: row.status, jobStatus: row.currentJob?.status ?? null, jobErrorCode: row.currentJob?.errorCode ?? null, now, verificationDeadlineAt: row.verificationDeadlineAt });
  const dto: VerificationStatusDto = { id: row.id, status, expiresAt: row.verificationDeadlineAt.toISOString() };
  if (status === "PENDING" || status === "VERIFYING") dto.pollAfterMs = VERIFICATION_POLL_AFTER_MS;
  if (status === "VERIFICATION_FAILED") { dto.code = row.lastFailureCode ?? "VERIFICATION_EXECUTION_EXHAUSTED"; if (row.lastFailureReason) dto.reason = row.lastFailureReason; dto.retryable = true; dto.pollAfterMs = VERIFICATION_POLL_AFTER_MS * 4; }
  if (["REJECTED", "STALE", "CANCELED", "EXPIRED"].includes(status)) {
    if (row.resultCode) dto.code = row.resultCode;
    if (row.resultReason) dto.reason = row.resultReason;
    // An EXPIRED row reports the earlier operational failure as its cause when there was one.
    if (status === "EXPIRED" && row.lastFailureReason) dto.reason = row.lastFailureReason;
  }
  if (status === "PUBLISHED" && row.assetId) { const asset = await loadSafeUploadedAsset(row.assetId); if (asset) dto.asset = asset; }
  return dto;
}

/** `null` for an unknown or inaccessible verification (the caller answers 404 for both). Requester holding asset.upload, or any dataset.read holder. */
export async function readVerificationStatus(actor: RequestActor, verificationId: string): Promise<VerificationStatusDto | null> {
  const row = await db.mediaVerification.findUnique({
    where: { id: verificationId },
    select: { id: true, datasetId: true, requestedById: true, status: true, verificationDeadlineAt: true, assetId: true, resultCode: true, resultReason: true, lastFailureCode: true, lastFailureReason: true, currentJob: { select: { status: true, errorCode: true } } },
  });
  if (!row) return null;
  const read = await requireDatasetPermission(actor, row.datasetId, "dataset.read");
  const readOk = Boolean(read && !read.forbidden);
  let uploadOk = false;
  if (!readOk && row.requestedById === actor.id) { const upload = await requireDatasetPermission(actor, row.datasetId, "asset.upload"); uploadOk = Boolean(upload && !upload.forbidden); }
  if (!readOk && !uploadOk) return null;
  return toVerificationStatusDto(row);
}
