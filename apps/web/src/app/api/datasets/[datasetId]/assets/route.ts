import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { assetMetadataSelect } from "@/lib/dataset-metadata";
import { assetListQuerySchema } from "@/lib/validation/asset-list";
import { datasetIdSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const dataset = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!dataset.success) return apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.");
  const access = await requireDatasetPermission(actor, dataset.data, "dataset.read");
  if (!access) return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
  if (access.forbidden) return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
  const url = new URL(request.url);
  const query = assetListQuerySchema.safeParse({ cursor: url.searchParams.get("cursor") ?? undefined, limit: url.searchParams.get("limit") ?? undefined, status: url.searchParams.get("status") ?? undefined, modality: url.searchParams.get("modality") ?? undefined, q: url.searchParams.get("q") ?? undefined });
  if (!query.success) return apiError(400, "INVALID_REQUEST", "Asset filters are invalid.", query.error.flatten().fieldErrors);
  const where = { datasetId: dataset.data, deletedAt: null, ...(query.data.status ? { status: query.data.status } : {}), ...(query.data.modality ? { modality: query.data.modality } : {}), ...(query.data.q ? { OR: [{ filename: { contains: query.data.q, mode: "insensitive" as const } }, { originalFilename: { contains: query.data.q, mode: "insensitive" as const } }, { description: { contains: query.data.q, mode: "insensitive" as const } }] } : {}) };
  const rows = await db.asset.findMany({ where, select: assetMetadataSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...(query.data.cursor ? { cursor: { id: query.data.cursor }, skip: 1 } : {}), take: query.data.limit + 1 });
  const hasNextPage = rows.length > query.data.limit;
  const items = hasNextPage ? rows.slice(0, -1) : rows;
  const safeItems = items.map(({ sizeBytes, ...asset }) => ({ ...asset, sizeBytes: sizeBytes?.toString() ?? null }));
  return apiSuccess({ items: safeItems, page: { limit: query.data.limit, nextCursor: hasNextPage ? items.at(-1)?.id ?? null : null, hasNextPage } });
}
