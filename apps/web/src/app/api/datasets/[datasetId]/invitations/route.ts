import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createDatasetInvitation, DatasetMembershipError, enqueueMembershipDispatches, listDatasetInvitations } from "@/lib/collaboration/dataset-membership-service";
import { datasetInvitationCreateSchema } from "@/lib/validation/collaboration";
import { datasetIdSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string }> };
function errorResponse(error: unknown) {
  if (!(error instanceof DatasetMembershipError)) throw error;
  if (error.code === "NOT_FOUND") return apiError(404, "GITEA_NOT_FOUND", "The dataset or invitee was not found.");
  if (error.code === "FORBIDDEN") return apiError(403, "FORBIDDEN", error.message);
  return apiError(409, "INVITATION_CONFLICT", error.message);
}
async function input(context: Context) {
  const actor = await getRequestActor();
  if (!actor) return { response: apiError(401, "AUTH_REQUIRED", "Authentication is required.") } as const;
  const dataset = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!dataset.success) return { response: apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.") } as const;
  return { actor, datasetId: dataset.data } as const;
}
export async function GET(_request: Request, context: Context) {
  const result = await input(context); if ("response" in result) return result.response;
  try { return apiSuccess({ items: await listDatasetInvitations(result.actor, result.datasetId) }); } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  const result = await input(context); if ("response" in result) return result.response;
  const parsed = datasetInvitationCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Invitation input is invalid.", parsed.error.flatten().fieldErrors);
  try {
    const created = await createDatasetInvitation(result.actor, { datasetId: result.datasetId, ...parsed.data });
    await enqueueMembershipDispatches(created);
    return apiSuccess(created.invitation, { status: created.reused ? 200 : 201 });
  } catch (error) { return errorResponse(error); }
}
