import "server-only";

import { Prisma } from "@internal/db";

import { db } from "@/lib/db";
import { normalizeLabelName } from "@/lib/validation/label";

export type ResolveLabelInput = { labelId: string } | { createLabel: { name: string; color: string } };

/**
 * Resolves the Label a bulk Add-Label action should attach: either an
 * existing dataset Label, or a newly-created one following the exact same
 * naming/uniqueness rules as the standalone Labels tab (022 FR-014). A
 * `createLabel` request that races a duplicate name reuses the
 * already-created Label rather than erroring, matching the dataset-scoped
 * `[datasetId, normalizedName]` uniqueness the standalone Labels tab already
 * enforces -- never a second, asset-only label namespace.
 */
export async function resolveOrCreateLabel(datasetId: string, input: ResolveLabelInput): Promise<{ ok: true; labelId: string } | { ok: false; reason: "LABEL_NOT_FOUND" }> {
  if ("labelId" in input) {
    const label = await db.label.findFirst({ where: { id: input.labelId, datasetId }, select: { id: true } });
    return label ? { ok: true, labelId: label.id } : { ok: false, reason: "LABEL_NOT_FOUND" };
  }
  const normalizedName = normalizeLabelName(input.createLabel.name);
  try {
    const label = await db.label.create({
      data: { datasetId, name: input.createLabel.name, normalizedName, color: input.createLabel.color.toUpperCase() },
      select: { id: true },
    });
    return { ok: true, labelId: label.id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await db.label.findFirst({ where: { datasetId, normalizedName }, select: { id: true } });
      if (existing) return { ok: true, labelId: existing.id };
    }
    throw error;
  }
}

/**
 * Every Asset in `assetIds` (already dataset/authorization-resolved by the
 * caller) that has at least one Annotation referencing `labelId` -- read-only,
 * for the Remove-Label confirmation warning (022 FR-016). This never
 * modifies Annotation data; it only tells the caller whether to ask for
 * confirmation.
 */
export async function findAssetsWithAnnotationsReferencingLabel(assetIds: string[], labelId: string): Promise<string[]> {
  if (assetIds.length === 0) return [];
  const rows = await db.annotation.findMany({ where: { assetId: { in: assetIds }, labelId }, select: { assetId: true }, distinct: ["assetId"] });
  return rows.map((row) => row.assetId);
}
