import assert from "node:assert/strict";
import test from "node:test";

import { failRunawayJobs, recoverExpiredLeaseJobs } from "../../src/queue/stale-job-detector.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);
const LEASE_GRACE_MS = 60_000;
const MAX_RUNTIME_MS = 60 * 60_000;

test("a job whose lease is still valid is left untouched", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const future = new Date(Date.now() + 5 * 60_000);
    const job = await fixture.createJob({
      status: "RUNNING", lockedBy: "worker-a", lockToken: "token-a",
      lockedAt: new Date(), lockedUntil: future, heartbeatAt: new Date(), startedAt: new Date(),
      attempts: 0, maxAttempts: 3,
    });
    // The scan is global (a production recovery pass has no per-test dataset
    // scope), so a shared test database may have unrelated stale-lease
    // candidates left by other suites — assert on this specific Job's own
    // row, not on the scan's aggregate counts.
    await recoverExpiredLeaseJobs({ db: fixture.db, leaseGraceMs: LEASE_GRACE_MS });
    const after = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, attempts: true, lockedBy: true } });
    assert.deepEqual(after, { status: "RUNNING", attempts: 0, lockedBy: "worker-a" });
  } finally { await fixture.cleanup(); }
});

test("an expired lease under the retry budget is retried in place, not replaced by a new Job", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const past = new Date(Date.now() - 10 * 60_000);
    const job = await fixture.createJob({
      status: "RUNNING", lockedBy: "worker-a", lockToken: "token-a",
      lockedAt: past, lockedUntil: past, heartbeatAt: past, startedAt: past,
      attempts: 1, maxAttempts: 3,
    });
    const result = await recoverExpiredLeaseJobs({ db: fixture.db, leaseGraceMs: LEASE_GRACE_MS });
    assert.equal(result.retried, 1);
    assert.equal(result.deadLettered, 0);
    const after = await fixture.db.job.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true, attempts: true, lockedBy: true, lockToken: true, lockedUntil: true, enqueuedAt: true, queueName: true, queueJobId: true, retryOfJobId: true },
    });
    assert.equal(after.status, "RETRYING");
    assert.equal(after.attempts, 2, "the same Job row's attempts counter increments; no successor Job is created");
    assert.equal(after.lockedBy, null);
    assert.equal(after.lockToken, null);
    assert.equal(after.lockedUntil, null);
    assert.equal(after.enqueuedAt, null, "cleared so the (scheduled) recovery scanner can redeliver it");
    assert.equal(after.queueName, null);
    assert.equal(after.queueJobId, null);
    assert.equal(after.retryOfJobId, null, "in-place recovery never sets retry lineage — that is the separate, user-authorized retry flow");
    assert.equal(await fixture.db.job.count({ where: { datasetId: fixture.datasetId } }), 1, "no duplicate Job was created");
    const events = await fixture.db.jobEvent.findMany({ where: { jobId: job.id }, select: { message: true, data: true } });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.message, "JOB_RECOVERED");
    assert.equal((events[0]!.data as { reason?: string }).reason, "LEASE_EXPIRED");
  } finally { await fixture.cleanup(); }
});

test("an expired lease at the retry budget is dead-lettered, never silently deleted", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const past = new Date(Date.now() - 10 * 60_000);
    const job = await fixture.createJob({
      status: "RUNNING", lockedBy: "worker-a", lockToken: "token-a",
      lockedAt: past, lockedUntil: past, heartbeatAt: past, startedAt: past,
      attempts: 3, maxAttempts: 3,
    });
    const result = await recoverExpiredLeaseJobs({ db: fixture.db, leaseGraceMs: LEASE_GRACE_MS });
    assert.equal(result.retried, 0);
    assert.equal(result.deadLettered, 1);
    const after = await fixture.db.job.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true, attempts: true, errorCode: true, finishedAt: true, lockedBy: true },
    });
    assert.equal(after.status, "FAILED");
    assert.equal(after.attempts, 3, "the retry budget itself is not incremented past its own ceiling");
    assert.equal(after.errorCode, "RECOVERY_EXHAUSTED");
    assert.ok(after.finishedAt);
    assert.equal(after.lockedBy, null);
    const events = await fixture.db.jobEvent.findMany({ where: { jobId: job.id }, select: { message: true, data: true } });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.message, "JOB_DEAD_LETTERED");
    assert.equal((events[0]!.data as { reason?: string }).reason, "RECOVERY_EXHAUSTED");
  } finally { await fixture.cleanup(); }
});

