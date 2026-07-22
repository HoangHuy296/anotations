import "server-only";

import { createPreparedImportUploadCapability, UPLOAD_CAPABILITY_TTL_SECONDS } from "@/lib/upload-capability";
import { browserReachableMinioUrl, getDirectUploadProviders } from "@/lib/providers";
import { requirePreparedImportAccess } from "@/lib/imports/authorization";
import { db } from "@/lib/db";

export async function createLocalFolderUploadCapabilities(actor: import("@/lib/auth").RequestActor, preparedImportId: string, itemIds: string[]) {
  const preparation = await requirePreparedImportAccess(actor, preparedImportId);
  if (!preparation || preparation.createdById !== actor.id || preparation.status !== "PREPARING" || preparation.deadlineAt <= new Date()) return null;
  const items = await db.preparedImportItem.findMany({
    where: { preparedImportId, id: { in: itemIds } },
    select: { id: true, filename: true, mimeType: true, sizeBytes: true, storageKey: true },
  });
  if (items.length !== new Set(itemIds).size) return null;
  const providers = getDirectUploadProviders();
  const capabilities = await Promise.all(items.map(async (item) => {
    const capability = createPreparedImportUploadCapability(providers.config, {
      actorId: actor.id, datasetId: preparation.datasetId, filename: item.filename, candidateContentType: item.mimeType,
      sizeBytes: Number(item.sizeBytes), objectKey: item.storageKey, preparedImportId, preparedImportItemId: item.id,
    });
    const policy = providers.minio.newPostPolicy();
    policy.setBucket(providers.config.MINIO_BUCKET);
    policy.setKey(capability.payload.objectKey);
    policy.setExpires(new Date(capability.payload.expiresAt * 1000));
    policy.setContentLengthRange(1, Number(item.sizeBytes));
    policy.setContentType(capability.payload.candidateContentType);
    const signed = await providers.minio.presignedPostPolicy(policy);
    return { itemId: item.id, uploadUrl: browserReachableMinioUrl(signed.postURL, providers.config.MINIO_PUBLIC_ENDPOINT), method: "POST" as const, formFields: signed.formData, fileId: capability.token, expiresInSeconds: UPLOAD_CAPABILITY_TTL_SECONDS };
  }));
  return { preparation, capabilities };
}
