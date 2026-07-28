import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { datasetMetadataSelect } from "@/lib/dataset-metadata";
import { datasetIdSchema, updateDatasetSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string }> };

async function resolve(actorId: Parameters<typeof requireDatasetPermission>[0], context: Context, permission: Parameters<typeof requireDatasetPermission>[2]) {
  const parsed = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!parsed.success) return { response: apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.") } as const;
  const access = await requireDatasetPermission(actorId, parsed.data, permission);
  if (!access) return { response: apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.") } as const;
  if (access.forbidden) return { response: apiError(403, "FORBIDDEN", "You do not have permission for this action.") } as const;
  return { datasetId: parsed.data } as const;
}

export async function GET(_request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await resolve(actor, context, "dataset.read"); if ("response" in result) return result.response;
  const dataset = await db.dataset.findFirst({ where: { id: result.datasetId, deletedAt: null, archivedAt: null }, select: datasetMetadataSelect });
  return dataset ? apiSuccess(dataset) : apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
}

export async function PATCH(request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await resolve(actor, context, "dataset.update"); if ("response" in result) return result.response;
  const parsed = updateDatasetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Dataset input is invalid.", parsed.error.flatten().fieldErrors);
  const { workflowStatus, ...update } = parsed.data;
  let metadata = update.metadata;
  if (workflowStatus) {
    const current = await db.dataset.findUnique({ where: { id: result.datasetId }, select: { metadata: true } });
    const currentMetadata = current?.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata)
      ? current.metadata as Record<string, unknown>
      : {};
    metadata = { ...currentMetadata, workflowStatus };
  }
  const dataset = await db.dataset.update({ where: { id: result.datasetId }, data: { ...update, ...(metadata !== undefined ? { metadata } : {}), ...(update.description !== undefined ? { description: update.description || null } : {}) }, select: datasetMetadataSelect });
  return apiSuccess(dataset);
}

export async function DELETE(_request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await resolve(actor, context, "dataset.delete"); if ("response" in result) return result.response;
  const dataset = await db.dataset.update({ where: { id: result.datasetId }, data: { archivedAt: new Date() }, select: datasetMetadataSelect });
  return apiSuccess(dataset);
}
