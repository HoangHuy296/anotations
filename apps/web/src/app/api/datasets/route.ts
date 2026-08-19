import { UserRole } from "@internal/db";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { canCreateDataset } from "@/lib/authorization";
import { db } from "@/lib/db";
import { datasetMetadataSelect } from "@/lib/dataset-metadata";
import { parsePageRequest } from "@/lib/pagination";
import { createDatasetSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";

// No internal caller reads this route today (`(app)/datasets/page.tsx` runs
// its own direct `db.dataset.findMany` query and never fetches this route --
// confirmed by audit before adding pagination here). Default page size
// mirrors that Server Component's own page size.
const DEFAULT_PAGE_SIZE = 20;

export async function GET(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const where = {
    deletedAt: null,
    archivedAt: null,
    ...(actor.role === UserRole.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }),
  };
  const { page, pageSize, skip, take } = parsePageRequest(new URL(request.url).searchParams, DEFAULT_PAGE_SIZE);
  const [datasets, total] = await Promise.all([
    db.dataset.findMany({ where, orderBy: { updatedAt: "desc" }, select: datasetMetadataSelect, skip, take }),
    db.dataset.count({ where }),
  ]);
  return apiSuccess({ items: datasets, page, pageSize, total });
}

export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  if (!canCreateDataset(actor)) return apiError(403, "FORBIDDEN", "You cannot create datasets.");
  const parsed = createDatasetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Dataset input is invalid.", parsed.error.flatten().fieldErrors);
  const dataset = await db.dataset.create({ data: { ...parsed.data, description: parsed.data.description || null, ownerId: actor.id }, select: datasetMetadataSelect });
  return apiSuccess(dataset, { status: 201 });
}
