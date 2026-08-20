import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { RepoAuthType, RepoProvider, SourceConnectionStatus } from "@internal/db";
import { getQueueDeliveryId } from "@annotationplatform/queue";

import { db } from "@/lib/db";
import { createAndEnqueueSourceImportJob } from "@/lib/queue/enqueue-job";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import {
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
  transportAndStorageSnapshot,
} from "./helpers";

const cleanupUserIds: string[] = [];
after(async () => {
  if (!cleanupUserIds.length) return;
  await db.dataset.deleteMany({ where: { ownerId: { in: cleanupUserIds } } });
  await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

async function createFixture(email: string) {
  const user = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true, email: true, name: true, role: true } });
  const dataset = await db.dataset.create({ data: { ownerId: user.id, name: `source-race-${randomBytes(5).toString("hex")}` }, select: { id: true } });
  const connection = await db.sourceConnection.create({ data: { userId: user.id, provider: RepoProvider.GITEA, authType: RepoAuthType.TOKEN, baseUrl: `https://source-race-${randomBytes(5).toString("hex")}.test`, tokenEncrypted: encryptSourceToken("fixture-token"), status: SourceConnectionStatus.ACTIVE }, select: { id: true } });
  return { actor: { id: user.id, email: user.email, name: user.name ?? user.email, role: user.role }, datasetId: dataset.id, connectionId: connection.id };
}

function sourceInput(datasetId: string, sourceConnectionId: string | null, visibility: "PUBLIC" | "PRIVATE" = "PRIVATE") {
  return { datasetId, sourceConnectionId, repository: { provider: "GITEA" as const, owner: "owner", repo: "repo", branch: "main", normalizedRootPath: "", visibility } };
}

