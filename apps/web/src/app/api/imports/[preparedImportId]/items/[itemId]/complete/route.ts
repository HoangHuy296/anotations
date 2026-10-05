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
  if (!result.ok) {
    const code = result.code;
    const allowed = new Set(["INVALID_REQUEST", "UPLOAD_CONFLICT", "DATASET_MODALITY_UNRESOLVED", "ASSET_MODALITY_MISMATCH", "UNSUPPORTED_MEDIA", "INVALID_MEDIA", "UPLOAD_NOT_READY", "INVALID_RELATIVE_PATH", "ASSET_WRITES_PAUSED_FOR_MIGRATION", "IMPORT_ITEM_RETRYABLE"] as const);
    return apiError(result.status, allowed.has(code as never) ? code as "UPLOAD_CONFLICT" : "INTERNAL_ERROR", "The import item could not be completed.", undefined, undefined, "accepted" in result ? { outcome: result.outcome, accepted: result.accepted, unchanged: result.unchanged, rejected: result.rejected, retryable: result.retryable, unprocessed: result.unprocessed } : undefined);
  }
  return apiSuccess({ assetId: result.assetId, replayed: result.replayed, disposition: result.disposition, accepted: result.accepted, unchanged: result.unchanged, rejected: result.rejected, retryable: result.retryable, unprocessed: result.unprocessed, completed: result.completed, total: result.total }, { status: result.status });
}
