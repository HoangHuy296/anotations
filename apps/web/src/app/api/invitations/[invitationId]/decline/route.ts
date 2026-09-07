import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { DatasetMembershipError, declineDatasetInvitation, enqueueMembershipDispatches } from "@/lib/collaboration/dataset-membership-service";
import { collaborationRouteParamsSchema } from "@/lib/validation/collaboration";

export const dynamic = "force-dynamic";
export async function POST(_request: Request, context: { params: Promise<{ invitationId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = collaborationRouteParamsSchema.pick({ invitationId: true }).safeParse(await context.params);
  if (!parsed.success || !parsed.data.invitationId) return apiError(400, "INVALID_REQUEST", "Invitation identifier is invalid.");
  try {
    const declined = await declineDatasetInvitation(actor, parsed.data.invitationId);
    await enqueueMembershipDispatches(declined);
    return apiSuccess({ invitationId: declined.invitationId }, { status: declined.reused ? 200 : 201 });
  } catch (error) {
    if (error instanceof DatasetMembershipError) return error.code === "NOT_FOUND" ? apiError(404, "INVITATION_NOT_FOUND", "The invitation was not found.") : error.code === "FORBIDDEN" ? apiError(403, "FORBIDDEN", error.message) : apiError(409, "INVITATION_CONFLICT", error.message);
    throw error;
  }
}
