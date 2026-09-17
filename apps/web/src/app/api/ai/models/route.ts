import { z } from "zod";
import { AI_TOOL_TASK_NAMES } from "@/types/ai";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { listActiveAiModels } from "@/lib/ai/ai-model-service";
import { paginateInMemory, parsePageRequest } from "@/lib/pagination";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 100;

/** Lists AI models currently available for pre-annotation requests. */
export async function GET(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const params = new URL(request.url).searchParams;
  const modality = z.enum(["IMAGE", "VIDEO", "AUDIO", "TEXT"]).optional().safeParse(params.get("modality") ?? undefined);
  if (!modality.success) return apiError(400, "INVALID_REQUEST", "Invalid asset modality.");
  const taskName = z.enum(AI_TOOL_TASK_NAMES).safeParse(params.get("task_name") ?? undefined);
  if (!taskName.success) return apiError(400, "INVALID_REQUEST", "Invalid model task.");
  const pageRequest = parsePageRequest(params, DEFAULT_PAGE_SIZE);
  try {
    const { items, page, pageSize, total } = paginateInMemory(await listActiveAiModels(modality.data, taskName.data), pageRequest);
    return apiSuccess({ models: items, page, pageSize, total });
  } catch {
    return apiError(502, "AI_MODEL_CATALOG_UNAVAILABLE", "Could not load AI models. Try again.");
  }
}
