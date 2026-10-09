import { AssetWritesQuiescedError } from "@annotationplatform/domain/asset-write-quiescence";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { cleanupUnpublishedObject, publishUploadedAsset, UploadPublicationFailure } from "@/lib/asset-upload";
import { getDirectUploadProviders } from "@/lib/providers";
import { replayExistingVerification, routeToMediaVerification } from "@/lib/media-verification/routing";
import { verifyUploadCapability } from "@/lib/upload-capability";
import { UploadVerificationFailure, verifyUploadedObject } from "@/lib/upload-verification";
import { completeUploadSchema } from "@/lib/validation/upload";

export const dynamic = "force-dynamic";

function verificationError(error: UploadVerificationFailure) {
  if (error.code === "UPLOAD_NOT_READY") return apiError(409, error.code, "The uploaded object is not ready.");
  if (error.code === "UNSUPPORTED_MEDIA") return apiError(415, error.code, "The uploaded object type is not supported.");
  return apiError(422, error.code, "The uploaded object is invalid.");
}

export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const parsed = completeUploadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Upload completion input is invalid.", parsed.error.flatten().fieldErrors);

  let providers;
  try {
    providers = getDirectUploadProviders();
  } catch {
    return apiError(500, "INTERNAL_ERROR", "Upload service is not available.");
  }
  const capability = verifyUploadCapability(providers.config, parsed.data.fileId);
  if (!capability) return apiError(400, "INVALID_REQUEST", "Upload completion capability is invalid or expired.");
  if (capability.preparedImportId || capability.preparedImportItemId) return apiError(400, "INVALID_REQUEST", "This upload must be completed through its prepared import.");

  const access = await requireDatasetPermission(actor, capability.datasetId, "asset.upload");
  if (!access) return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
  if (access.forbidden || capability.actorId !== actor.id) return apiError(403, "FORBIDDEN", "You do not have permission to complete this upload.");

  // A2 replay: a completion that already has a live or PUBLISHED verification answers from it without touching the (possibly sealed and removed) staged object.
  const existing = await replayExistingVerification({ bucket: providers.config.MINIO_BUCKET, objectKey: capability.objectKey });
  if (existing) return existing.dto.status === "PUBLISHED" && existing.dto.asset ? apiSuccess({ asset: existing.dto.asset, replayed: true }, { status: 200 }) : apiSuccess({ verification: existing.dto }, { status: 202 });

  try {
    const verified = await verifyUploadedObject(
      providers.minio,
      providers.config.MINIO_BUCKET,
      capability.objectKey,
      capability.sizeBytes,
      capability.candidateContentType,
    );
    const published = await publishUploadedAsset({ capability, verified, bucket: providers.config.MINIO_BUCKET });
    return apiSuccess({ asset: published.asset, replayed: published.replayed }, { status: published.replayed ? 200 : 201 });
  } catch (error) {
    // A2: an object the lightweight verifier cannot classify, declared video/mp4|webm into a VIDEO Dataset, is verified by the durable pipeline INSTEAD of being deleted.
    // Nothing is published and the staged object is kept; the Asset appears only after the worker's authoritative verification.
    if (error instanceof UploadVerificationFailure && error.code === "UNSUPPORTED_MEDIA") {
      const routed = await routeToMediaVerification({ minio: providers.minio, bucket: providers.config.MINIO_BUCKET, capability, source: "DIRECT_UPLOAD" });
      if (routed.kind === "refused") {
        return routed.result.status === 429
          ? apiError(429, "UPLOAD_VERIFICATION_LIMIT_REACHED", "Too many uploads are awaiting verification. Try again shortly.", undefined, { "Retry-After": "30" }, { scope: routed.result.scope, limit: routed.result.limit })
          : apiError(503, "UPLOAD_VERIFICATION_BUSY", "Upload verification is busy. Try again shortly.", undefined, { "Retry-After": "5" });
      }
      if (routed.kind === "not_ready") return apiError(409, "UPLOAD_NOT_READY", "The uploaded object is not ready.");
      if (routed.kind === "admitted") {
        if (routed.dto.status === "PUBLISHED" && routed.dto.asset) return apiSuccess({ asset: routed.dto.asset, replayed: true }, { status: 200 });
        return apiSuccess({ verification: routed.dto }, { status: 202 });
      }
    }
    await cleanupUnpublishedObject(providers.minio, providers.config.MINIO_BUCKET, capability.objectKey);
    if (error instanceof UploadVerificationFailure) {
      return verificationError(error);
    }
    if (error instanceof UploadPublicationFailure) return apiError(error.code === "INVALID_RELATIVE_PATH" ? 422 : 409, error.code, "The upload could not be published safely.");
    // specs/027-coco-dataset-export §10: a short, planned maintenance window
    // -- distinct from every other failure, retryable shortly.
    if (error instanceof AssetWritesQuiescedError) return apiError(503, "ASSET_WRITES_PAUSED_FOR_MIGRATION", "Asset creation is briefly paused for scheduled maintenance. Try again shortly.");
    return apiError(500, "INTERNAL_ERROR", "The upload could not be completed.");
  }
}
