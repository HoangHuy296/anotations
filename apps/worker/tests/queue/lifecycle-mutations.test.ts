import assert from "node:assert/strict";
import test from "node:test";

import { cancelJob, claimJob, completeJob, failJob, heartbeatJob, updateJobProgress } from "../../src/jobs/job-claim-lock.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

async function claimedFixture() {
  const fixture = await createWorkerJobFixture();
  const job = await fixture.createJob();
  const claim = await claimJob(fixture.db, { jobId: job.id, workerId: "worker-current" });
  assert.equal(claim.kind, "claimed");
  return { fixture, job, token: claim.lockToken };
}

test("current token can heartbeat and update validated progress; stale inputs have no Job or event side effects", { skip: !hasIntegrationDatabase }, async () => {
  const { fixture, job, token } = await claimedFixture();
  try {
    const before = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { lockedUntil: true, lockedBy: true, lockToken: true } });
    assert.deepEqual(await heartbeatJob(fixture.db, { jobId: job.id, lockToken: token }), { kind: "updated" });
    const afterHeartbeat = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { lockedUntil: true, lockedBy: true, lockToken: true } });
    assert.ok(afterHeartbeat.lockedUntil! > before.lockedUntil!);
    assert.equal(afterHeartbeat.lockedBy, before.lockedBy);
    assert.equal(afterHeartbeat.lockToken, token);
    assert.deepEqual(await updateJobProgress(fixture.db, { jobId: job.id, lockToken: token, totalItems: 3, processedItems: 2, successItems: 2, progress: 67 }), { kind: "updated" });
    const eventCount = await fixture.db.jobEvent.count({ where: { jobId: job.id } });
    const snapshot = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { progress: true, totalItems: true, processedItems: true, lockedUntil: true } });
    assert.deepEqual(await heartbeatJob(fixture.db, { jobId: job.id, lockToken: "wrong-token" }), { kind: "refused" });
    assert.deepEqual(await updateJobProgress(fixture.db, { jobId: job.id, lockToken: token, totalItems: 1, processedItems: 2 }), { kind: "refused" });
    assert.deepEqual(await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { progress: true, totalItems: true, processedItems: true, lockedUntil: true } }), snapshot);
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: job.id } }), eventCount);
    await fixture.db.job.update({ where: { id: job.id }, data: { lockedUntil: new Date(Date.now() - 1_000) } });
    const expiredEvents = await fixture.db.jobEvent.count({ where: { jobId: job.id } });
    assert.deepEqual(await heartbeatJob(fixture.db, { jobId: job.id, lockToken: token }), { kind: "refused" });
    assert.deepEqual(await updateJobProgress(fixture.db, { jobId: job.id, lockToken: token, progress: 99 }), { kind: "refused" });
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: job.id } }), expiredEvents);
  } finally { await fixture.cleanup(); }
});

test("complete, fail, and cancellation acknowledgement require an active current token", { skip: !hasIntegrationDatabase }, async () => {
  const first = await claimedFixture();
  try {
    assert.deepEqual(await completeJob(first.fixture.db, { jobId: first.job.id, lockToken: "wrong-token" }), { kind: "refused" });
    assert.deepEqual(await completeJob(first.fixture.db, { jobId: first.job.id, lockToken: first.token }), { kind: "updated" });
    const completed = await first.fixture.db.job.findUniqueOrThrow({ where: { id: first.job.id }, select: { status: true, lockToken: true, lockedBy: true, finishedAt: true } });
    assert.deepEqual(completed.status, "COMPLETED"); assert.equal(completed.lockToken, null); assert.equal(completed.lockedBy, null); assert.ok(completed.finishedAt);
    assert.equal(await first.fixture.db.jobEvent.count({ where: { jobId: first.job.id, message: "JOB_COMPLETED" } }), 1);
  } finally { await first.fixture.cleanup(); }

  const second = await claimedFixture();
  try {
    assert.deepEqual(await failJob(second.fixture.db, { jobId: second.job.id, lockToken: "wrong-token" }), { kind: "refused" });
    assert.deepEqual(await failJob(second.fixture.db, { jobId: second.job.id, lockToken: second.token }), { kind: "updated" });
    assert.equal((await second.fixture.db.job.findUniqueOrThrow({ where: { id: second.job.id }, select: { status: true } })).status, "FAILED");
    assert.equal(await second.fixture.db.jobEvent.count({ where: { jobId: second.job.id, message: "JOB_FAILED" } }), 1);
  } finally { await second.fixture.cleanup(); }

  const third = await claimedFixture();
  try {
    assert.deepEqual(await cancelJob(third.fixture.db, { jobId: third.job.id, lockToken: third.token }), { kind: "refused" });
    await third.fixture.db.job.update({ where: { id: third.job.id }, data: { status: "CANCELING", cancelRequestedAt: new Date() } });
    assert.deepEqual(await cancelJob(third.fixture.db, { jobId: third.job.id, lockToken: "wrong-token" }), { kind: "refused" });
    assert.deepEqual(await cancelJob(third.fixture.db, { jobId: third.job.id, lockToken: third.token }), { kind: "updated" });
    const canceled = await third.fixture.db.job.findUniqueOrThrow({ where: { id: third.job.id }, select: { status: true, canceledAt: true, lockToken: true } });
    assert.equal(canceled.status, "CANCELED"); assert.ok(canceled.canceledAt); assert.equal(canceled.lockToken, null);
    assert.equal(await third.fixture.db.jobEvent.count({ where: { jobId: third.job.id, message: "JOB_CANCELED" } }), 1);
  } finally { await third.fixture.cleanup(); }

  const fourth = await claimedFixture();
  try {
    await fourth.fixture.db.job.update({ where: { id: fourth.job.id }, data: { cancelRequestedAt: new Date() } });
    assert.deepEqual(await cancelJob(fourth.fixture.db, { jobId: fourth.job.id, lockToken: fourth.token }), { kind: "updated" });
    assert.equal((await fourth.fixture.db.job.findUniqueOrThrow({ where: { id: fourth.job.id }, select: { status: true } })).status, "CANCELED");
  } finally { await fourth.fixture.cleanup(); }

  const expired = await claimedFixture();
  try {
    await expired.fixture.db.job.update({ where: { id: expired.job.id }, data: { status: "CANCELING", cancelRequestedAt: new Date(), lockedUntil: new Date(Date.now() - 1_000) } });
    const eventCount = await expired.fixture.db.jobEvent.count({ where: { jobId: expired.job.id } });
    assert.deepEqual(await cancelJob(expired.fixture.db, { jobId: expired.job.id, lockToken: expired.token }), { kind: "refused" });
    assert.equal((await expired.fixture.db.job.findUniqueOrThrow({ where: { id: expired.job.id }, select: { status: true } })).status, "CANCELING");
    assert.equal(await expired.fixture.db.jobEvent.count({ where: { jobId: expired.job.id } }), eventCount);
  } finally { await expired.fixture.cleanup(); }
});
