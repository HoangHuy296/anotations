import "../../../../scripts/db-safety/test-entry.cjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { getWorkerConfig } from "../../src/config.js";
import { claimJob, completeJob, failJob, updateJobProgress } from "../../src/jobs/job-claim-lock.js";

test("repository terminal accounting is strict, lease-bound, persisted and replay-safe", async () => {
  const db = createWorkerDatabase(getWorkerConfig());
  const ownerId = "g2-owner";
  const dataset = await db.dataset.create({ data: { ownerId, name: "G4 accounting", modality: "IMAGE", modalityResolverSubject: ownerId } });
  async function running() {
    const job = await db.job.create({ data: { datasetId: dataset.id, createdById: ownerId, type: "IMPORT_DATASET", status: "QUEUED" } });
    const claim = await claimJob(db, { jobId: job.id, workerId: "g4-accounting" });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") throw Error("Fixture claim refused");
    return { jobId: job.id, lockToken: claim.lockToken };
  }
  const project = async (id: string) => db.job.findUniqueOrThrow({ where: { id }, select: {
    id: true, status: true, stage: true, errorCode: true, summary: true,
    totalItems: true, processedItems: true, successItems: true, failedItems: true, skippedItems: true,
    lockToken: true, lockedUntil: true, finishedAt: true,
    events: { select: { id: true, message: true }, orderBy: { createdAt: "asc" } },
  } });
  try {
    const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: "IMAGE", filename: "one.png", mimeType: "image/png", sourceFingerprint: randomUUID() } });
    for (const [name, accepted, unchanged, rejected, retryable] of [
      ["success", 1, 0, 0, 0], ["unchanged-replay", 0, 1, 0, 0],
      ["partial", 1, 0, 1, 0], ["zero-success", 0, 0, 1, 0], ["retryable", 0, 0, 0, 1],
    ] as const) {
      const ref = await running();
      const counts = { totalItems: accepted + unchanged + rejected + retryable, processedItems: accepted + unchanged + rejected + retryable, successItems: accepted + unchanged, failedItems: rejected + retryable, skippedItems: 0 };
      assert.equal((await updateJobProgress(db, { ...ref, stage: "SCANNING_FILES", progress: 1, totalItems: counts.totalItems, processedItems: 0 })).kind, "updated");
      const incomplete = rejected + retryable > 0;
      const summary = { outcome: incomplete ? "incomplete" : "completed", accepted, unchanged, rejected, retryable, skipped: 0, unprocessed: 0 };
      const payload = { ...ref, ...counts, stage: "FINISHED", progress: 100, summary: incomplete ? summary : { ...summary, resultCount: accepted + unchanged }, ...(incomplete ? { errorCode: "IMPORT_INCOMPLETE" } : {}) };
      if (incomplete) assert.equal((await updateJobProgress(db, { ...ref, ...counts, stage: "WRITING_ASSETS", progress: 100 })).kind, "updated");
      const mutate = incomplete ? failJob : completeJob;
      assert.equal((await mutate(db, payload)).kind, "updated");
      const first = await project(ref.jobId);
      assert.equal(first.status, incomplete ? "FAILED" : "COMPLETED");
      assert.equal(first.stage, "FINISHED");
      assert.deepEqual(first.summary, payload.summary);
      for (const key of ["totalItems", "processedItems", "successItems", "failedItems", "skippedItems"] as const) assert.equal(first[key], counts[key]);
      assert.equal(first.errorCode, incomplete ? "IMPORT_INCOMPLETE" : null);
      assert.equal(first.lockToken, null); assert.equal(first.lockedUntil, null); assert.ok(first.finishedAt);
      const terminal = incomplete ? "JOB_FAILED" : "JOB_COMPLETED";
      assert.equal(first.events.filter(event => event.message === terminal).length, 1);
      assert.equal((await mutate(db, payload)).kind, "refused");
      assert.deepEqual(await project(ref.jobId), first, "terminal replay creates no additional state/event");
      assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).datasetId, dataset.id);
      console.log("G4_ACCOUNTING_RECEIPT " + JSON.stringify({ name, ...first }));
    }
    const ref = await running();
    const valid = { ...ref, stage: "FINISHED", progress: 100, totalItems: 1, processedItems: 1, successItems: 1, failedItems: 0, skippedItems: 0,
      summary: { outcome: "completed", resultCount: 1, accepted: 1, unchanged: 0, rejected: 0, retryable: 0, skipped: 0, unprocessed: 0 } };
    const before = await project(ref.jobId);
    for (const bad of [
      { ...valid, summary: { ...valid.summary, arbitrary: true } },
      { ...valid, summary: { ...valid.summary, accepted: -1 } },
      { ...valid, totalItems: 2_147_483_648, processedItems: 2_147_483_648, successItems: 2_147_483_648, summary: { ...valid.summary, accepted: 2_147_483_648, resultCount: 2_147_483_648 } },
      { ...valid, summary: { ...valid.summary, resultCount: 2 } },
      { ...valid, summary: { ...valid.summary, rejected: 1 } },
      { ...valid, summary: { outcome: "completed", accepted: 1 } },
      { ...valid, totalItems: 2 }, { ...valid, failedItems: 1 }, { ...valid, stage: "UNREGISTERED" },
      { ...valid, stage: undefined }, { ...valid, progress: undefined }, { ...valid, progress: 0 },
    ]) {
      assert.equal((await completeJob(db, bad)).kind, "refused");
      assert.deepEqual(await project(ref.jobId), before);
    }
    assert.equal((await updateJobProgress(db, { ...ref, stage: "FINISHED", progress: 100 })).kind, "refused");
    assert.equal((await failJob(db, { ...valid, errorCode: "IMPORT_INCOMPLETE", summary: { ...valid.summary, outcome: "incomplete" } })).kind, "refused");
    assert.deepEqual(await project(ref.jobId), before);
    assert.equal((await completeJob(db, valid)).kind, "updated", "valid payload terminalizes after rejected malformed attempts");
    const incomplete = await running();
    const failure = { ...incomplete, stage: "FINISHED", progress: 100, errorCode: "IMPORT_INCOMPLETE", totalItems: 1, processedItems: 1, successItems: 0, failedItems: 1, skippedItems: 0,
      summary: { outcome: "incomplete", accepted: 0, unchanged: 0, rejected: 1, retryable: 0, skipped: 0, unprocessed: 0 } };
    const untouched = await project(incomplete.jobId);
    for (const bad of [
      { ...failure, summary: { ...failure.summary, arbitrary: true } },
      { ...failure, summary: { ...failure.summary, rejected: -1 } },
      { ...failure, summary: { ...failure.summary, rejected: 0 } },
      { ...failure, summary: { ...failure.summary, accepted: 1 } },
      { ...failure, failedItems: 0 }, { ...failure, stage: "WRITING_ASSETS" },
    ]) {
      assert.equal((await failJob(db, bad)).kind, "refused");
      assert.deepEqual(await project(incomplete.jobId), untouched);
    }
    assert.equal((await failJob(db, failure)).kind, "updated");
    for (const unprocessed of [0, 1]) {
      const item = await running();
      const skipped = unprocessed === 0 ? 1 : 0;
      const result = await failJob(db, { ...item, stage: "FINISHED", progress: 100, errorCode: "IMPORT_INCOMPLETE", totalItems: 1, processedItems: skipped, successItems: 0, failedItems: 0, skippedItems: skipped,
        summary: { outcome: "incomplete", accepted: 0, unchanged: 0, rejected: 0, retryable: 0, skipped, unprocessed } });
      assert.equal(result.kind, "updated");
    }
    const legacy = await running();
    assert.equal((await completeJob(db, { ...legacy, stage: "FINISHED", summary: { outcome: "completed", resultCount: 0 } })).kind, "updated", "existing non-repository summary remains supported");
    const legacyFailure = await running();
    assert.equal((await failJob(db, legacyFailure)).kind, "updated", "basic-reference failures preserve the existing contract");
  } finally {
    await db.dataset.delete({ where: { id: dataset.id } });
    await db.$disconnect();
  }
});
