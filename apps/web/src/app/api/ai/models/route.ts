import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { listActiveAiModels } from "@/lib/ai/ai-model-service";
import { paginateInMemory, parsePageRequest } from "@/lib/pagination";

export const dynamic = "force-dynamic";

// `listActiveAiModelsClient()` (ai-task-api-client.ts) is the sole internal
// consumer, already coalesced through its own `dedupeInFlight` in-flight
// cache -- reused as-is here, untouched. It reads `payload.data.models` and
// ignores unknown fields, so the additive `page`/`pageSize`/`total` fields
// below are backward compatible with it. `listActiveAiModels` has no
// Prisma-level skip/take (the active-model catalog is small), so this
// route paginates the already-fetched array in memory.
const DEFAULT_PAGE_SIZE = 100;

/** Lists AI models currently available for pre-annotation requests. */
export async function GET(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const pageRequest = parsePageRequest(new URL(request.url).searchParams, DEFAULT_PAGE_SIZE);
  const { items, page, pageSize, total } = paginateInMemory(await listActiveAiModels(), pageRequest);
  return apiSuccess({ models: items, page, pageSize, total });
}
