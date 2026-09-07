import { Prisma } from "../../../../lib/generated/prisma/client.js";
import type { AssetStatus, Modality } from "../../../../lib/generated/prisma/client.js";
import type { BulkAssetJobInput } from "@annotationplatform/domain/bulk-asset-job";

/**
 * Worker-side mirror of `apps/web/src/lib/workspace/workspace-assets.ts`'s
 * `buildAssetListWhere` -- duplicated rather than imported, since `apps/web`
 * and `apps/worker` never import each other's app code (different Prisma
 * client instantiation, different deploy boundary); only pure, DB-free
 * schemas are shared, via `packages/domain` (`bulk-asset-job.ts`). Keep this
 * behaviorally in sync with the web version if either changes -- both must
 * agree on "what does this selection match" (022 research.md §4).
 */
export function buildBulkAssetWhere(datasetId: string, selection: BulkAssetJobInput): Prisma.AssetWhereInput {
  if (selection.mode === "EXPLICIT") {
    return { id: { in: selection.assetIds }, datasetId, deletedAt: null };
  }
  const query = selection.query;
  const search = query.q?.trim().slice(0, 100);
  // `Job.input` was written by the web side after `assetBulkRequestSchema`
  // validated these values against the real `AssetStatus`/`Modality`
  // enums (see apps/web/src/lib/validation/asset-bulk.ts) -- this worker
  // process trusts that upstream validation rather than importing the
  // generated enum objects as runtime values (the compiled Prisma client
  // does not reliably re-export them for a plain ESM import here; every
  // other worker job already treats `Job.input` the same way, e.g.
  // export-dataset.ts's loose `job.input as {...}` cast). An unexpected
  // value would surface as a Prisma validation error, not a silent
  // mismatch.
  const status = query.status as AssetStatus[] | undefined;
  const modality = query.modality as Modality | undefined;
  const createdAt = query.createdFrom || query.createdTo ? {
    ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}),
    ...(query.createdTo ? { lte: new Date(query.createdTo) } : {}),
  } : undefined;
  const updatedAt = query.updatedFrom || query.updatedTo ? {
    ...(query.updatedFrom ? { gte: new Date(query.updatedFrom) } : {}),
    ...(query.updatedTo ? { lte: new Date(query.updatedTo) } : {}),
  } : undefined;
  return {
    datasetId,
    deletedAt: null,
    archivedAt: null,
    ...(search ? { filename: { contains: search, mode: "insensitive" as const } } : {}),
    ...(status?.length ? { status: { in: status } } : {}),
    ...(modality ? { modality } : {}),
    ...(query.labelId?.length ? { assetLabels: { some: { labelId: { in: query.labelId } } } } : {}),
    ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}
