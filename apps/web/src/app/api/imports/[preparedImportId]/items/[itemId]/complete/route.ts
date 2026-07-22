import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { completeLocalFolderItem } from "@/lib/imports/complete-local-folder-item";
import { completeLocalFolderItemSchema } from "@/lib/validation/local-folder-import";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ preparedImportId: string; itemId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = completeLocalFolderItemSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Item completion input is invalid.");
  const { preparedImportId, itemId } = await context.params;
  const result = await completeLocalFolderItem(actor, preparedImportId, itemId, parsed.data.fileId);
  if (!result.ok) return apiError(result.status, result.code ?? "INVALID_REQUEST", "The import item could not be completed.");
  return apiSuccess({ assetId: result.assetId, replayed: result.replayed, completed: result.completed, total: result.total }, { status: result.status });
}
