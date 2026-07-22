import assert from "node:assert/strict";
import test from "node:test";

import { cancelJob, claimJob, heartbeatJob } from "../../src/jobs/job-claim-lock.js";
import { createWorkerJobFixture } from "./helpers.js";

test("IMPORT_DATASET keeps the normal current-lease heartbeat and cancellation rules", { skip: !process.env.DATABASE_URL }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ type: "IMPORT_DATASET" });
    const claimed = await claimJob(fixture.db, { jobId: job.id, workerId: "import-worker" });
    assert.equal(claimed.kind, "claimed");
    if (claimed.kind !== "claimed") return;
    assert.deepEqual(await heartbeatJob(fixture.db, { jobId: job.id, lockToken: claimed.lockToken }), { kind: "updated" });
    await fixture.db.job.update({ where: { id: job.id }, data: { status: "CANCELING", cancelRequestedAt: new Date() } });
    assert.deepEqual(await cancelJob(fixture.db, { jobId: job.id, lockToken: claimed.lockToken }), { kind: "updated" });
    assert.equal((await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } })).status, "CANCELED");
  } finally { await fixture.cleanup(); }
});
