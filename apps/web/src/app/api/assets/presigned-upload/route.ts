import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { createUploadCapability, UPLOAD_CAPABILITY_TTL_SECONDS } from "@/lib/upload-capability";
import { browserReachableMinioUrl, getDirectUploadProviders } from "@/lib/providers";
import { MAX_DIRECT_UPLOAD_BYTES, presignedUploadSchema } from "@/lib/validation/upload";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const parsed = presignedUploadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Upload input is invalid.", parsed.error.flatten().fieldErrors);

  const access = await requireDatasetPermission(actor, parsed.data.datasetId, "asset.upload");
  if (!access) return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
  if (access.forbidden) return apiError(403, "FORBIDDEN", "You do not have permission to upload to this dataset.");

  let providers;
  try {
    providers = getDirectUploadProviders();
  } catch {
    return apiError(500, "INTERNAL_ERROR", "Upload service is not available.");
  }

  const capability = createUploadCapability(providers.config, {
    actorId: actor.id,
    datasetId: parsed.data.datasetId,
    filename: parsed.data.filename,
    candidateContentType: parsed.data.contentType,
    sizeBytes: parsed.data.sizeBytes,
  });
  try {
    const policy = providers.minio.newPostPolicy();
    policy.setBucket(providers.config.MINIO_BUCKET);
    policy.setKey(capability.payload.objectKey);
    policy.setExpires(new Date(capability.payload.expiresAt * 1000));
    policy.setContentLengthRange(1, MAX_DIRECT_UPLOAD_BYTES);
    policy.setContentType(capability.payload.candidateContentType);
    const signed = await providers.minio.presignedPostPolicy(policy);
    return apiSuccess({
      uploadUrl: browserReachableMinioUrl(signed.postURL, providers.config.MINIO_PUBLIC_ENDPOINT),
      method: "POST" as const,
      formFields: signed.formData,
      fileId: capability.token,
      expiresInSeconds: UPLOAD_CAPABILITY_TTL_SECONDS,
    }, { status: 201 });
  } catch {
    return apiError(500, "INTERNAL_ERROR", "Upload service is not available.");
  }
}
