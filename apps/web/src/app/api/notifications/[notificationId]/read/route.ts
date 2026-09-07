import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { markNotificationRead } from "@/lib/collaboration/notification-service";
import { collaborationRouteParamsSchema } from "@/lib/validation/collaboration";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ notificationId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const params = collaborationRouteParamsSchema.pick({ notificationId: true }).safeParse(await context.params);
  if (!params.success || !params.data.notificationId) return apiError(400, "INVALID_REQUEST", "Notification identifier is invalid.");
  const result = await markNotificationRead(actor, params.data.notificationId);
  return result ? apiSuccess(result) : apiError(404, "COLLABORATION_NOTIFICATION_NOT_FOUND", "The notification was not found.");
}
