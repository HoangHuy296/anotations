import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createLocalFolderUploadCapabilities } from "@/lib/imports/local-folder-upload";
import { uploadCapabilitiesSchema } from "@/lib/validation/local-folder-import";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ preparedImportId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = uploadCapabilitiesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Upload capability input is invalid.", parsed.error.flatten().fieldErrors);
  const { preparedImportId } = await context.params;
  try {
    const result = await createLocalFolderUploadCapabilities(actor, preparedImportId, parsed.data.itemIds);
    if (!result) return apiError(404, "JOB_NOT_FOUND", "The import preparation was not found.");
    return apiSuccess({ capabilities: result.capabilities });
  } catch {
    return apiError(500, "INTERNAL_ERROR", "Upload service is not available.");
  }
}
