import assert from "node:assert/strict";
import test from "node:test";

import { claimJob } from "../../src/jobs/job.repository.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

test("concurrent queued claims produce exactly one ClaimedJob", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob();
    const [first, second] = await Promise.all([
      claimJob(fixture.db, job.id, "worker-one"),
      claimJob(fixture.db, job.id, "worker-two"),
    ]);
    assert.equal([first, second].filter((result) => result !== null).length, 1);
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, lockedBy: true, lockToken: true, lockedAt: true, lockedUntil: true, heartbeatAt: true, startedAt: true, dequeuedAt: true } });
    assert.equal(stored.status, "RUNNING");
    assert.ok(stored.lockedBy && stored.lockToken && stored.lockToken.length >= 32);
    assert.ok(stored.lockedAt && stored.lockedUntil && stored.heartbeatAt && stored.startedAt && stored.dequeuedAt);
  } finally { await fixture.cleanup(); }
});

test("active locks cannot be reclaimed, expired retrying locks can, and timestamps are preserved", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const retrying = await fixture.createJob();
    await fixture.db.job.update({ where: { id: retrying.id }, data: { status: "RETRYING", lockedUntil: new Date(Date.now() - 1_000), startedAt: new Date(1), dequeuedAt: new Date(2) } });
    const oldToken = "old-token";
    await fixture.db.job.update({ where: { id: retrying.id }, data: { lockToken: oldToken, lockedBy: "old-worker" } });
    const retryClaim = await claimJob(fixture.db, retrying.id, "retry-worker");
    assert.ok(retryClaim);
    assert.notEqual(retryClaim.lockToken, oldToken);
    assert.equal(retryClaim.job.lockedBy, "retry-worker");
    const preserved = await fixture.db.job.findUniqueOrThrow({ where: { id: retrying.id }, select: { startedAt: true, dequeuedAt: true } });
    assert.equal(preserved.startedAt?.getTime(), 1);
    assert.equal(preserved.dequeuedAt?.getTime(), 2);

    const running = await fixture.createJob({ status: "RUNNING" });
    await fixture.db.job.update({ where: { id: running.id }, data: { lockedBy: "old", lockToken: "old-token", lockedUntil: new Date(Date.now() - 1_000) } });
    assert.equal(await claimJob(fixture.db, running.id, "new-worker"), null);
    const unchanged = await fixture.db.job.findUniqueOrThrow({ where: { id: running.id }, select: { status: true, lockedBy: true, lockToken: true } });
    assert.deepEqual(unchanged, { status: "RUNNING", lockedBy: "old", lockToken: "old-token" });

    const [canceling, completed] = await Promise.all([fixture.createJob(), fixture.createJob()]);
    await Promise.all([
      fixture.db.job.update({ where: { id: canceling.id }, data: { status: "CANCELING", cancelRequestedAt: new Date() } }),
      fixture.db.job.update({ where: { id: completed.id }, data: { status: "COMPLETED", finishedAt: new Date() } }),
    ]);
    assert.equal(await claimJob(fixture.db, canceling.id, "new-worker"), null);
    assert.equal(await claimJob(fixture.db, completed.id, "new-worker"), null);
  } finally { await fixture.cleanup(); }
});

test("first claim assigns database timestamps and terminal Jobs are not claimable", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const first = await fixture.createJob();
    const claim = await claimJob(fixture.db, first.id, "first-worker");
    assert.ok(claim);
    assert.ok(claim.job.startedAt);
    assert.ok(claim.job.dequeuedAt);

    for (const status of ["RUNNING", "COMPLETED", "FAILED", "CANCELED"] as const) {
      const job = await fixture.createJob();
      await fixture.db.job.update({ where: { id: job.id }, data: { status } });
      assert.equal(await claimJob(fixture.db, job.id, "blocked-worker"), null);
    }
  } finally { await fixture.cleanup(); }
});
