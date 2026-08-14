import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { listActiveAiModels } from "@/lib/ai/ai-model-service";

export const dynamic = "force-dynamic";

/** Lists AI models currently available for pre-annotation requests. */
export async function GET() {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const models = await listActiveAiModels();
  return apiSuccess({ models });
}
