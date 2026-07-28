import assert from "node:assert/strict";
import test from "node:test";

import { JobStatus, JobType } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { retryAuthorizedJob } from "@/lib/jobs/retry-job";
import { createJobQueueFixture, createQueueInspector, queueIntegrationSkipReason } from "./helpers";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "./http-test-server";

async function createFailedJob(datasetId: string, createdById: string, type: JobType = JobType.EXPORT_DATASET) {
  return db.job.create({
    data: {
      datasetId, createdById, type, status: JobStatus.FAILED,
      input: { credential: "must-not-copy" }, state: { internal: "must-not-copy" }, error: "must-not-copy",
    },
    select: { id: true },
  });
}

async function createFailedRepositoryImportJob(datasetId: string, createdById: string) {
  return db.job.create({
    data: {
      datasetId,
      createdById,
      type: JobType.IMPORT_DATASET,
      status: JobStatus.FAILED,
      input: {
        source: {
          repository: { provider: "GITHUB", owner: "fixture", repo: "public-images", ref: "main", rootPath: null, visibility: "PUBLIC" },
          manifest: { itemCount: 1, declaredBytes: 12 },
          sourceConnectionId: null,
        },
      },
    },
    select: { id: true },
  });
}

test("retry creates one successor without copying raw original input or changing failed history", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  try {
    const original = await createFailedJob(fixture.datasetId, fixture.owner.id);
    const result = await retryAuthorizedJob(fixture.owner, original.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, 201);
    const [storedOriginal, successor] = await Promise.all([
      db.job.findUniqueOrThrow({ where: { id: original.id }, select: { status: true, retrySuccessor: { select: { id: true } } } }),
      db.job.findUniqueOrThrow({ where: { id: result.job.id }, select: { retryOfJobId: true, status: true, trigger: true, input: true, state: true, error: true } }),
    ]);
    assert.equal(storedOriginal.status, JobStatus.FAILED);
    assert.equal(storedOriginal.retrySuccessor?.id, result.job.id);
    assert.equal(successor.retryOfJobId, original.id);
    assert.equal(successor.status, JobStatus.QUEUED);
    assert.equal(successor.trigger, "RETRY");
    assert.deepEqual(successor.input, { format: "JSON", manifestSchemaVersion: "1" });
    assert.deepEqual(successor.state, {});
    assert.equal(successor.error, null);
  } finally { await fixture.cleanup(); }
});

test("concurrent retry returns one direct successor", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const inspector = createQueueInspector();
  try {
    const original = await createFailedJob(fixture.datasetId, fixture.owner.id);
    const [a, b] = await Promise.all([retryAuthorizedJob(fixture.owner, original.id), retryAuthorizedJob(fixture.owner, original.id)]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(new Set([a.job.id, b.job.id]).size, 1);
    assert.deepEqual(new Set([a.status, b.status]), new Set([200, 201]));
    assert.equal(await db.job.count({ where: { retryOfJobId: original.id } }), 1);
    const successor = await db.job.findUniqueOrThrow({ where: { id: a.job.id }, select: { queueJobId: true, enqueuedAt: true } });
    assert.equal(successor.queueJobId, a.job.id);
    assert.ok(successor.enqueuedAt);
    const delivery = await inspector.find(a.job.id);
    assert.ok(delivery);
    assert.deepEqual(delivery.data, { jobId: a.job.id });
  } finally { await inspector.close(); await fixture.cleanup(); }
});

