import assert from "node:assert/strict";
import test from "node:test";

import { cleanupOldJobEvents, runScheduledJobEventRetention } from "../../src/queue/jobevent-retention.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);
const RETENTION_DAYS = 30;
const now = new Date();
const old = new Date(now.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

async function createEvent(db: Awaited<ReturnType<typeof createWorkerJobFixture>>["db"], jobId: string, createdAt: Date, message = "JOB_PROGRESS") {
  return db.jobEvent.create({ data: { jobId, message, data: {}, createdAt } });
}

// Every call below passes `onlyJobIds` — the test-only narrowing this
// module's real production entry point never sets. Without it, this
// function operates on the *entire* JobEvent table by design (that is the
// correct, intended production behavior), which makes any exact-count
// assertion against a shared, non-empty database unsafe: an earlier
// version of this file asserted an unscoped global count and, on its first
// real run against the dev database, deleted 8 real pre-existing JobEvent
// rows along with its own fixture row. `onlyJobIds` closes that gap at the
// source rather than relying on every test author remembering to re-derive
// a job-scoped assertion by hand.

test("events older than the retention period are deleted only for a terminal Job", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ status: "FAILED" });
    await createEvent(fixture.db, job.id, old);
    await createEvent(fixture.db, job.id, recent);

    const result = await cleanupOldJobEvents({ db: fixture.db, retentionDays: RETENTION_DAYS, batchSize: 500, now, onlyJobIds: [job.id] });
    assert.equal(result.deleted, 1);

    const remaining = await fixture.db.jobEvent.findMany({ where: { jobId: job.id }, select: { createdAt: true } });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.createdAt.getTime(), recent.getTime());
  } finally { await fixture.cleanup(); }
});

test("events newer than the retention period are always preserved, regardless of Job state", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ status: "COMPLETED" });
    await createEvent(fixture.db, job.id, recent);
    const result = await cleanupOldJobEvents({ db: fixture.db, retentionDays: RETENTION_DAYS, batchSize: 500, now, onlyJobIds: [job.id] });
    assert.equal(result.deleted, 0);
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: job.id } }), 1);
  } finally { await fixture.cleanup(); }
});

test("events belonging to a still-active Job are never deleted, even if old", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ status: "RUNNING" });
    await createEvent(fixture.db, job.id, old);
    const result = await cleanupOldJobEvents({ db: fixture.db, retentionDays: RETENTION_DAYS, batchSize: 500, now, onlyJobIds: [job.id] });
    assert.equal(result.deleted, 0);
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: job.id } }), 1, "an active Job's events survive no matter how old");
  } finally { await fixture.cleanup(); }
});

test("cleanup processes a large backlog in bounded batches, missing nothing", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ status: "CANCELED" });
    const count = 12;
    for (let i = 0; i < count; i += 1) await createEvent(fixture.db, job.id, old, "JOB_PROGRESS");
    const result = await cleanupOldJobEvents({ db: fixture.db, retentionDays: RETENTION_DAYS, batchSize: 5, now, onlyJobIds: [job.id] });
    assert.equal(result.deleted, count);
    assert.equal(result.batches, 3, "12 rows at batchSize 5 -> 5, 5, 2 = 3 batches");
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: job.id } }), 0);
  } finally { await fixture.cleanup(); }
});

test("re-running the cleanup immediately is a safe no-op", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ status: "FAILED" });
    await createEvent(fixture.db, job.id, old);
    const first = await cleanupOldJobEvents({ db: fixture.db, retentionDays: RETENTION_DAYS, batchSize: 500, now, onlyJobIds: [job.id] });
    assert.equal(first.deleted, 1);
    const second = await cleanupOldJobEvents({ db: fixture.db, retentionDays: RETENTION_DAYS, batchSize: 500, now, onlyJobIds: [job.id] });
    assert.deepEqual(second, { deleted: 0, batches: 1, exhaustedMaxBatches: false });
  } finally { await fixture.cleanup(); }
});

test("maxBatchesPerRun caps how much a single call drains, reporting the backlog is not yet exhausted", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ status: "FAILED" });
    for (let i = 0; i < 9; i += 1) await createEvent(fixture.db, job.id, old);
    const result = await cleanupOldJobEvents({ db: fixture.db, retentionDays: RETENTION_DAYS, batchSize: 2, maxBatchesPerRun: 3, now, onlyJobIds: [job.id] });
    assert.equal(result.batches, 3);
    assert.equal(result.deleted, 6);
    assert.equal(result.exhaustedMaxBatches, true);
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: job.id } }), 3, "the remaining 3 rows wait for the next scheduled tick");
  } finally { await fixture.cleanup(); }
});

test("the scheduled entry point runs, logs, and reports its counts", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ status: "FAILED" });
    await createEvent(fixture.db, job.id, old);
    const result = await runScheduledJobEventRetention({ db: fixture.db, retentionDays: RETENTION_DAYS, batchSize: 500, onlyJobIds: [job.id] });
    assert.deepEqual(result, { ran: true, deleted: 1, batches: 1 });
  } finally { await fixture.cleanup(); }
});
