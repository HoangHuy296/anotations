import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { markAllNotificationsRead } from "@/lib/collaboration/notification-service";

export const dynamic = "force-dynamic";

export async function POST() {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  return apiSuccess(await markAllNotificationsRead(actor));
}
