import "server-only";
import { canResolveEmptyDataset, datasetModalityReceiptSchema, projectDatasetModality, retryModalityTransaction } from "@annotationplatform/domain";
import type { DatasetModality, DatasetModalityReceipt } from "@annotationplatform/domain";
import { Prisma } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";

type ResolutionFailure = { ok: false; code: "DATASET_NOT_FOUND" | "FORBIDDEN" | "DATASET_NOT_EMPTY" | "DATASET_MODALITY_IMMUTABLE"; status: 403 | 404 | 409 };
type ResolutionResult = { ok: true; data: DatasetModalityReceipt } | ResolutionFailure;
class ResolutionRejected extends Error {
  constructor(readonly result: ResolutionFailure) { super(result.code); }
}
function reject(code: ResolutionFailure["code"], status: ResolutionFailure["status"]): never {
  throw new ResolutionRejected({ ok: false, code, status });
}

export async function readDatasetModality(actor: RequestActor, datasetId: string, client = db) {
  return client.$transaction(async tx => {
    const currentActor = await tx.user.findUnique({ where: { id: actor.id }, select: { id: true, role: true } });
    if (!currentActor) return null;
    const access = await requireDatasetPermission({ ...actor, role: currentActor.role }, datasetId, "dataset.read", tx);
    if (!access || access.forbidden) return null;
    const dataset = await tx.dataset.findFirst({ where: { id: datasetId, deletedAt: null, archivedAt: null }, select: { id: true, name: true, modality: true, ownerId: true } });
    if (!dataset) return null;
    const groups = dataset.modality === null ? await tx.asset.groupBy({ by: ["modality"], where: { datasetId } }) : [];
    const state = projectDatasetModality(dataset.modality, groups.map(row => row.modality));
    return { id: dataset.id, name: dataset.name, ...state, canResolve: state.modalityResolution === "EMPTY_UNRESOLVED" && canResolveEmptyDataset(currentActor, dataset.ownerId) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function resolveEmptyDataset(actor: RequestActor, datasetId: string, modality: DatasetModality, client = db): Promise<ResolutionResult> {
  try {
    return await retryModalityTransaction(() => client.$transaction(async tx => {
      // Authority is checked from current persisted records in the assignment transaction.
      const dataset = await tx.dataset.findFirst({ where: { id: datasetId, deletedAt: null, archivedAt: null }, select: { id: true, ownerId: true, modality: true, modalityResolvedAt: true } });
      if (!dataset) reject("DATASET_NOT_FOUND", 404);
      const currentActor = await tx.user.findUnique({ where: { id: actor.id }, select: { id: true, role: true } });
      if (!currentActor || !canResolveEmptyDataset(currentActor, dataset.ownerId)) reject("FORBIDDEN", 403);
      if (dataset.modality !== null) {
        if (dataset.modality !== modality) reject("DATASET_MODALITY_IMMUTABLE", 409);
        return { ok: true as const, data: datasetModalityReceiptSchema.parse({ id: dataset.id, modality, modalityResolution: "RESOLVED", resolvedAt: dataset.modalityResolvedAt?.toISOString() }) };
      }
      // The approved parent fence is shared with every Asset write. G3 must prove its races.
      await tx.dataset.update({ where: { id: datasetId }, data: { modalityContentRevision: { increment: 1 } }, select: { id: true } });
      if (await tx.asset.count({ where: { datasetId } })) reject("DATASET_NOT_EMPTY", 409);
      const resolved = await tx.dataset.update({ where: { id: datasetId }, data: { modality, modalityResolverSubject: currentActor.id }, select: { id: true, modalityResolvedAt: true } });
      return { ok: true as const, data: datasetModalityReceiptSchema.parse({ id: resolved.id, modality, modalityResolution: "RESOLVED", resolvedAt: resolved.modalityResolvedAt?.toISOString() }) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    // Throwing inside the transaction rolls back the fence as well as any assignment.
    if (error instanceof ResolutionRejected) return error.result;
    throw error; // Missing schema, corrupted receipt and unexpected database faults are not conflicts.
  }
}
