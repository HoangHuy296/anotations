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
  const query = assetListQuerySchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    status: url.searchParams.getAll("status").length ? url.searchParams.getAll("status") : undefined,
    modality: url.searchParams.get("modality") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    labelId: url.searchParams.getAll("labelId").length ? url.searchParams.getAll("labelId") : undefined,
    assignedToId: url.searchParams.get("assignedToId") ?? undefined,
    createdFrom: url.searchParams.get("createdFrom") ?? undefined,
    createdTo: url.searchParams.get("createdTo") ?? undefined,
    updatedFrom: url.searchParams.get("updatedFrom") ?? undefined,
    updatedTo: url.searchParams.get("updatedTo") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    order: url.searchParams.get("order") ?? undefined,
  });
  if (!query.success) return apiError(400, "INVALID_REQUEST", "Asset filters are invalid.", query.error.flatten().fieldErrors);
  // Kept as this route's own where-construction (rather than the shared
  // `buildAssetListWhere` used by the workspace RSC path) to preserve two
  // pre-existing, intentional differences from the workspace query: this
  // endpoint searches filename+originalFilename+description (not just
  // filename), and does not exclude archived assets. New 022 filters are
  // layered on without disturbing either. See contracts/assets-list.md.
  const createdAt = query.data.createdFrom || query.data.createdTo ? {
    ...(query.data.createdFrom ? { gte: new Date(query.data.createdFrom) } : {}),
    ...(query.data.createdTo ? { lte: new Date(query.data.createdTo) } : {}),
  } : undefined;
  const updatedAt = query.data.updatedFrom || query.data.updatedTo ? {
    ...(query.data.updatedFrom ? { gte: new Date(query.data.updatedFrom) } : {}),
    ...(query.data.updatedTo ? { lte: new Date(query.data.updatedTo) } : {}),
  } : undefined;
  const where = {
    datasetId: dataset.data,
    deletedAt: null,
    ...(query.data.status ? { status: { in: query.data.status } } : {}),
    ...(query.data.modality ? { modality: query.data.modality } : {}),
    ...(query.data.q ? { OR: [{ filename: { contains: query.data.q, mode: "insensitive" as const } }, { originalFilename: { contains: query.data.q, mode: "insensitive" as const } }, { description: { contains: query.data.q, mode: "insensitive" as const } }] } : {}),
    ...(query.data.labelId ? { assetLabels: { some: { labelId: { in: query.data.labelId } } } } : {}),
    ...(query.data.assignedToId ? { assignedToId: query.data.assignedToId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
  const orderField = query.data.sort ?? "createdAt";
  const orderBy = [{ [orderField]: query.data.sort ? query.data.order : "desc" } as Record<string, "asc" | "desc">, { id: "desc" as const }];
  const rows = await db.asset.findMany({ where, select: assetMetadataSelect, orderBy, ...(query.data.cursor ? { cursor: { id: query.data.cursor }, skip: 1 } : {}), take: query.data.limit + 1 });
  const hasNextPage = rows.length > query.data.limit;
  const items = hasNextPage ? rows.slice(0, -1) : rows;
  const safeItems = items.map(({ sizeBytes, ...asset }) => ({ ...asset, sizeBytes: sizeBytes?.toString() ?? null }));
  return apiSuccess({ items: safeItems, page: { limit: query.data.limit, nextCursor: hasNextPage ? items.at(-1)?.id ?? null : null, hasNextPage } });
}
