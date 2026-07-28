import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { routeQueueDelivery } from "../../src/queue/queue-router.js";
import { resolveSourceAccessForJob } from "../../src/source/source-access.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.SOURCE_CONNECTION_ENCRYPTION_KEY);
const skip = "source worker safety integration skipped: controlled PostgreSQL or encryption configuration is unavailable";

function encrypt(token: string) {
  const encoded = process.env.SOURCE_CONNECTION_ENCRYPTION_KEY;
  if (!encoded) throw new Error("missing test encryption configuration");
  const key = Buffer.from(encoded, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

test("worker projects source failures safely without copying durable secrets into JobEvents", { skip: enabled ? false : skip }, async () => {
  const db = createWorkerDatabase(getWorkerConfig());
  const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
  const sentinel = "worker-source-token-sentinel";
  try {
    const owner = await db.user.create({ data: { email: `source-job-safety-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `source-job-safety-${suffix}` }, select: { id: true } });
    const connection = await db.sourceConnection.create({
      data: {
        userId: owner.id,
        provider: "GITEA",
        authType: "TOKEN",
        baseUrl: "http://10.0.0.1",
        tokenEncrypted: encrypt(sentinel),
        status: "ACTIVE",
      },
      select: { id: true },
    });
    const job = await db.job.create({
      data: {
        datasetId: dataset.id,
        createdById: owner.id,
        sourceConnectionId: connection.id,
        type: "IMPORT_DATASET",
        status: "QUEUED",
        input: { source: { repository: { provider: "GITEA", owner: "safe-owner", repo: "safe-repository", ref: "main", rootPath: "images", visibility: "PRIVATE" }, manifest: { itemCount: 1, declaredBytes: 1 }, sourceConnectionId: connection.id } },
      },
      select: { id: true },
    });

    assert.deepEqual(await resolveSourceAccessForJob(db, job.id), { kind: "refused", errorCode: "SOURCE_URL_UNSAFE" });
    assert.deepEqual(await routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: "source-job-safety" }), { kind: "claimed", jobId: job.id });
    const persisted = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, errorCode: true, input: true } });
    assert.equal(persisted.status, "FAILED");
    assert.equal(persisted.errorCode, "SOURCE_URL_UNSAFE");
    assert.equal(JSON.stringify(persisted.input).includes(sentinel), false);
    const events = await db.jobEvent.findMany({ where: { jobId: job.id }, select: { message: true, data: true } });
    assert.ok(events.some((event) => event.message === "JOB_CLAIMED"));
    for (const event of events) {
      const serialized = JSON.stringify(event);
      for (const forbidden of [sentinel, "10.0.0.1", "tokenEncrypted", "DATABASE_URL", "REDIS_PASSWORD"]) {
        assert.equal(serialized.includes(forbidden), false, `worker event leaked ${forbidden}`);
      }
    }
  } finally {
    await db.dataset.deleteMany({ where: { name: `source-job-safety-${suffix}` } });
    await db.user.deleteMany({ where: { email: `source-job-safety-${suffix}@test.invalid` } });
    await db.$disconnect();
  }
});
