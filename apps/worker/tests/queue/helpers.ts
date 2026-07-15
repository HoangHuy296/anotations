import { createQueueTransport } from "@fieldframe/queue";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { getWorkerConfig } from "../../src/config.js";

export function createWorkerQueueInspector() {
  const queue = createQueueTransport({
    host: process.env.REDIS_HOST ?? "redis",
    port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
    password: process.env.REDIS_PASSWORD ?? "",
    prefix: process.env.BULLMQ_PREFIX ?? "annotation-platform",
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
    createJob: (data: { datasetId?: string; type?: "EXPORT_DATASET" | "IMPORT_DATASET"; status?: "QUEUED" | "RUNNING"; cancelRequestedAt?: Date | null; enqueuedAt?: Date | null } = {}) => db.job.create({
      data: {
        datasetId: data.datasetId ?? dataset.id,
        createdById: owner.id,
        type: data.type ?? "EXPORT_DATASET",
        status: data.status ?? "QUEUED",
        cancelRequestedAt: data.cancelRequestedAt ?? null,
        enqueuedAt: data.enqueuedAt ?? null,
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
