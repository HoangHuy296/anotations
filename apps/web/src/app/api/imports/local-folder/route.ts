import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { prepareLocalFolderImport } from "@/lib/imports/prepare-local-folder-import";
import { startLocalFolderImportSchema } from "@/lib/validation/local-folder-import";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = startLocalFolderImportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Local-folder import input is invalid.", parsed.error.flatten().fieldErrors);
  const result = await prepareLocalFolderImport(actor, parsed.data);
  if (!result.ok) return apiError(403, "FORBIDDEN", "You do not have permission to create a dataset import.");
  return apiSuccess({ preparation: result.preparation, replayed: result.replayed, deliveryPending: result.deliveryPending ?? false }, { status: result.status });
}
