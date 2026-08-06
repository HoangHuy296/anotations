import "server-only";

import { Prisma } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { resolveQueueName } from "@/lib/queue/queue-names";
import {
  MEDIA_PROCESSOR_VERSION,
  createMediaRequestIdentity,
  mediaProcessingRequestSchema,
  type MediaProcessingJobInput,
  type MediaProcessingJobType,
} from "@/lib/media-processing/contracts";

type SafeScheduledMediaJob = {
  id: string;
  datasetId: string;
  status: "QUEUED" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED" | "CANCELING" | "CANCELED";
  queueName: string | null;
  queueJobId: string | null;
  enqueuedAt: Date | null;
};

export type EnsureMediaProcessingJobResult =
  | { ok: true; status: 200 | 201 | 202; job: SafeScheduledMediaJob; reused: boolean; deliveryPending: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422; code: string };

function typeForModality(modality: "VIDEO" | "AUDIO"): MediaProcessingJobType {
  return modality === "VIDEO" ? "EXTRACT_VIDEO_METADATA" : "GENERATE_AUDIO_WAVEFORM";
}

function toJobInput(asset: { id: string; sourceFingerprint: string; checksum: string | null; sizeBytes: bigint | null; sourceRevision: string | null }): MediaProcessingJobInput {
  return {
    assetId: asset.id,
    processorVersion: MEDIA_PROCESSOR_VERSION,
    source: {
      sourceFingerprint: asset.sourceFingerprint,
      checksum: asset.checksum,
      sizeBytes: asset.sizeBytes?.toString() ?? null,
      sourceRevision: asset.sourceRevision,
    },
  };
}

const jobSelect = {
  id: true,
  datasetId: true,
  status: true,
  queueName: true,
  queueJobId: true,
  enqueuedAt: true,
} as const;

/**
 * Canonical per-Asset media Job boundary. The caller never supplies storage,
 * source identity, Job input, or queue data. A successful transaction commits
 * first; BullMQ receives only `{ jobId }` via `enqueueExistingJob` afterwards.
 */
export async function ensureMediaProcessingJob(actor: RequestActor, raw: unknown): Promise<EnsureMediaProcessingJobResult> {
  const request = mediaProcessingRequestSchema.safeParse(raw);
  if (!request.success) return { ok: false, status: 400, code: "MEDIA_REQUEST_INVALID" };

  const asset = await db.asset.findFirst({
    where: { id: request.data.assetId, deletedAt: null, archivedAt: null },
    select: { id: true, datasetId: true, modality: true, sourceFingerprint: true, checksum: true, sizeBytes: true, sourceRevision: true, storageProvider: true, storageBucket: true, storageKey: true },
  });
  if (!asset) return { ok: false, status: 404, code: "MEDIA_ASSET_NOT_FOUND" };
  const access = await requireDatasetPermission(actor, asset.datasetId, "asset.upload");
  if (!access || access.forbidden) return { ok: false, status: access?.forbidden ? 403 : 404, code: "MEDIA_ASSET_NOT_FOUND" };
  if ((asset.modality !== "VIDEO" && asset.modality !== "AUDIO") || request.data.type !== typeForModality(asset.modality)) {
    return { ok: false, status: 422, code: "MEDIA_ASSET_INELIGIBLE" };
  }
  if (!asset.sourceFingerprint || asset.sizeBytes === null || !asset.storageProvider || !asset.storageBucket || !asset.storageKey) {
    return { ok: false, status: 422, code: "MEDIA_SOURCE_MISSING" };
  }
  const queueName = resolveQueueName(request.data.type);
  if (!queueName) return { ok: false, status: 409, code: "MEDIA_PROCESSOR_UNAVAILABLE" };

  const input = toJobInput(asset);
  const identity = createMediaRequestIdentity({ assetId: asset.id, type: request.data.type, source: input.source });
  const idempotencyKey = `media:${identity}`;

  const findExisting = async (client: typeof db) => client.job.findUnique({
    where: { datasetId_idempotencyKey: { datasetId: asset.datasetId, idempotencyKey } },
    select: jobSelect,
  });
  let job: SafeScheduledMediaJob | null = null;
  let reused = false;
  try {
    job = await db.$transaction(async (tx) => {
      const existing = await findExisting(tx as typeof db);
      if (existing) {
        reused = true;
        return existing;
      }
      // Re-check the source immediately before creation to close the
      // schedule/source-update race without trusting the browser request.
      const current = await tx.asset.findFirst({
        where: {
          id: asset.id,
          datasetId: asset.datasetId,
          modality: asset.modality,
          sourceFingerprint: input.source.sourceFingerprint,
          checksum: input.source.checksum,
          sourceRevision: input.source.sourceRevision,
          deletedAt: null,
          archivedAt: null,
        },
        select: { id: true, sizeBytes: true },
      });
      if (!current || current.sizeBytes?.toString() !== input.source.sizeBytes) return null;
      return tx.job.create({
        data: {
          datasetId: asset.datasetId,
          createdById: actor.id,
          type: request.data.type,
          modality: asset.modality,
          status: "QUEUED",
          totalItems: 1,
          idempotencyKey,
          input,
        },
        select: jobSelect,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    job = await findExisting(db);
    reused = Boolean(job);
  }
  if (!job) return { ok: false, status: 409, code: "MEDIA_SOURCE_STALE" };
  if (reused && job.enqueuedAt) return { ok: true, status: 200, job, reused: true, deliveryPending: false };
  const delivery = await enqueueExistingJob(job.id, queueName, job);
  if (!delivery.ok) return { ok: false, status: delivery.status === 409 ? 409 : 400, code: "MEDIA_ENQUEUE_REFUSED" };
  return { ok: true, status: delivery.status, job: delivery.job, reused, deliveryPending: delivery.deliveryPending };
}
