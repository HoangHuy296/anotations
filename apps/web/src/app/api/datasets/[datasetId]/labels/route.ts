import { Prisma } from "@internal/db";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { labelMetadataSelect } from "@/lib/dataset-metadata";
import { datasetIdSchema } from "@/lib/validation/dataset";
import { labelMutationSchema, normalizeLabelName } from "@/lib/validation/label";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string }> };

async function accessFor(context: Context, permission: "dataset.read" | "label.manage") {
  const actor = await getRequestActor();
  if (!actor) return { response: apiError(401, "AUTH_REQUIRED", "Authentication is required.") } as const;
  const id = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!id.success) return { response: apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.") } as const;
  const access = await requireDatasetPermission(actor, id.data, permission);
  if (!access) return { response: apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.") } as const;
  if (access.forbidden) return { response: apiError(403, "FORBIDDEN", "You do not have permission for this action.") } as const;
  return { datasetId: id.data } as const;
}

export async function GET(_request: Request, context: Context) {
  const result = await accessFor(context, "dataset.read"); if ("response" in result) return result.response;
  const labels = await db.label.findMany({ where: { datasetId: result.datasetId }, orderBy: { normalizedName: "asc" }, select: labelMetadataSelect });
  return apiSuccess({ items: labels });
}

export async function POST(request: Request, context: Context) {
  const result = await accessFor(context, "label.manage"); if ("response" in result) return result.response;
  const parsed = labelMutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Label input is invalid.", parsed.error.flatten().fieldErrors);
  try {
    const label = await db.label.create({ data: { ...parsed.data, datasetId: result.datasetId, normalizedName: normalizeLabelName(parsed.data.name), description: parsed.data.description || null, hotkey: parsed.data.hotkey || null }, select: labelMetadataSelect });
    return apiSuccess(label, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return apiError(409, "INVALID_REQUEST", "A label with this name already exists.");
    throw error;
  }
}
