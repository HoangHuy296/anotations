import assert from "node:assert/strict";
import test from "node:test";

import { claimJob } from "../../src/jobs/job.repository.js";
import { GC_LOCK_KEYS, withAdvisoryLock } from "../../src/queue/gc-coordination.js";
import { recoverExpiredLeaseJobs } from "../../src/queue/stale-job-detector.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

/**
 * Spec section 20's explicit ask: with two worker identities racing the
 * same Postgres/Redis, no job is ever processed by two identities at once
 * and no destructive scheduled pass runs twice concurrently. The narrower,
 * per-mechanism concurrency tests already exist (T009's
 * `bullmq-stalled.test.ts` for real BullMQ redelivery, T018's
 * `claim-lock.test.ts` for a single claim race) — this test is the
 * cross-mechanism one spanning claim, lease-recovery, and advisory-lock
 * scanner ownership together, all against the same shared fixture.
 */

test("job claim: N jobs raced by two worker identities are each claimed by exactly one identity, never both", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const jobs = await Promise.all(Array.from({ length: 8 }, () => fixture.createJob()));

    // Every job is raced by both identities at once, interleaved across all
    // 8 jobs in one Promise.all -- not one job at a time -- so this
    // exercises real cross-job contention, not just a single serialized race.
    const attempts = await Promise.all(
      jobs.flatMap((job) => [
        claimJob(fixture.db, job.id, "worker-identity-A"),
        claimJob(fixture.db, job.id, "worker-identity-B"),
      ]),
    );

    for (let i = 0; i < jobs.length; i += 1) {
      const [claimA, claimB] = [attempts[i * 2], attempts[i * 2 + 1]];
      const winners = [claimA, claimB].filter((result) => result !== null);
      assert.equal(winners.length, 1, `job ${jobs[i]!.id} must be claimed by exactly one identity, not ${winners.length}`);
    }

    const stored = await fixture.db.job.findMany({
      where: { id: { in: jobs.map((job) => job.id) } },
      select: { id: true, status: true, lockedBy: true },
    });
    for (const row of stored) {
      assert.equal(row.status, "RUNNING");
      assert.ok(row.lockedBy === "worker-identity-A" || row.lockedBy === "worker-identity-B");
    }
  } finally { await fixture.cleanup(); }
});

test("lease recovery: two identities' recovery scans racing the same expired-lease job retry it exactly once", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({
      status: "RUNNING",
      lockedBy: "crashed-worker-identity",
      lockToken: "expired-token",
      lockedAt: new Date(Date.now() - 10 * 60_000),
      lockedUntil: new Date(Date.now() - 1_000),
      heartbeatAt: new Date(Date.now() - 10 * 60_000),
      startedAt: new Date(Date.now() - 10 * 60_000),
    });

    // Two worker replicas' scheduled recovery scans firing at the same
    // moment against the same lease-expired job. The atomic conditional
    // UPDATE inside recoverExpiredLeaseJobs (WHERE status = 'RUNNING' AND
    // lockedUntil < NOW()) means at most one of these two calls can win the
    // row; the other's own WHERE clause matches nothing.
    const [scanA, scanB] = await Promise.all([
      recoverExpiredLeaseJobs({ db: fixture.db, leaseGraceMs: 0 }),
      recoverExpiredLeaseJobs({ db: fixture.db, leaseGraceMs: 0 }),
    ]);

    assert.equal(scanA.retried + scanB.retried, 1, "exactly one of the two concurrent scans must have retried the job, never both and never neither");
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, attempts: true, lockedBy: true } });
    assert.equal(stored.status, "RETRYING");
    assert.equal(stored.attempts, 1, "attempts must be incremented exactly once, not twice, despite two concurrent recovery scans");
    assert.equal(stored.lockedBy, null);
  } finally { await fixture.cleanup(); }
});

test("scanner ownership: two identities' advisory-lock-guarded passes never run concurrently", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    let concurrentRunners = 0;
    let maxConcurrentRunners = 0;
    const runOrder: string[] = [];

    async function simulatedScanPass(identity: string) {
      concurrentRunners += 1;
      maxConcurrentRunners = Math.max(maxConcurrentRunners, concurrentRunners);
      runOrder.push(`${identity}:start`);
      // Artificial delay so both identities' attempts are guaranteed to
      // overlap in wall-clock time if the advisory lock did not serialize
      // them -- a real scan (listing a MinIO bucket) has comparable latency.
      await new Promise((resolve) => setTimeout(resolve, 200));
      runOrder.push(`${identity}:end`);
      concurrentRunners -= 1;
      return identity;
    }

    const [outcomeA, outcomeB] = await Promise.all([
      withAdvisoryLock(fixture.db, GC_LOCK_KEYS.MINIO_ORPHAN_SCAN, () => simulatedScanPass("replica-A")),
      withAdvisoryLock(fixture.db, GC_LOCK_KEYS.MINIO_ORPHAN_SCAN, () => simulatedScanPass("replica-B")),
    ]);

    const ranCount = [outcomeA, outcomeB].filter((outcome) => outcome.ran).length;
    assert.equal(ranCount, 1, "exactly one of the two concurrent identities must acquire the advisory lock and actually run the pass");
    assert.equal(maxConcurrentRunners, 1, "the two passes' bodies must never execute concurrently -- the second must wait for (and be excluded by) the first");
    // The one identity that never ran must have exited immediately (ran: false),
    // not have queued behind the lock waiting to also run -- pg_try_advisory_lock
    // is non-blocking by design (research.md decision 6: skip, don't queue).
    assert.equal(runOrder.length, 2, "only one identity's simulated pass body ever actually executed");
  } finally { await fixture.cleanup(); }
});

test("advisory-lock ownership is independent per lock key: two different scheduled passes never block each other", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const [orphanScan, tempUploadCleanup] = await Promise.all([
      withAdvisoryLock(fixture.db, GC_LOCK_KEYS.MINIO_ORPHAN_SCAN, async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return "orphan-scan-ran"; }),
      withAdvisoryLock(fixture.db, GC_LOCK_KEYS.TEMP_UPLOAD_CLEANUP, async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return "temp-upload-cleanup-ran"; }),
    ]);
    assert.equal(orphanScan.ran, true);
    assert.equal(tempUploadCleanup.ran, true);
  } finally { await fixture.cleanup(); }
});
