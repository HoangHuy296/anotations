import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { changeDatasetMemberRole, DatasetMembershipError, enqueueMembershipDispatches, removeDatasetMember } from "@/lib/collaboration/dataset-membership-service";
import { datasetMemberRoleChangeSchema } from "@/lib/validation/collaboration";
import { datasetIdSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string; userId: string }> };
const paramsSchema = z.object({ datasetId: datasetIdSchema, userId: z.string().cuid() });

async function input(context: Context) {
  const actor = await getRequestActor();
  if (!actor) return { response: apiError(401, "AUTH_REQUIRED", "Authentication is required.") } as const;
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return { response: apiError(400, "INVALID_REQUEST", "Dataset or member identifier is invalid.") } as const;
  return { actor, ...parsed.data } as const;
}
function errorResponse(error: unknown) {
  if (!(error instanceof DatasetMembershipError)) throw error;
  if (error.code === "NOT_FOUND") return apiError(404, "GITEA_NOT_FOUND", "The dataset member was not found.");
  if (error.code === "FORBIDDEN") return apiError(403, "FORBIDDEN", error.message);
  return apiError(409, "INVITATION_CONFLICT", error.message);
}
export async function PATCH(request: Request, context: Context) {
  const result = await input(context); if ("response" in result) return result.response;
  const parsed = datasetMemberRoleChangeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Role input is invalid.", parsed.error.flatten().fieldErrors);
  try {
    const changed = await changeDatasetMemberRole(result.actor, { datasetId: result.datasetId, userId: result.userId, role: parsed.data.role });
    await enqueueMembershipDispatches(changed);
    return apiSuccess({ member: changed.member, cleanedAssignmentIds: changed.cleanedAssignmentIds }, { status: changed.reused ? 200 : 201 });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(_request: Request, context: Context) {
  const result = await input(context); if ("response" in result) return result.response;
  try {
    const removed = await removeDatasetMember(result.actor, { datasetId: result.datasetId, userId: result.userId });
    await enqueueMembershipDispatches(removed);
    return apiSuccess({ removedUserId: removed.removedUserId, cleanedAssignmentIds: removed.cleanedAssignmentIds });
  } catch (error) { return errorResponse(error); }
}
