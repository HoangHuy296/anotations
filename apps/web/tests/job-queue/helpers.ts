import { randomBytes } from "node:crypto";

import { DatasetMemberRole, JobStatus, JobType, UserRole } from "@internal/db";
import { createQueueTransport, readSafeLocalQueueTestConfig, type SafeLocalQueueTestConfig } from "@annotationplatform/queue";

import { db } from "@/lib/db";

let queueTestConfig: SafeLocalQueueTestConfig | null = null;
export let queueIntegrationSkipReason: string | undefined;

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  queueTestConfig = readSafeLocalQueueTestConfig();
} catch (error) {
  void error;
  queueIntegrationSkipReason = "full queue integration skipped: safe local Redis configuration is incomplete or violates the controlled-test policy";
  // Node's test-file reporter can hide individual skipped test reasons. Keep
  // the opt-out explicit in CI and local output without attempting a fallback.
  console.warn(queueIntegrationSkipReason);
}

export const hasQueueIntegration = queueTestConfig !== null;

function requireQueueTestConfig() {
  if (!queueTestConfig) throw new Error(queueIntegrationSkipReason);
  return queueTestConfig;
}

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
    createJob: (input: { datasetId?: string; createdById?: string; type?: JobType; status?: JobStatus } = {}) => db.job.create({
      data: { datasetId: input.datasetId ?? dataset.id, createdById: input.createdById ?? owner.id, type: input.type ?? JobType.EXPORT_DATASET, status: input.status ?? JobStatus.QUEUED, input: { fixture: true } },
      select: { id: true },
    }),
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
  const config = requireQueueTestConfig();
  const queue = createQueueTransport({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    db: config.REDIS_TEST_DB,
    prefix: config.REDIS_TEST_PREFIX,
  });
  return {
    find: (jobId: string) => queue.getJob(jobId),
    add: (jobId: string) => queue.add("durable-job", { jobId }, { jobId }),
    remove: async (jobId: string) => { await queue.remove(jobId).catch(() => undefined); },
    close: () => queue.close(),
  };
}