test("source Job boundary proves reference-wins, delete-wins, and simultaneous races", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const transportBefore = await transportAndStorageSnapshot();
  const account = await signupAndLogin();
  const user = await db.user.findUniqueOrThrow({ where: { email: account.email }, select: { id: true } });
  cleanupUserIds.push(user.id);

  // Public source work has no connection/PAT; private work without one is denied.
  const publicFixture = await createFixture(account.email);
  const publicJob = await createAndEnqueueSourceImportJob(publicFixture.actor, sourceInput(publicFixture.datasetId, null, "PUBLIC"));
  assert.equal(publicJob.ok, true);
  if (publicJob.ok) assert.equal((await db.job.findUniqueOrThrow({ where: { id: publicJob.job.id }, select: { sourceConnectionId: true } })).sourceConnectionId, null);
  assert.equal((await createAndEnqueueSourceImportJob(publicFixture.actor, sourceInput(publicFixture.datasetId, null))).ok, false);

  // Retry preserves the failed predecessor and reuses its one successor.
  const retryFixture = await createFixture(account.email);
  const predecessor = await db.job.create({ data: { datasetId: retryFixture.datasetId, createdById: retryFixture.actor.id, sourceConnectionId: retryFixture.connectionId, type: "IMPORT_DATASET", status: "FAILED" }, select: { id: true, status: true } });
  const firstRetry = await createAndEnqueueSourceImportJob(retryFixture.actor, { ...sourceInput(retryFixture.datasetId, retryFixture.connectionId), retryOfJobId: predecessor.id });
  const repeatedRetry = await createAndEnqueueSourceImportJob(retryFixture.actor, { ...sourceInput(retryFixture.datasetId, retryFixture.connectionId), retryOfJobId: predecessor.id });
  assert.equal(firstRetry.ok, true);
  assert.equal(repeatedRetry.ok, true);
  if (firstRetry.ok && repeatedRetry.ok) assert.equal(firstRetry.job.id, repeatedRetry.job.id);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: predecessor.id }, select: { status: true } })).status, predecessor.status);

  // A: reference commits first, therefore DELETE observes durable non-terminal work.
  const referenceWins = await createFixture(account.email);
  const created = await createAndEnqueueSourceImportJob(referenceWins.actor, sourceInput(referenceWins.datasetId, referenceWins.connectionId));
  assert.equal(created.ok, true);
  const referenceDelete = await request(`/api/source-connections/${referenceWins.connectionId}`, { method: "DELETE", headers: { Cookie: account.cookie } });
  assert.equal(referenceDelete.status, 409);
  const referenceJob = await db.job.findFirstOrThrow({ where: { sourceConnectionId: referenceWins.connectionId }, select: { id: true, sourceConnectionId: true, status: true } });
  assert.equal(referenceJob.sourceConnectionId, referenceWins.connectionId);
  assert.equal(referenceJob.status, "QUEUED");
  assert.equal((await db.sourceConnection.findUniqueOrThrow({ where: { id: referenceWins.connectionId }, select: { revokedAt: true } })).revokedAt, null);

  // B: revoke commits first, therefore the canonical creator cannot create a reference.
  const deleteWins = await createFixture(account.email);
  const deleted = await request(`/api/source-connections/${deleteWins.connectionId}`, { method: "DELETE", headers: { Cookie: account.cookie } });
  assert.equal(deleted.status, 204);
  const rejected = await createAndEnqueueSourceImportJob(deleteWins.actor, sourceInput(deleteWins.datasetId, deleteWins.connectionId));
  assert.equal(rejected.ok, false);
  assert.equal(await db.job.count({ where: { sourceConnectionId: deleteWins.connectionId } }), 0);
  assert.equal((await db.sourceConnection.findUniqueOrThrow({ where: { id: deleteWins.connectionId }, select: { status: true, revokedAt: true } })).status, SourceConnectionStatus.REVOKED);

  // C: finite simultaneous race; every fixture ends with either a valid Job+active connection or a revoked connection with no Job.
  const raceConnectionIds: string[] = [];
  for (let iteration = 0; iteration < 25; iteration += 1) {
    const fixture = await createFixture(account.email);
    raceConnectionIds.push(fixture.connectionId);
    const [creation, deletion] = await Promise.allSettled([
      createAndEnqueueSourceImportJob(fixture.actor, sourceInput(fixture.datasetId, fixture.connectionId)),
      request(`/api/source-connections/${fixture.connectionId}`, { method: "DELETE", headers: { Cookie: account.cookie } }),
    ]);
    assert.equal(creation.status, "fulfilled");
    assert.equal(deletion.status, "fulfilled");
    const [connection, jobs] = await Promise.all([
      db.sourceConnection.findUniqueOrThrow({ where: { id: fixture.connectionId }, select: { status: true, revokedAt: true } }),
      db.job.findMany({ where: { sourceConnectionId: fixture.connectionId }, select: { id: true } }),
    ]);
    assert.ok((jobs.length === 1 && connection.revokedAt === null) || (jobs.length === 0 && connection.status === SourceConnectionStatus.REVOKED), `race iteration ${iteration} broke source reference invariant`);
  }

  // E: all durable references and isolated transport/storage state reconcile.
  const sourceJobs = await db.job.findMany({
    where: { sourceConnectionId: { in: [referenceWins.connectionId, ...raceConnectionIds] } },
    select: { id: true, sourceConnectionId: true, queueJobId: true, queueName: true, enqueuedAt: true, status: true },
  });
  assert.ok(sourceJobs.length >= 1);
  assert.equal(new Set(sourceJobs.map((job) => job.id)).size, sourceJobs.length);
  assert.equal(new Set(sourceJobs.map((job) => job.queueJobId)).size, sourceJobs.length, "each durable source Job has one queue delivery");
  for (const job of sourceJobs) {
    assert.equal(job.status, "QUEUED");
    assert.equal(job.queueJobId, getQueueDeliveryId(job.id));
    assert.ok(job.queueName && job.enqueuedAt, "source Job must be stamped after its post-commit delivery");
  }
  const transportAfter = await transportAndStorageSnapshot();
  assert.deepEqual(transportAfter.objects, transportBefore.objects, "source Job creation must not write MinIO");
  const deliveredSourceJobs = await db.job.count({
    where: { createdById: user.id, type: "IMPORT_DATASET", enqueuedAt: { not: null } },
  });
  assert.equal(transportAfter.queue.wait, transportBefore.queue.wait + deliveredSourceJobs, "isolated Redis has exactly one delivery per public or authenticated source Job");
  for (const state of ["active", "delayed", "completed", "failed"] as const) {
    assert.equal(transportAfter.queue[state], transportBefore.queue[state], `worker remains stopped; ${state} queue state must not change`);
  }
});
