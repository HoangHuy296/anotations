import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createQueueTransport } from "@fieldframe/queue";

import { getWorkerConfig } from "../../src/config.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.TWO_WORKER_COMPOSE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const prefix = process.env.BULLMQ_PREFIX;

async function waitForTerminal(db: ReturnType<typeof createWorkerDatabase>, jobId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, errorCode: true } });
    if (["COMPLETED", "FAILED", "CANCELED"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Two worker Compose delivery did not become terminal.");
}

async function resetFixtureCounter() { await fetch("http://127.0.0.1:18080/__test/reset", { method: "POST" }); }
async function fixtureCounter() {
  const response = await fetch("http://127.0.0.1:18080/__test/counter");
  return response.json() as Promise<{ requests: number; paths: Record<string, number> }>;
}

test("two actual worker containers accept duplicate { jobId } delivery exactly once", { skip: enabled && prefix ? false : "explicit isolated two-worker Compose runtime required" }, async () => {
  const config = getWorkerConfig(); const db = createWorkerDatabase(config); const suffix = randomUUID();
  const queue = createQueueTransport({ host: "127.0.0.1", port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, prefix: config.BULLMQ_PREFIX });
  let datasetId: string | null = null; let objectKey: string | null = null; let jobId: string | null = null;
  try {
    await resetFixtureCounter();
    const owner = await db.user.create({ data: { email: `phase016-two-worker-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-two-worker-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } }); datasetId = dataset.id;
    const job = await db.job.create({ data: {
      datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "QUEUED", provider: "GITHUB", totalItems: 1,
      input: { source: { repository: { provider: "GITHUB", owner: "fixture", repo: "public-images", ref: "main", rootPath: "images", visibility: "PUBLIC" }, manifest: { itemCount: 1, declaredBytes: 12 }, sourceConnectionId: null } },
    }, select: { id: true } }); jobId = job.id;
    await Promise.all([
      queue.add("durable-job", { jobId: job.id }, { jobId: `${job.id}-delivery-a` }),
      queue.add("durable-job", { jobId: job.id }, { jobId: `${job.id}-delivery-b` }),
    ]);
    const terminal = await waitForTerminal(db, job.id);
    assert.equal(terminal.status, "COMPLETED", `safe worker error code: ${terminal.errorCode ?? "none"}`);
    const [assets, claimed, completed, counter] = await Promise.all([
      db.asset.findMany({ where: { datasetId: dataset.id }, select: { id: true, storageKey: true, imageAsset: { select: { id: true } }, versions: { select: { id: true } } } }),
      db.jobEvent.count({ where: { jobId: job.id, message: "JOB_CLAIMED" } }),
      db.jobEvent.count({ where: { jobId: job.id, message: "JOB_COMPLETED" } }),
      fixtureCounter(),
    ]);
    assert.equal(assets.length, 1); assert.ok(assets[0]?.imageAsset && assets[0].storageKey); objectKey = assets[0]!.storageKey;
    assert.equal(assets[0]!.versions.length, 0); assert.equal(claimed, 1); assert.equal(completed, 1);
    // One tree and one raw request prove the loser did not contact the provider.
    assert.equal(counter.requests, 2); await createWorkerMinio(config).statObject(config.MINIO_BUCKET, objectKey);
  } finally {
    if (jobId) await Promise.all([queue.remove(`${jobId}-delivery-a`).catch(() => undefined), queue.remove(`${jobId}-delivery-b`).catch(() => undefined)]);
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    if (objectKey) await createWorkerMinio(config).removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined);
    await queue.close(); await db.$disconnect();
  }
});
