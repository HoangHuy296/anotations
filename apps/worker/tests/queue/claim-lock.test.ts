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
    const winner = [first, second].find((result) => result !== null);
    assert.ok(winner);
    assert.equal([first, second].filter((result) => result !== null).length, 1);
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, lockedBy: true, lockToken: true, lockedAt: true, lockedUntil: true, heartbeatAt: true, startedAt: true, dequeuedAt: true } });
    assert.equal(stored.status, "RUNNING");
    assert.ok(stored.lockedBy && stored.lockToken && stored.lockToken.length >= 32);
    assert.equal(stored.lockToken, winner.lockToken);
    assert.ok(stored.lockedAt && stored.lockedUntil && stored.heartbeatAt && stored.startedAt && stored.dequeuedAt);
  } finally { await fixture.cleanup(); }
});

test("active locks cannot be reclaimed", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob();
    assert.ok(await claimJob(fixture.db, job.id, "worker-a"));
    assert.equal(await claimJob(fixture.db, job.id, "worker-b"), null);
  } finally { await fixture.cleanup(); }
});

test("expired RUNNING jobs remain non-claimable until an approved recovery changes their status", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ status: "RUNNING" });
    await fixture.db.job.update({
      where: { id: job.id },
      data: {
        lockedBy: "expired-worker",
        lockToken: "expired-token",
        lockedUntil: new Date(Date.now() - 1_000),
      },
    });
    assert.equal(await claimJob(fixture.db, job.id, "replacement-worker"), null);
  } finally { await fixture.cleanup(); }
});

test("expired RETRYING lock can be reclaimed with a new lock token", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob();
    const oldToken = "old-token";
    await fixture.db.job.update({ where: { id: job.id }, data: { status: "RETRYING", lockedBy: "old-worker", lockToken: oldToken, lockedUntil: new Date(Date.now() - 1_000) } });
    const claim = await claimJob(fixture.db, job.id, "new-worker");
    assert.ok(claim);
    assert.notEqual(claim.lockToken, oldToken);
    assert.equal(claim.job.lockedBy, "new-worker");
  } finally { await fixture.cleanup(); }
});

test("reclaim preserves existing startedAt and dequeuedAt", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob();
    await fixture.db.job.update({ where: { id: job.id }, data: { status: "RETRYING", lockedUntil: new Date(Date.now() - 1_000), startedAt: new Date(1), dequeuedAt: new Date(2) } });
    assert.ok(await claimJob(fixture.db, job.id, "retry-worker"));
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { startedAt: true, dequeuedAt: true } });
    assert.equal(stored.startedAt?.getTime(), 1);
    assert.equal(stored.dequeuedAt?.getTime(), 2);
  } finally { await fixture.cleanup(); }
});

test("first claim assigns database timestamps", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const first = await fixture.createJob();
    const claim = await claimJob(fixture.db, first.id, "first-worker");
    assert.ok(claim);
    assert.ok(claim.job.startedAt);
    assert.ok(claim.job.dequeuedAt);
  } finally { await fixture.cleanup(); }
});

test("non-claimable statuses return null", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    for (const status of ["RUNNING", "COMPLETED", "FAILED", "CANCELED"] as const) {
      const job = await fixture.createJob();
      await fixture.db.job.update({ where: { id: job.id }, data: { status } });
      assert.equal(await claimJob(fixture.db, job.id, "blocked-worker"), null);
    }
  } finally { await fixture.cleanup(); }
});
