import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { prepareDatasetAppendImport } from "@/lib/imports/prepare-local-folder-import";
import { enforceRateLimit } from "@/lib/rate-limit/enforce";
import { datasetIdSchema } from "@/lib/validation/dataset";
import { appendLocalFolderImportSchema } from "@/lib/validation/local-folder-import";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const limited = await enforceRateLimit(actor.id, "import");
  if (limited) return limited;
  const { datasetId } = await context.params;
  if (!datasetIdSchema.safeParse(datasetId).success) return apiError(404, "DATASET_NOT_FOUND", "The dataset was not found.");
  const parsed = appendLocalFolderImportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Local-folder import input is invalid.", parsed.error.flatten().fieldErrors);
  const result = await prepareDatasetAppendImport(actor, datasetId, parsed.data);
  if (!result.ok) return apiError(result.status, result.status === 404 ? "DATASET_NOT_FOUND" : "FORBIDDEN", result.status === 404 ? "The dataset was not found." : "You do not have permission to upload to this dataset.");
  return apiSuccess({ preparation: result.preparation, replayed: result.replayed, deliveryPending: result.deliveryPending ?? false }, { status: result.status });
}
