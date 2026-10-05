import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { prepareLocalFolderImport } from "@/lib/imports/prepare-local-folder-import";
import { enforceRateLimit } from "@/lib/rate-limit/enforce";
import { startLocalFolderImportSchema } from "@/lib/validation/local-folder-import";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const limited = await enforceRateLimit(actor.id, "import");
  if (limited) return limited;
  const parsed = startLocalFolderImportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Local-folder import input is invalid.", parsed.error.flatten().fieldErrors);
  const result = await prepareLocalFolderImport(actor, parsed.data);
  if (!result.ok) {
    const resultCode = "code" in result ? result.code : undefined;
    const code = resultCode === "IDEMPOTENCY_KEY_CONFLICT" ? "IDEMPOTENCY_KEY_CONFLICT" : resultCode === "DATASET_MODALITY_UNRESOLVED" ? "DATASET_MODALITY_UNRESOLVED" : "FORBIDDEN";
    return apiError(result.status, code, "The dataset import cannot be started in its current state.");
  }
  return apiSuccess({ preparation: result.preparation, replayed: result.replayed, deliveryPending: result.deliveryPending ?? false }, { status: result.status });
}
