import "server-only";

import type { Client as MinioClient } from "minio";

import { isMediaVerificationEligible, isMediaVerificationEnabled } from "@annotationplatform/domain/media-verification";

import { db } from "@/lib/db";
import { admitMediaVerification, type AdmissionResult, type StagedIdentity } from "@/lib/media-verification/admission";
import { toVerificationStatusDto, type VerificationStatusDto } from "@/lib/media-verification/status";
import type { UploadCapability } from "@/lib/upload-capability";

export type VerificationRouting =
  | { kind: "not_eligible" }
  | { kind: "not_ready" }
  | { kind: "refused"; result: Extract<AdmissionResult, { ok: false }> }
  | { kind: "admitted"; replayed: boolean; dto: VerificationStatusDto; deliveryPending: boolean };

/**
 * Contract section 2 routing, shared by the direct and the local-folder completion routes. Eligible ONLY when media verification is enabled, the Dataset's modality is VIDEO and
 * the declared type is video/mp4 or video/webm (a resource-bounding gate: the declared type never decides the class). The staged object's identity is captured by
 * `statObject` BEFORE the admission transaction; a missing object or a size that differs from the capability's declared size is `UPLOAD_NOT_READY`, exactly as today.
 */
export async function routeToMediaVerification(input: {
  minio: Pick<MinioClient, "statObject">;
  bucket: string;
  capability: Pick<UploadCapability, "actorId" | "datasetId" | "objectKey" | "filename" | "candidateContentType" | "sizeBytes">;
  source: "DIRECT_UPLOAD" | "LOCAL_FOLDER_ITEM";
  preparedImportItemId?: string | null;
  relativePathHint?: string | null;
}): Promise<VerificationRouting> {
  if (!isMediaVerificationEnabled()) return { kind: "not_eligible" };
  const parent = await db.dataset.findFirst({ where: { id: input.capability.datasetId, deletedAt: null, archivedAt: null }, select: { modality: true } });
  if (!isMediaVerificationEligible({ declaredContentType: input.capability.candidateContentType, datasetModality: parent?.modality ?? null })) return { kind: "not_eligible" };

  let staged: StagedIdentity;
  try {
    const stat = await input.minio.statObject(input.bucket, input.capability.objectKey);
    if (!stat.etag || !stat.lastModified || stat.size !== input.capability.sizeBytes) return { kind: "not_ready" };
    staged = { bucket: input.bucket, key: input.capability.objectKey, etag: stat.etag.replace(/^"+|"+$/g, ""), sizeBytes: BigInt(stat.size), lastModified: stat.lastModified, versionId: stat.versionId ?? null };
  } catch {
    return { kind: "not_ready" };
  }
  const admission = await admitMediaVerification({
    actorId: input.capability.actorId, datasetId: input.capability.datasetId, source: input.source, preparedImportItemId: input.preparedImportItemId ?? null, staged,
    filename: input.capability.filename, relativePathHint: input.relativePathHint ?? null, declaredContentType: input.capability.candidateContentType, declaredSizeBytes: BigInt(input.capability.sizeBytes),
  });
  if (!admission.ok) return { kind: "refused", result: admission };
  const row = await db.mediaVerification.findUniqueOrThrow({
    where: { id: admission.verification.id },
    select: { id: true, status: true, verificationDeadlineAt: true, assetId: true, resultCode: true, resultReason: true, lastFailureCode: true, lastFailureReason: true, currentJob: { select: { status: true, errorCode: true } } },
  });
  return { kind: "admitted", replayed: admission.replayed, dto: await toVerificationStatusDto(row), deliveryPending: admission.deliveryPending };
}

/**
 * Replay of a completion request that already has a live (non-terminal) or PUBLISHED verification. Checked BEFORE the staged object is touched: once the worker has
 * sealed the object the staged key no longer exists, so re-verifying it would wrongly look like `UPLOAD_NOT_READY` and a failure path would be tempted to clean up. A terminal
 * non-PUBLISHED record is deliberately not a replay here (the client re-uploads; admission then decides between the same record and `generation + 1`).
 */
export async function replayExistingVerification(input: { bucket: string; objectKey: string; preparedImportItemId?: string | null }): Promise<Extract<VerificationRouting, { kind: "admitted" }> | null> {
  if (!isMediaVerificationEnabled()) return null;
  const select = { id: true, status: true, verificationDeadlineAt: true, assetId: true, resultCode: true, resultReason: true, lastFailureCode: true, lastFailureReason: true, currentJob: { select: { status: true, errorCode: true } } } as const;
  const latest = input.preparedImportItemId
    ? await db.mediaVerification.findFirst({ where: { preparedImportItemId: input.preparedImportItemId }, orderBy: { generation: "desc" }, select })
    : await db.mediaVerification.findFirst({ where: { stagedBucket: input.bucket, stagedKey: input.objectKey }, orderBy: { generation: "desc" }, select });
  if (!latest) return null;
  if (latest.status !== "PENDING" && latest.status !== "SEALED" && latest.status !== "VERIFIED" && latest.status !== "PUBLISHED") return null;
  return { kind: "admitted", replayed: true, dto: await toVerificationStatusDto(latest), deliveryPending: false };
}
