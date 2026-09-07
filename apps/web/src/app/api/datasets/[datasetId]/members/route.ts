import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { DatasetMembershipError, listDatasetMembers } from "@/lib/collaboration/dataset-membership-service";
import { datasetIdSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const dataset = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!dataset.success) return apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.");
  try {
    return apiSuccess({ items: await listDatasetMembers(actor, dataset.data) });
  } catch (error) {
    if (error instanceof DatasetMembershipError) {
      if (error.code === "NOT_FOUND") return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
      if (error.code === "FORBIDDEN") return apiError(403, "FORBIDDEN", error.message);
      return apiError(409, "INVITATION_CONFLICT", error.message);
    }
    throw error;
  }
}
