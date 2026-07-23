import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { RepoAuthType, RepoProvider, SourceConnectionStatus } from "@internal/db";

import { db } from "@/lib/db";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import { NON_TERMINAL_JOB_STATUSES } from "@/lib/job-status";
import {
  assertNoTransportOrStorageWrite,
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

async function fixture(ownerEmail: string) {
  const owner = await db.user.findUniqueOrThrow({ where: { email: ownerEmail }, select: { id: true } });
  const connection = await db.sourceConnection.create({ data: {
    userId: owner.id, provider: RepoProvider.GITEA, authType: RepoAuthType.TOKEN,
    baseUrl: `https://delete-${randomBytes(5).toString("hex")}.test`, tokenEncrypted: encryptSourceToken("fixture-token"), status: SourceConnectionStatus.ACTIVE,
  }, select: { id: true } });
  return { ownerId: owner.id, connectionId: connection.id };
}

test("DELETE lifecycle conceals foreign/unknown, blocks active Jobs, and is deterministic concurrently", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const foreign = await signupAndLogin();
  const own = await fixture(owner.email);
  cleanupUserIds.push(own.ownerId, (await db.user.findUniqueOrThrow({ where: { email: foreign.email } })).id);

  const foreignDelete = await request(`/api/source-connections/${own.connectionId}`, { method: "DELETE", headers: { Cookie: foreign.cookie } });
  assert.equal(foreignDelete.status, 404);
  const unknown = await request("/api/source-connections/cm00000000000000000000000", { method: "DELETE", headers: { Cookie: owner.cookie } });
  assert.equal(unknown.status, 404);

  const [first, second] = await Promise.all([
    request(`/api/source-connections/${own.connectionId}`, { method: "DELETE", headers: { Cookie: owner.cookie } }),
    request(`/api/source-connections/${own.connectionId}`, { method: "DELETE", headers: { Cookie: owner.cookie } }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [204, 404]);

  const protectedConnection = await fixture(owner.email);
  const dataset = await db.dataset.create({ data: { ownerId: protectedConnection.ownerId, name: `source-job-${randomBytes(5).toString("hex")}` }, select: { id: true } });
  await db.job.create({ data: { datasetId: dataset.id, createdById: protectedConnection.ownerId, sourceConnectionId: protectedConnection.connectionId, type: "EXPORT_DATASET", status: "QUEUED" } });
  const active = await request(`/api/source-connections/${protectedConnection.connectionId}`, { method: "DELETE", headers: { Cookie: owner.cookie } });
  assert.equal(active.status, 409);
  assert.equal((await active.json() as { error: { code: string } }).error.code, "SOURCE_CONNECTION_IN_USE");
});

test("every canonical non-terminal Job status blocks DELETE without mutating durable references", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const ownerId = (await db.user.findUniqueOrThrow({ where: { email: owner.email }, select: { id: true } })).id;
  cleanupUserIds.push(ownerId);
  for (const status of NON_TERMINAL_JOB_STATUSES) {
    const protectedConnection = await fixture(owner.email);
    const dataset = await db.dataset.create({ data: { ownerId, name: `status-${status}-${randomBytes(4).toString("hex")}` }, select: { id: true } });
    const job = await db.job.create({ data: { datasetId: dataset.id, createdById: ownerId, sourceConnectionId: protectedConnection.connectionId, type: "EXPORT_DATASET", status }, select: { id: true, status: true, sourceConnectionId: true } });
    const eventCount = await db.jobEvent.count({ where: { jobId: job.id } });
    const transportBefore = await transportAndStorageSnapshot();
    const connectionBefore = await db.sourceConnection.findUniqueOrThrow({ where: { id: protectedConnection.connectionId }, select: { id: true, status: true, revokedAt: true, tokenEncrypted: true } });
    const response = await request(`/api/source-connections/${protectedConnection.connectionId}`, { method: "DELETE", headers: { Cookie: owner.cookie } });
    assert.equal(response.status, 409, status);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "SOURCE_CONNECTION_IN_USE");
    assert.deepEqual(await db.sourceConnection.findUnique({ where: { id: protectedConnection.connectionId }, select: { id: true, status: true, revokedAt: true, tokenEncrypted: true } }), connectionBefore);
    assert.deepEqual(await db.job.findUnique({ where: { id: job.id }, select: { id: true, status: true, sourceConnectionId: true } }), job);
    assert.equal(await db.jobEvent.count({ where: { jobId: job.id } }), eventCount);
    assertNoTransportOrStorageWrite(transportBefore, await transportAndStorageSnapshot());
  }
});
