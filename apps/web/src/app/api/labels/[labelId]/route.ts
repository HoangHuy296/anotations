import { Prisma } from "@internal/db";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { labelMetadataSelect } from "@/lib/dataset-metadata";
import { labelIdSchema, labelMutationSchema, normalizeLabelName } from "@/lib/validation/label";
import { deleteUnreferencedLabel } from "@/lib/workspace/label-management";

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
  try {
    const label = await db.label.update({ where: { id: result.label.id }, data: { ...parsed.data, normalizedName: normalizeLabelName(parsed.data.name), description: parsed.data.description || null, hotkey: parsed.data.hotkey || null }, select: labelMetadataSelect });
    return apiSuccess(label);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return apiError(409, "INVALID_REQUEST", "A label with this name already exists.");
    throw error;
  }
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
