import { UserRole } from "@internal/db";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { canCreateDataset } from "@/lib/authorization";
import { db } from "@/lib/db";
import { datasetMetadataSelect } from "@/lib/dataset-metadata";
import { createDatasetSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const datasets = await db.dataset.findMany({
    where: {
      deletedAt: null,
      archivedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }),
    },
    orderBy: { updatedAt: "desc" },
    select: datasetMetadataSelect,
  });
  return apiSuccess({ items: datasets });
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
