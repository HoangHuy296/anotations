import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { createWorkerDatabase } from "../../src/providers/db.js";
import { getWorkerConfig } from "../../src/config.js";
import { runPendingJobRecovery } from "../../src/queue/recovery-scanner.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

test("recovery considers only active, queued, uncancelled, supported candidates", { skip: !hasIntegrationDatabase }, async () => {
  const db = createWorkerDatabase(getWorkerConfig());
  const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
  let ownerId = "";
  const datasetIds: string[] = [];
  try {
    const owner = await db.user.create({ data: { email: `recovery-${suffix}@phase007.test`, role: "MANAGER" }, select: { id: true } });
    ownerId = owner.id;
    const [active, archived] = await Promise.all([
      db.dataset.create({ data: { ownerId, name: `active-${suffix}` }, select: { id: true } }),
      db.dataset.create({ data: { ownerId, name: `archived-${suffix}`, archivedAt: new Date() }, select: { id: true } }),
    ]);
    datasetIds.push(active.id, archived.id);
    const [eligible, cancelled, unsupported, inactive] = await Promise.all([
      db.job.create({ data: { datasetId: active.id, createdById: ownerId, type: "EXPORT_DATASET", status: "QUEUED" } }),
      db.job.create({ data: { datasetId: active.id, createdById: ownerId, type: "EXPORT_DATASET", status: "QUEUED", cancelRequestedAt: new Date() } }),
      db.job.create({ data: { datasetId: active.id, createdById: ownerId, type: "IMPORT_DATASET", status: "QUEUED" } }),
      db.job.create({ data: { datasetId: archived.id, createdById: ownerId, type: "EXPORT_DATASET", status: "QUEUED" } }),
    ]);
    const called: string[] = [];
    const result = await runPendingJobRecovery({ db, redeliverExistingJob: async (jobId) => { called.push(jobId); return { ok: true, status: 201, deliveryPending: false }; } });
    assert.deepEqual(called, [eligible.id]);
    assert.equal(result.delivered, 1);
    assert.equal(result.skipped, 3);
    assert.ok([cancelled.id, unsupported.id, inactive.id].every((id) => !called.includes(id)));
  } finally {
    if (datasetIds.length) await db.dataset.deleteMany({ where: { id: { in: datasetIds } } });
    if (ownerId) await db.user.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  }
});