test("running the scan again on an already-recovered Job is a no-op", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const past = new Date(Date.now() - 10 * 60_000);
    const job = await fixture.createJob({
      status: "RUNNING", lockedBy: "worker-a", lockToken: "token-a",
      lockedAt: past, lockedUntil: past, heartbeatAt: past, startedAt: past,
      attempts: 0, maxAttempts: 3,
    });
    // The scan is global — assert on this specific Job's own state/events
    // rather than the scan's aggregate counts, which a shared test database
    // can contaminate with other suites' leftover candidates.
    await recoverExpiredLeaseJobs({ db: fixture.db, leaseGraceMs: LEASE_GRACE_MS });
    const afterFirst = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, attempts: true } });
    assert.deepEqual(afterFirst, { status: "RETRYING", attempts: 1 });
    await recoverExpiredLeaseJobs({ db: fixture.db, leaseGraceMs: LEASE_GRACE_MS });
    const afterSecond = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, attempts: true } });
    assert.deepEqual(afterSecond, { status: "RETRYING", attempts: 1 }, "the second pass does not touch a Job that is no longer RUNNING");
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: job.id, message: "JOB_RECOVERED" } }), 1, "no duplicate recovery event on the second pass");
  } finally { await fixture.cleanup(); }
});

test("two concurrent scan passes racing the same expired-lease Job leave exactly one winner", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const past = new Date(Date.now() - 10 * 60_000);
    const job = await fixture.createJob({
      status: "RUNNING", lockedBy: "worker-a", lockToken: "token-a",
      lockedAt: past, lockedUntil: past, heartbeatAt: past, startedAt: past,
      attempts: 0, maxAttempts: 3,
    });
    const [a, b] = await Promise.all([
      recoverExpiredLeaseJobs({ db: fixture.db, leaseGraceMs: LEASE_GRACE_MS }),
      recoverExpiredLeaseJobs({ db: fixture.db, leaseGraceMs: LEASE_GRACE_MS }),
    ]);
    const totalActed = a.retried + a.deadLettered + b.retried + b.deadLettered;
    assert.equal(totalActed, 1, "exactly one of the two concurrent scans — simulating two worker replicas' scheduled passes firing at once — wins the race");
    const after = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { attempts: true, status: true } });
    assert.equal(after.attempts, 1, "the Job is retried exactly once, never processed twice by the race");
    assert.equal(after.status, "RETRYING");
  } finally { await fixture.cleanup(); }
});

test("a RUNNING Job past its maximum allowed runtime is failed/retried even while its lease is still valid", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const wayInThePast = new Date(Date.now() - (MAX_RUNTIME_MS + 10 * 60_000));
    const stillValidLease = new Date(Date.now() + 5 * 60_000);
    const job = await fixture.createJob({
      status: "RUNNING", lockedBy: "worker-a", lockToken: "token-a",
      lockedAt: wayInThePast, lockedUntil: stillValidLease, heartbeatAt: new Date(), startedAt: wayInThePast,
      attempts: 0, maxAttempts: 3,
    });
    const result = await failRunawayJobs({ db: fixture.db, maxRuntimeMs: MAX_RUNTIME_MS });
    assert.equal(result.retried, 1);
    const after = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, attempts: true, lockedBy: true } });
    assert.equal(after.status, "RETRYING");
    assert.equal(after.attempts, 1);
    assert.equal(after.lockedBy, null, "the original owner's lease/token is cleared, so its own stale completion attempt will safely no-op");
    const events = await fixture.db.jobEvent.findMany({ where: { jobId: job.id }, select: { message: true, data: true } });
    assert.equal(events[0]!.message, "JOB_RECOVERED");
    assert.equal((events[0]!.data as { reason?: string }).reason, "MAX_RUNTIME_EXCEEDED");
  } finally { await fixture.cleanup(); }
});

test("a RUNNING Job well within its maximum allowed runtime is left untouched by the runaway detector", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const justStarted = new Date();
    const job = await fixture.createJob({
      status: "RUNNING", lockedBy: "worker-a", lockToken: "token-a",
      lockedAt: justStarted, lockedUntil: new Date(Date.now() + 5 * 60_000), heartbeatAt: justStarted, startedAt: justStarted,
      attempts: 0, maxAttempts: 3,
    });
    const result = await failRunawayJobs({ db: fixture.db, maxRuntimeMs: MAX_RUNTIME_MS });
    assert.equal(result.retried, 0);
    assert.equal(result.deadLettered, 0);
    const after = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } });
    assert.equal(after.status, "RUNNING");
  } finally { await fixture.cleanup(); }
});
