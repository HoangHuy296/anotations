import "server-only";

import { randomUUID } from "node:crypto";

import { DatasetSourceMode, JobStatus, JobType, Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import type { LocalFolderPreparationDto } from "@/types/local-folder-preparation";
import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { resolveQueueName } from "@/lib/queue/queue-names";
import { canStartLocalFolderImport } from "@/lib/imports/authorization";
import { requireDatasetPermission } from "@/lib/authorization";
import type { startLocalFolderImportSchema } from "@/lib/validation/local-folder-import";
import type { z } from "zod";

const IMPORT_DEADLINE_MS = 30 * 60 * 1000;
type StartInput = z.infer<typeof startLocalFolderImportSchema>;
type AppendInput = Omit<StartInput, "name" | "description" | "modality">;

function publicPreparation(preparation: {
  id: string; datasetId: string; jobId: string; expectedItemCount: number;
  deadlineAt: Date; items: Array<{ id: string }>;
}): LocalFolderPreparationDto {
  return {
    id: preparation.id,
    datasetId: preparation.datasetId,
    jobId: preparation.jobId,
    expectedItemCount: preparation.expectedItemCount,
    deadlineAt: preparation.deadlineAt.toISOString(),
    items: preparation.items.map(({ id }) => ({ id })),
  };
}

function modalityForContentType(contentType: string): Modality {
  if (contentType.startsWith("image/")) return Modality.IMAGE;
  if (contentType.startsWith("video/")) return Modality.VIDEO;
  if (contentType.startsWith("audio/")) return Modality.AUDIO;
  return Modality.TEXT;
}

function filenameFromPath(path: string) {
  return path.replace(/\\/g, "/").split("/").at(-1) ?? "upload";
}

async function createPreparation(actor: RequestActor, input: StartInput | AppendInput, existingDatasetId: string | null) {
  const sameManifest = (existing: { expectedItemCount: number; items: Array<{ normalizedPath: string; fingerprint: string; sizeBytes: bigint; mimeType: string }> }) =>
    existing.expectedItemCount === input.items.length && existing.items.every((stored, index) => {
      const requested = input.items[index];
      return Boolean(requested) && stored.normalizedPath === requested!.logicalPath.normalize("NFKC").replace(/\\/g, "/").toLowerCase()
        && stored.fingerprint === requested!.fingerprint && stored.sizeBytes === BigInt(requested!.sizeBytes) && stored.mimeType === requested!.contentType;
    });
  const selectPreparation = { id: true, datasetId: true, jobId: true, expectedItemCount: true, deadlineAt: true, items: { select: { id: true, normalizedPath: true, fingerprint: true, sizeBytes: true, mimeType: true }, orderBy: { position: "asc" as const } } };
  const existing = await db.preparedImport.findUnique({
    where: { createdById_idempotencyKey: { createdById: actor.id, idempotencyKey: input.idempotencyKey } },
    select: { ...selectPreparation, dataset: { select: { modality: true } } },
  });
  if (existing) {
    const modalityMatches = existingDatasetId ? existing.datasetId === existingDatasetId : "modality" in input && existing.dataset.modality === input.modality;
    if (!modalityMatches || !sameManifest(existing)) return { ok: false as const, status: 409 as const, code: "IDEMPOTENCY_KEY_CONFLICT" as const };
    return { ok: true as const, status: 200 as const, preparation: publicPreparation(existing), replayed: true };
  }

  const preparedImportId = randomUUID();
  const datasetId = existingDatasetId ?? randomUUID();
  const jobId = randomUUID();
  const deadlineAt = new Date(Date.now() + IMPORT_DEADLINE_MS);
  const prepared = await db.$transaction(async (tx) => {
    const duplicate = await tx.preparedImport.findUnique({ where: { createdById_idempotencyKey: { createdById: actor.id, idempotencyKey: input.idempotencyKey } }, select: { ...selectPreparation, dataset: { select: { modality: true } } } });
    if (duplicate) {
      const modalityMatches = existingDatasetId ? duplicate.datasetId === existingDatasetId : "modality" in input && duplicate.dataset.modality === input.modality;
      if (!modalityMatches || !sameManifest(duplicate)) return { rejected: "IDEMPOTENCY_KEY_CONFLICT" as const };
      return { preparation: duplicate, replayed: true };
    }
    if (!existingDatasetId) {
      if (!("name" in input) || !("modality" in input)) throw new Error("A new Dataset import requires an explicit name and modality.");
      await tx.dataset.create({ data: { id: datasetId, ownerId: actor.id, name: input.name, description: input.description, sourceMode: DatasetSourceMode.UPLOAD, modality: input.modality, primaryModality: input.modality, modalityResolverSubject: actor.id } });
    } else {
      const dataset = await tx.dataset.findFirst({ where: { id: existingDatasetId, deletedAt: null, archivedAt: null }, select: { modality: true } });
      if (!dataset || dataset.modality === null) return { rejected: "DATASET_MODALITY_UNRESOLVED" as const };
    }
    await tx.job.create({ data: { id: jobId, datasetId, createdById: actor.id, type: JobType.IMPORT_DATASET, status: JobStatus.QUEUED, totalItems: input.items.length, input: { preparedImportId } } });
    const preparation = await tx.preparedImport.create({ data: {
      id: preparedImportId, datasetId, jobId, createdById: actor.id, expectedItemCount: input.items.length, deadlineAt, idempotencyKey: input.idempotencyKey,
      items: { create: input.items.map((item, index) => {
        const normalizedPath = item.logicalPath.normalize("NFKC").replace(/\\/g, "/").toLowerCase();
        const itemId = randomUUID();
        // Grouped by Dataset (not this one import batch) so repeated "Open
        // Directory" uploads into the same Dataset land under one shared
        // MinIO prefix. itemId is always a fresh UUID, so this never
        // collides across import batches or Datasets.
        return { id: itemId, position: index, logicalPath: item.logicalPath, normalizedPath, filename: filenameFromPath(item.logicalPath), mimeType: item.contentType, sizeBytes: BigInt(item.sizeBytes), modality: modalityForContentType(item.contentType), fingerprint: item.fingerprint, storageKey: `prepared-imports/${datasetId}/${itemId}` };
      }) },
    }, select: { id: true, datasetId: true, jobId: true, expectedItemCount: true, deadlineAt: true, items: { select: { id: true }, orderBy: { position: "asc" } } } });
    return { preparation, replayed: false };
  });
  if ("rejected" in prepared) return { ok: false as const, status: 409 as const, code: prepared.rejected };
  if (prepared.replayed) return { ok: true as const, status: 200 as const, preparation: publicPreparation(prepared.preparation), replayed: true };
  const queued = await enqueueExistingJob(jobId, resolveQueueName(JobType.IMPORT_DATASET) ?? undefined);
  return { ok: true as const, status: queued.status === 201 ? 201 as const : 202 as const, preparation: publicPreparation(prepared.preparation), replayed: false, deliveryPending: queued.deliveryPending };
}

export async function prepareLocalFolderImport(actor: RequestActor, input: StartInput) {
  if (!canStartLocalFolderImport(actor)) return { ok: false as const, status: 403 as const };
  return createPreparation(actor, input, null);
}

/** Creates another upload batch for an already authorized Dataset. */
export async function prepareDatasetAppendImport(actor: RequestActor, datasetId: string, input: AppendInput) {
  const access = await requireDatasetPermission(actor, datasetId, "asset.upload");
  if (!access || access.forbidden) return { ok: false as const, status: access?.forbidden ? 403 as const : 404 as const };
  const dataset = await db.dataset.findFirst({ where: { id: access.dataset.id, deletedAt: null, archivedAt: null }, select: { modality: true } });
  if (!dataset || dataset.modality === null) return { ok: false as const, status: 409 as const, code: "DATASET_MODALITY_UNRESOLVED" as const };
  return createPreparation(actor, input, access.dataset.id);
}
