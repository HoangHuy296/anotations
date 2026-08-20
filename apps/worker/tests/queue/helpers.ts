import { createQueueTransport, readSafeLocalQueueTestConfig, type SafeLocalQueueTestConfig } from "@annotationplatform/queue";
import type { Prisma } from "../../../../lib/generated/prisma/client.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { getWorkerConfig } from "../../src/config.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

let queueTestConfig: SafeLocalQueueTestConfig | null = null;
export let workerQueueIntegrationSkipReason: string | undefined;
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  queueTestConfig = readSafeLocalQueueTestConfig();
} catch (error) {
  void error;
  workerQueueIntegrationSkipReason = "full worker queue integration skipped: safe local Redis configuration is incomplete or violates the controlled-test policy";
  console.warn(workerQueueIntegrationSkipReason);
}

export function createWorkerQueueInspector() {
  if (!queueTestConfig) throw new Error(workerQueueIntegrationSkipReason);
  const queue = createQueueTransport({
    host: queueTestConfig.REDIS_HOST,
    port: queueTestConfig.REDIS_PORT,
    password: queueTestConfig.REDIS_PASSWORD,
    db: queueTestConfig.REDIS_TEST_DB,
    prefix: queueTestConfig.REDIS_TEST_PREFIX,
  });
  return { find: (jobId: string) => queue.getJob(jobId), add: (jobId: string) => queue.add("durable-job", { jobId }, { jobId }), remove: (jobId: string) => queue.remove(jobId), close: () => queue.close() };
}

export async function createWorkerJobFixture() {
  const db = createWorkerDatabase(getWorkerConfig());
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const owner = await db.user.create({ data: { email: `worker-${suffix}@phase007.test`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `worker-${suffix}` }, select: { id: true } });
  return {
    db,
    ownerId: owner.id,
    datasetId: dataset.id,
    createJob: (data: {
      datasetId?: string;
      type?: "EXPORT_DATASET" | "IMPORT_DATASET";
      status?: "QUEUED" | "RUNNING" | "RETRYING" | "FAILED" | "COMPLETED" | "CANCELED";
      cancelRequestedAt?: Date | null;
      enqueuedAt?: Date | null;
      input?: Record<string, unknown>;
      // 021-production-hardening-garbage-collection: lease/attempt state for
      // stale-job-detector fixtures.
      lockedBy?: string | null;
      lockToken?: string | null;
      lockedAt?: Date | null;
      lockedUntil?: Date | null;
      heartbeatAt?: Date | null;
      startedAt?: Date | null;
      attempts?: number;
      maxAttempts?: number;
    } = {}) => db.job.create({
      data: {
        datasetId: data.datasetId ?? dataset.id,
        createdById: owner.id,
        type: data.type ?? "EXPORT_DATASET",
        status: data.status ?? "QUEUED",
        cancelRequestedAt: data.cancelRequestedAt ?? null,
        enqueuedAt: data.enqueuedAt ?? null,
        input: (data.input ?? {}) as Prisma.InputJsonValue,
        ...(data.lockedBy !== undefined ? { lockedBy: data.lockedBy } : {}),
        ...(data.lockToken !== undefined ? { lockToken: data.lockToken } : {}),
        ...(data.lockedAt !== undefined ? { lockedAt: data.lockedAt } : {}),
        ...(data.lockedUntil !== undefined ? { lockedUntil: data.lockedUntil } : {}),
        ...(data.heartbeatAt !== undefined ? { heartbeatAt: data.heartbeatAt } : {}),
        ...(data.startedAt !== undefined ? { startedAt: data.startedAt } : {}),
        ...(data.attempts !== undefined ? { attempts: data.attempts } : {}),
        ...(data.maxAttempts !== undefined ? { maxAttempts: data.maxAttempts } : {}),
      },
      select: { id: true },
    }),
    createArchivedDataset: () => db.dataset.create({ data: { ownerId: owner.id, name: `archived-${suffix}`, archivedAt: new Date() }, select: { id: true } }),
    cleanup: async () => {
      await db.dataset.deleteMany({ where: { ownerId: owner.id } });
      await db.user.deleteMany({ where: { id: owner.id } });
      await db.$disconnect();
    },
  };
}

export async function createExportMetadataFixture(fixture: Awaited<ReturnType<typeof createWorkerJobFixture>>) {
  const asset = await fixture.db.asset.create({
    data: {
      datasetId: fixture.datasetId, modality: "IMAGE", filename: "export.jpg", mimeType: "image/jpeg",
      sourceFingerprint: `export-${Date.now()}-${Math.random()}`, storageProvider: "MINIO", storageBucket: "private",
      storageKey: "private/source.jpg", sizeBytes: 4n, width: 2, height: 2, status: "COMPLETED",
    },
    select: { id: true },
  });
  const label = await fixture.db.label.create({
    data: { datasetId: fixture.datasetId, name: "Object", normalizedName: `object-${Date.now()}-${Math.random()}`, color: "#000000", modality: "IMAGE" },
    select: { id: true },
  });
  await fixture.db.annotation.create({
    data: {
      datasetId: fixture.datasetId, assetId: asset.id, labelId: label.id, createdById: fixture.ownerId,
      modality: "IMAGE", type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    },
  });
  return { assetId: asset.id, labelId: label.id };
}

export function createWorkerMinioInspector() {
  const config = getWorkerConfig();
  const client = createWorkerMinio(config);
  return {
    bucket: config.MINIO_BUCKET,
    stat: (key: string) => client.statObject(config.MINIO_BUCKET, key),
    read: (key: string) => client.getObject(config.MINIO_BUCKET, key),
    remove: (key: string) => client.removeObject(config.MINIO_BUCKET, key),
    list: async (prefix: string) => {
      const names: string[] = [];
      for await (const item of client.listObjectsV2(config.MINIO_BUCKET, prefix, true)) if (item.name) names.push(item.name);
      return names;
    },
  };
}
