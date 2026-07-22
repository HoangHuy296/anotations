import assert from "node:assert/strict";
import test from "node:test";

import { processExportDataset } from "../../src/jobs/export-dataset.js";
import { cancelJob, claimJob } from "../../src/jobs/job-claim-lock.js";
import { createWorkerJobFixture } from "./helpers.js";

const enabled = process.env.EXPORT_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("expired or foreign export locks cannot mutate lifecycle or acknowledge cancellation", { skip: !enabled }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ input: { format: "JSON", manifestSchemaVersion: "1" } });
    const claim = await claimJob(fixture.db, { jobId: job.id, workerId: "lease-owner" });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;
    await fixture.db.job.update({ where: { id: job.id }, data: { lockedUntil: new Date(Date.now() - 1_000) } });
    assert.equal(await processExportDataset(fixture.db, job.id, claim.lockToken), "refused");
    assert.deepEqual(await cancelJob(fixture.db, { jobId: job.id, lockToken: "foreign-token" }), { kind: "refused" });
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, progress: true, resultStorageKey: true } });
    assert.equal(stored.status, "RUNNING");
    assert.equal(stored.progress, 0);
    assert.equal(stored.resultStorageKey, null);
  } finally { await fixture.cleanup(); }
});
