import assert from "node:assert/strict";
import test from "node:test";

import { failExpiredPreparedImports } from "../../src/queue/import-timeout-scanner.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

test("expired running IMPORT_DATASET transitions once to a safe timeout failure", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ type: "IMPORT_DATASET", status: "RUNNING" });
    await fixture.db.preparedImport.create({ data: { datasetId: fixture.datasetId, jobId: job.id, createdById: fixture.ownerId, expectedItemCount: 1, deadlineAt: new Date(Date.now() - 1_000), idempotencyKey: `timeout-${job.id}` } });
    await failExpiredPreparedImports(fixture.db);
    await failExpiredPreparedImports(fixture.db);
    const result = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, errorCode: true } });
    assert.deepEqual(result, { status: "FAILED", errorCode: "IMPORT_COMMIT_TIMEOUT" });
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: job.id, message: "JOB_FAILED" } }), 1);
  } finally { await fixture.cleanup(); }
});
