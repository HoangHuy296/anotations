import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { DatasetMemberRole, JobStatus, JobType, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { cancelAuthorizedJob } from "@/lib/jobs/authorization";
import { createJobQueueFixture, queueIntegrationSkipReason } from "./helpers";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "./http-test-server";

test("cancellation is Dataset-authorized and has no denied side effects", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  try {
    const job = await fixture.createQueuedJob();
    const eventCount = await db.jobEvent.count({ where: { jobId: job.id } });
    assert.deepEqual(await cancelAuthorizedJob(fixture.labeler, job.id), { ok: false, status: 403 });
    assert.deepEqual(await cancelAuthorizedJob(fixture.outsider, job.id), { ok: false, status: 404 });
    assert.equal(await db.jobEvent.count({ where: { jobId: job.id } }), eventCount);
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status, JobStatus.QUEUED);
  } finally { await fixture.cleanup(); }
});

test("queued and unlocked retrying Jobs become terminal CANCELED, while RUNNING receives only a request", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  try {
    const queued = await fixture.createQueuedJob();
    const retrying = await db.job.create({
      data: { datasetId: fixture.datasetId, createdById: fixture.owner.id, type: JobType.EXPORT_DATASET, status: JobStatus.RETRYING, lockedUntil: new Date(Date.now() - 1_000) },
      select: { id: true },
    });
    const running = await db.job.create({
      data: { datasetId: fixture.datasetId, createdById: fixture.owner.id, type: JobType.EXPORT_DATASET, status: JobStatus.RUNNING, lockedBy: "worker-a", lockToken: "lease", lockedUntil: new Date(Date.now() + 60_000) },
      select: { id: true },
    });
    assert.deepEqual(await cancelAuthorizedJob(fixture.owner, queued.id), { ok: true, status: 200, cancellationStatus: "CANCELED" });
    assert.deepEqual(await cancelAuthorizedJob(fixture.owner, retrying.id), { ok: true, status: 200, cancellationStatus: "CANCELED" });
    assert.deepEqual(await cancelAuthorizedJob(fixture.owner, running.id), { ok: true, status: 200, cancellationStatus: "CANCELING" });
    const [storedQueued, storedRetrying, storedRunning] = await Promise.all([queued, retrying, running].map(({ id }) => db.job.findUniqueOrThrow({ where: { id }, select: { status: true, canceledAt: true, cancelRequestedAt: true, lockToken: true } })));
    assert.equal(storedQueued.status, JobStatus.CANCELED);
    assert.equal(storedRetrying.status, JobStatus.CANCELED);
    assert.equal(storedRunning.status, JobStatus.CANCELING);
    assert.ok(storedQueued.canceledAt);
    assert.ok(storedRetrying.canceledAt);
    assert.equal(storedRunning.canceledAt, null);
    assert.ok(storedRunning.cancelRequestedAt);
    assert.equal(storedRunning.lockToken, "lease");
  } finally { await fixture.cleanup(); }
});

test("terminal and duplicate cancellation requests are conflicts with no duplicate event", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  try {
    const job = await fixture.createQueuedJob();
    assert.equal((await cancelAuthorizedJob(fixture.owner, job.id)).ok, true);
    const afterFirst = await db.jobEvent.count({ where: { jobId: job.id } });
    assert.deepEqual(await cancelAuthorizedJob(fixture.owner, job.id), { ok: false, status: 409 });
    assert.equal(await db.jobEvent.count({ where: { jobId: job.id } }), afterFirst);
  } finally { await fixture.cleanup(); }
});

test("HTTP cancel enforces owner/member boundaries and state-aware responses without denied writes", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const password = "phase-nine-cancel-password";
  const suffix = randomBytes(4).toString("hex");
  let server: Awaited<ReturnType<typeof startJobHttpServer>> | undefined;
  let reviewerId = "";
  try {
    const passwordHash = await hashPassword(password);
    await db.user.updateMany({ where: { id: { in: [fixture.owner.id, fixture.labeler.id, fixture.outsider.id] } }, data: { passwordHash } });
    const reviewer = await db.user.create({ data: { email: `reviewer-${suffix}@phase009.test`, passwordHash, role: UserRole.REVIEWER }, select: { id: true, email: true } });
    reviewerId = reviewer.id;
    await db.datasetMember.create({ data: { datasetId: fixture.datasetId, userId: reviewer.id, role: DatasetMemberRole.REVIEWER } });
    server = await startJobHttpServer(3_109);
    const [ownerCookie, labelerCookie, reviewerCookie, outsiderCookie] = await Promise.all([
      loginForJobHttp(server.baseUrl, fixture.owner.email, password), loginForJobHttp(server.baseUrl, fixture.labeler.email, password), loginForJobHttp(server.baseUrl, reviewer.email, password), loginForJobHttp(server.baseUrl, fixture.outsider.email, password),
    ]);
    const queued = await fixture.createQueuedJob();
    const eventCount = await db.jobEvent.count({ where: { jobId: queued.id } });
    assert.equal((await fetch(`${server.baseUrl}/api/jobs/${queued.id}/cancel`, { method: "POST", headers: { Cookie: labelerCookie } })).status, 403);
    assert.equal((await fetch(`${server.baseUrl}/api/jobs/${queued.id}/cancel`, { method: "POST", headers: { Cookie: reviewerCookie } })).status, 403);
    assert.equal((await fetch(`${server.baseUrl}/api/jobs/${queued.id}/cancel`, { method: "POST", headers: { Cookie: outsiderCookie } })).status, 404);
    assert.equal(await db.jobEvent.count({ where: { jobId: queued.id } }), eventCount);
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: queued.id } })).status, JobStatus.QUEUED);
    const ownerResponse = await fetch(`${server.baseUrl}/api/jobs/${queued.id}/cancel`, { method: "POST", headers: { Cookie: ownerCookie } });
    assert.equal(ownerResponse.status, 200);
    assert.deepEqual((await ownerResponse.json()).data, { id: queued.id, status: "CANCELED" });
    assert.equal((await fetch(`${server.baseUrl}/api/jobs/${queued.id}/cancel`, { method: "POST", headers: { Cookie: ownerCookie } })).status, 409);
  } finally {
    await stopJobHttpServer(server?.server);
    if (reviewerId) await db.user.deleteMany({ where: { id: reviewerId } });
    await fixture.cleanup();
  }
});
