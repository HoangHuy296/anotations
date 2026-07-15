import { randomBytes } from "node:crypto";

import { DatasetMemberRole, JobStatus, JobType, UserRole } from "@internal/db";
import { createQueueTransport } from "@fieldframe/queue";

import { db } from "@/lib/db";

export const hasQueueIntegration = Boolean(process.env.DATABASE_URL && process.env.REDIS_HOST);

function marker(prefix: string) {
  return `${prefix}-${Date.now()}-${randomBytes(5).toString("hex")}`;
}

export async function createJobQueueFixture() {
  const suffix = marker("queue");
  const owner = await db.user.create({
    data: { email: `${suffix}-owner@phase007.test`, name: `${suffix}-owner`, role: UserRole.MANAGER },
    select: { id: true, email: true, name: true, role: true },
  });
  const labeler = await db.user.create({
    data: { email: `${suffix}-labeler@phase007.test`, name: `${suffix}-labeler`, role: UserRole.LABELER },
    select: { id: true, email: true, name: true, role: true },
  });
  const outsider = await db.user.create({
    data: { email: `${suffix}-outsider@phase007.test`, name: `${suffix}-outsider`, role: UserRole.LABELER },
    select: { id: true, email: true, name: true, role: true },
  });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `${suffix}-dataset` }, select: { id: true } });
  const otherDataset = await db.dataset.create({ data: { ownerId: outsider.id, name: `${suffix}-other-dataset` }, select: { id: true } });
  await db.datasetMember.create({ data: { datasetId: dataset.id, userId: labeler.id, role: DatasetMemberRole.LABELER } });

  return {
    owner: { ...owner, name: owner.name ?? owner.email },
    labeler: { ...labeler, name: labeler.name ?? labeler.email },
    outsider: { ...outsider, name: outsider.name ?? outsider.email },
    datasetId: dataset.id,
    otherDatasetId: otherDataset.id,
    createQueuedJob: (datasetId = dataset.id, createdById = owner.id) => db.job.create({
      data: { datasetId, createdById, type: JobType.EXPORT_DATASET, status: JobStatus.QUEUED, input: { fixture: true } },
      select: { id: true },
    }),
    cleanup: async () => {
      await db.dataset.deleteMany({ where: { id: { in: [dataset.id, otherDataset.id] } } });
      await db.user.deleteMany({ where: { id: { in: [owner.id, labeler.id, outsider.id] } } });
    },
  };
}

export function createQueueInspector() {
  const port = Number.parseInt(process.env.REDIS_PORT ?? "6379", 10);
  const queue = createQueueTransport({
    host: process.env.REDIS_HOST ?? "redis",
    port,
    password: process.env.REDIS_PASSWORD ?? "",
    prefix: process.env.BULLMQ_PREFIX ?? "annotation-platform",
  });
  return {
    find: (jobId: string) => queue.getJob(jobId),
    add: (jobId: string) => queue.add("durable-job", { jobId }, { jobId }),
    remove: async (jobId: string) => { await queue.remove(jobId).catch(() => undefined); },
    close: () => queue.close(),
  };
}
