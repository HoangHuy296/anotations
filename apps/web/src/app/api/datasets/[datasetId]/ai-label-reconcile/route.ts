import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { reconcileAiLabels } from "@/lib/ai/ai-label-reconcile";
import { getRequestActor } from "@/lib/auth";
import { datasetIdSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string }> };

const bodySchema = z.object({ dryRun: z.boolean().default(true) }).strict();

/** Scoped repair of unlabeled AI annotations from their recorded provider class. Dry-run by default; `{ "dryRun": false }` applies it. */
export async function POST(request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const id = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!id.success) return apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.");
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "The reconcile request is invalid.", parsed.error.flatten().fieldErrors);
  const result = await reconcileAiLabels(actor, id.data, { dryRun: parsed.data.dryRun });
  if (!result.ok) {
    if (result.code === "NOT_FOUND") return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
    if (result.code === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
    return apiError(409, "INVALID_REQUEST", "AI label reconciliation supports IMAGE and VIDEO datasets only.");
  }
  const { ok: _ok, ...summary } = result;
  return apiSuccess(summary);
}
