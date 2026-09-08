import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { issueRealtimeTicket } from "@/lib/realtime/ticket-service";
import { realtimeTicketRequestSchema } from "@/lib/validation/collaboration";

export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const input = realtimeTicketRequestSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return apiError(400, "INVALID_REQUEST", "Realtime ticket request is invalid.");
  try {
    return apiSuccess(await issueRealtimeTicket(actor, input.data.datasetIds));
  } catch {
    // Do not reveal whether a requested dataset exists or which scope failed.
    return apiError(404, "DATASET_NOT_FOUND", "The dataset was not found.");
  }
}
