import assert from "node:assert/strict";
import test from "node:test";

import { releaseLock, renewLock, renewOrReclaimLock } from "../../src/queue/job-lock.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

async function seedRunningLock(fixture: Awaited<ReturnType<typeof createWorkerJobFixture>>, lockedBy: string, lockToken: string, lockedUntil: Date) {
  const job = await fixture.createJob({ status: "RUNNING" });
  await fixture.db.job.update({ where: { id: job.id }, data: { lockedBy, lockToken, lockedAt: new Date(), lockedUntil } });
  return job;
}

test("two concurrent renewOrReclaimLock() calls from the same worker with the same observed token: exactly one acquires", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const observedToken = "seed-token";
    const job = await seedRunningLock(fixture, "worker-a", observedToken, new Date(Date.now() + 60_000));

    const [first, second] = await Promise.all([
      renewOrReclaimLock(fixture.db, job.id, "worker-a", observedToken),
      renewOrReclaimLock(fixture.db, job.id, "worker-a", observedToken),
    ]);

    const acquiredCount = [first, second].filter((result) => result.acquired).length;
    assert.equal(acquiredCount, 1, "exactly one concurrent call must acquire the lock");
    const refused = [first, second].find((result) => !result.acquired);
    assert.ok(refused && refused.acquired === false);

    const winner = [first, second].find((result) => result.acquired);
    assert.ok(winner && winner.acquired);
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { lockToken: true, lockedBy: true } });
    assert.equal(stored.lockToken, (winner as { acquired: true; lockToken: string }).lockToken);
    assert.notEqual(stored.lockToken, observedToken, "the winning call must rotate the token away from the stale observed value");
    assert.equal(stored.lockedBy, "worker-a");
  } finally { await fixture.cleanup(); }
});

test("a different worker cannot renew a still-valid lease it does not own", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await seedRunningLock(fixture, "worker-a", "owner-token", new Date(Date.now() + 60_000));
    const result = await renewOrReclaimLock(fixture.db, job.id, "worker-b", "owner-token");
    assert.equal(result.acquired, false, "presenting the right token from the wrong worker must still be refused");
  } finally { await fixture.cleanup(); }
});

test("an expired lease can be reclaimed by another worker, minting a new token and resetting lockedAt", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await seedRunningLock(fixture, "worker-a", "old-token", new Date(Date.now() - 1_000));
    const result = await renewOrReclaimLock(fixture.db, job.id, "worker-b", "does-not-matter");
    assert.ok(result.acquired);
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { lockedBy: true, lockToken: true, lockedAt: true, lockedUntil: true } });
    assert.equal(stored.lockedBy, "worker-b");
    assert.equal(stored.lockToken, (result as { acquired: true; lockToken: string }).lockToken);
    assert.ok(stored.lockedUntil && stored.lockedUntil.getTime() > Date.now());
  } finally { await fixture.cleanup(); }
});

test("ordinary renewal preserves lockedAt (does not reset the lease start)", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const originalLockedAt = new Date(Date.now() - 30_000);
    const job = await seedRunningLock(fixture, "worker-a", "seed-token", new Date(Date.now() + 60_000));
    await fixture.db.job.update({ where: { id: job.id }, data: { lockedAt: originalLockedAt } });

    const result = await renewOrReclaimLock(fixture.db, job.id, "worker-a", "seed-token");
    assert.ok(result.acquired);
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { lockedAt: true } });
    assert.equal(stored.lockedAt?.getTime(), originalLockedAt.getTime());
  } finally { await fixture.cleanup(); }
});

test("renewLock and releaseLock require the matching workerId, not just the token", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await seedRunningLock(fixture, "worker-a", "seed-token", new Date(Date.now() + 60_000));

    const wrongWorker = await renewLock(fixture.db, job.id, "seed-token", "worker-b", 10_000);
    assert.equal(wrongWorker.acquired, false);

    const rightWorker = await renewLock(fixture.db, job.id, "seed-token", "worker-a", 10_000);
    assert.ok(rightWorker.acquired);

    await releaseLock(fixture.db, job.id, "seed-token", "worker-b");
    const stillHeld = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { lockToken: true } });
    assert.equal(stillHeld.lockToken, "seed-token", "release by the wrong worker must be a no-op");

    await releaseLock(fixture.db, job.id, "seed-token", "worker-a");
    const released = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { lockToken: true, lockedBy: true, lockedUntil: true, heartbeatAt: true } });
    assert.equal(released.lockToken, null);
    assert.equal(released.lockedBy, null);
    assert.equal(released.lockedUntil, null);
    assert.equal(released.heartbeatAt, null);
  } finally { await fixture.cleanup(); }
});

test("renewLock rejects a non-positive extendByMs rather than corrupting the lease", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await seedRunningLock(fixture, "worker-a", "seed-token", new Date(Date.now() + 60_000));
    await assert.rejects(() => renewLock(fixture.db, job.id, "seed-token", "worker-a", 0), RangeError);
    await assert.rejects(() => renewLock(fixture.db, job.id, "seed-token", "worker-a", -5), RangeError);
  } finally { await fixture.cleanup(); }
});
