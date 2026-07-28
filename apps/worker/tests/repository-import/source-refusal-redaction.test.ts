import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { routeQueueDelivery } from "../../src/queue/queue-router.js";

const enabled = Boolean(process.env.DATABASE_URL);

test("expired private source is refused before provider work with only safe durable evidence", { skip: enabled ? false : "database unavailable" }, async () => {
  const db = createWorkerDatabase(getWorkerConfig());
  const suffix = randomUUID();
  const sentinel = `phase016-secret-${suffix}`;
  try {
    const owner = await db.user.create({ data: { email: `phase016-refusal-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-refusal-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } });
    const connection = await db.sourceConnection.create({ data: { userId: owner.id, provider: "GITEA", baseUrl: "http://127.0.0.1:3100", status: "ACTIVE", tokenEncrypted: sentinel, tokenExpiresAt: new Date(Date.now() - 1_000) }, select: { id: true } });
    const job = await db.job.create({ data: { datasetId: dataset.id, createdById: owner.id, sourceConnectionId: connection.id, provider: "GITEA", type: "IMPORT_DATASET", status: "QUEUED", input: { source: { repository: { provider: "GITEA", owner: "fixture", repo: "private", ref: "main", rootPath: null, visibility: "PRIVATE" }, manifest: { itemCount: 1, declaredBytes: 1 }, sourceConnectionId: connection.id } } }, select: { id: true } });
    await routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: `phase016-refusal-${suffix}` });
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, errorCode: true, input: true, events: { select: { data: true, message: true } } } });
    assert.equal(stored.status, "FAILED");
    assert.equal(stored.errorCode, "SOURCE_TOKEN_EXPIRED");
    const serialized = JSON.stringify(stored);
    for (const forbidden of [sentinel, "tokenEncrypted", "Authorization", "DATABASE_URL", "REDIS_PASSWORD", "MINIO_SECRET_KEY"]) assert.equal(serialized.includes(forbidden), false);
    assert.equal(await db.asset.count({ where: { datasetId: dataset.id } }), 0);
    await db.dataset.delete({ where: { id: dataset.id } });
    await db.user.delete({ where: { id: owner.id } });
  } finally { await db.$disconnect(); }
});
