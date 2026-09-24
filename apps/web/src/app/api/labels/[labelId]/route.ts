import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { labelIdSchema, labelMutationSchema } from "@/lib/validation/label";
import { deleteUnreferencedLabel, updateLabelWithTextEligibility } from "@/lib/workspace/label-management";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ labelId: string }> };

async function resolve(context: Context) {
  const actor = await getRequestActor();
  if (!actor) return { response: apiError(401, "AUTH_REQUIRED", "Authentication is required.") } as const;
  const id = labelIdSchema.safeParse((await context.params).labelId);
  if (!id.success) return { response: apiError(400, "INVALID_REQUEST", "Label identifier is invalid.") } as const;
  const label = await db.label.findFirst({ where: { id: id.data }, select: { id: true, datasetId: true, _count: { select: { annotations: true } } } });
  if (!label) return { response: apiError(404, "GITEA_NOT_FOUND", "The label was not found.") } as const;
  const access = await requireDatasetPermission(actor, label.datasetId, "label.manage");
  if (!access) return { response: apiError(404, "GITEA_NOT_FOUND", "The label was not found.") } as const;
  if (access.forbidden) return { response: apiError(403, "FORBIDDEN", "You do not have permission for this action.") } as const;
  return { actor, label } as const;
}

export async function PATCH(request: Request, context: Context) {
  const result = await resolve(context); if ("response" in result) return result.response;
  const parsed = labelMutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Label input is invalid.", parsed.error.flatten().fieldErrors);
  const updated = await updateLabelWithTextEligibility(result.actor, {
    labelId: result.label.id, datasetId: result.label.datasetId,
    name: parsed.data.name, color: parsed.data.color,
    description: parsed.data.description || null, hotkey: parsed.data.hotkey || null,
    textEligibility: parsed.data.textEligibility,
  });
  if (!updated.ok) {
    if (updated.reason === "NOT_FOUND") return apiError(404, "GITEA_NOT_FOUND", "The label was not found.");
    if (updated.reason === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
    if (updated.reason === "DUPLICATE_NAME") return apiError(409, "INVALID_REQUEST", "A label with this name already exists.");
    if (updated.reason === "REFERENCED_SCOPE_LOCKED") return apiError(409, "INVALID_REQUEST", "This label is assigned to annotations and its eligibility cannot change.");
    return apiError(409, "INVALID_REQUEST", "The label could not be updated.");
  }
  return apiSuccess(updated.label);
}

export async function DELETE(_request: Request, context: Context) {
  const result = await resolve(context); if ("response" in result) return result.response;
  const deleted = await deleteUnreferencedLabel(result.actor, result.label.id);
  if (!deleted.ok) {
    if (deleted.status === 404) return apiError(404, "GITEA_NOT_FOUND", "The label was not found.");
    if (deleted.status === 403) return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
    return apiError(409, "INVALID_REQUEST", "A label assigned to annotations cannot be deleted.");
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