test("retry conceals non-members, forbids labelers, and rejects unsupported or non-failed Jobs without a successor", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  try {
    const original = await createFailedJob(fixture.datasetId, fixture.owner.id);
    assert.deepEqual(await retryAuthorizedJob(fixture.labeler, original.id), { ok: false, status: 403 });
    assert.deepEqual(await retryAuthorizedJob(fixture.outsider, original.id), { ok: false, status: 404 });
    const unsupported = await createFailedJob(fixture.datasetId, fixture.owner.id, JobType.AI_TASK_SYNC);
    assert.deepEqual(await retryAuthorizedJob(fixture.owner, unsupported.id), { ok: false, status: 409 });
    const queued = await fixture.createQueuedJob();
    assert.deepEqual(await retryAuthorizedJob(fixture.owner, queued.id), { ok: false, status: 409 });
    assert.equal(await db.job.count({ where: { retryOfJobId: { in: [original.id, unsupported.id, queued.id] } } }), 0);
  } finally { await fixture.cleanup(); }
});

test("retry creates one safe IMPORT_DATASET successor without copying raw state", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  try {
    const original = await createFailedRepositoryImportJob(fixture.datasetId, fixture.owner.id);
    const result = await retryAuthorizedJob(fixture.owner, original.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const successor = await db.job.findUniqueOrThrow({ where: { id: result.job.id }, select: { retryOfJobId: true, type: true, input: true, sourceConnectionId: true } });
    assert.equal(successor.retryOfJobId, original.id);
    assert.equal(successor.type, JobType.IMPORT_DATASET);
    assert.equal(successor.sourceConnectionId, null);
    assert.deepEqual(successor.input, {
      source: {
        repository: { provider: "GITHUB", owner: "fixture", repo: "public-images", ref: "main", rootPath: null, visibility: "PUBLIC" },
        manifest: { itemCount: 1, declaredBytes: 12 },
        sourceConnectionId: null,
      },
    });
  } finally { await fixture.cleanup(); }
});

test("HTTP retry authorizes Dataset members, returns safe successor data, and has no denial side effects", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const password = "phase-nine-retry-password";
  let server: Awaited<ReturnType<typeof startJobHttpServer>> | undefined;
  try {
    const passwordHash = await hashPassword(password);
    await db.user.updateMany({ where: { id: { in: [fixture.owner.id, fixture.labeler.id, fixture.outsider.id] } }, data: { passwordHash } });
    server = await startJobHttpServer(3_110);
    const [ownerCookie, labelerCookie, outsiderCookie] = await Promise.all([
      loginForJobHttp(server.baseUrl, fixture.owner.email, password), loginForJobHttp(server.baseUrl, fixture.labeler.email, password), loginForJobHttp(server.baseUrl, fixture.outsider.email, password),
    ]);
    const failed = await createFailedJob(fixture.datasetId, fixture.owner.id);
    assert.equal((await fetch(`${server.baseUrl}/api/jobs/${failed.id}/retry`, { method: "POST", headers: { Cookie: labelerCookie } })).status, 403);
    assert.equal((await fetch(`${server.baseUrl}/api/jobs/${failed.id}/retry`, { method: "POST", headers: { Cookie: outsiderCookie } })).status, 404);
    assert.equal(await db.job.count({ where: { retryOfJobId: failed.id } }), 0);
    const response = await fetch(`${server.baseUrl}/api/jobs/${failed.id}/retry`, { method: "POST", headers: { Cookie: ownerCookie } });
    assert.equal(response.status, 201);
    const body = await response.json() as { data: Record<string, unknown> };
    assert.equal(body.data.datasetId, fixture.datasetId);
    for (const prohibited of ["input", "state", "error", "queueName", "lockToken", "sourceConnectionId"]) assert.equal(prohibited in body.data, false);
    assert.equal((await fetch(`${server.baseUrl}/api/jobs/${failed.id}/retry`, { method: "POST", headers: { Cookie: ownerCookie } })).status, 200);
    const unsupported = await createFailedJob(fixture.datasetId, fixture.owner.id, JobType.IMPORT_DATASET);
    assert.equal((await fetch(`${server.baseUrl}/api/jobs/${unsupported.id}/retry`, { method: "POST", headers: { Cookie: ownerCookie } })).status, 409);
  } finally { await stopJobHttpServer(server?.server); await fixture.cleanup(); }
});
