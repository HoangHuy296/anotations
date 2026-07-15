import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { cleanupUnpublishedObject, publishUploadedAsset, UploadPublicationFailure } from "@/lib/asset-upload";
import { getDirectUploadProviders } from "@/lib/providers";
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

  const access = await requireDatasetPermission(actor, capability.datasetId, "asset.upload");
  if (!access) return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
  if (access.forbidden || capability.actorId !== actor.id) return apiError(403, "FORBIDDEN", "You do not have permission to complete this upload.");

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
    await cleanupUnpublishedObject(providers.minio, providers.config.MINIO_BUCKET, capability.objectKey);
    if (error instanceof UploadVerificationFailure) {
      return verificationError(error);
    }
    if (error instanceof UploadPublicationFailure) return apiError(409, error.code, "The upload could not be published safely.");
    return apiError(500, "INTERNAL_ERROR", "The upload could not be completed.");
  }
}
