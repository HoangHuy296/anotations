import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { listNotifications } from "@/lib/collaboration/notification-service";
import { notificationListQuerySchema } from "@/lib/validation/collaboration";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const query = notificationListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return apiError(400, "INVALID_REQUEST", "Notification query is invalid.", query.error.flatten().fieldErrors);
  return apiSuccess(await listNotifications(actor, { ...query.data, unreadOnly: query.data.unreadOnly === "true" }));
}
