import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { SourceConnectionStatus } from "@internal/db";

import { db } from "@/lib/db";

import {
  assertNoRepositoryImportSecret,
  assertNoRepositoryImportSideEffect,
  cleanupRepositoryImportUser,
  createOwnedRepositoryImportGiteaConnection,
  publicGiteaRequest,
  publicGithubRequest,
  repositoryImportHttpEnabled,
  repositoryImportHttpSkipReason,
  repositoryImportRequest,
  repositoryImportSnapshot,
  registerAndLoginRepositoryImportUser,
  safeQueueInspector,
} from "./helpers";

type Envelope = { data?: Record<string, unknown>; error?: { code?: string; message?: string; fieldErrors?: unknown } };

function assertRedactedEnvelope(payload: Envelope, sentinels: readonly string[] = []) {
  assertNoRepositoryImportSecret(payload, sentinels);
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    "passwordHash", "queueName", "queueJobId", "enqueuedAt", "storageKey",
    "storageBucket", "resultStorageKey", "externalRepository", "baseUrl",
    "PrismaClient", "RawQuery", "node_modules", "Error:",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `repository-import response leaked ${forbidden}`);
  }
}

async function readEnvelope(response: Response) {
  const payload = await response.json() as Envelope;
  assert.ok(payload.data || payload.error, "response must use the safe API envelope");
  return payload;
}

test("repository-import success and every Phase-015 failure envelope are credential and infrastructure redacted", {
  skip: repositoryImportHttpEnabled && process.env.SOURCE_CONNECTION_GITEA_TOKEN
    ? false
    : repositoryImportHttpSkipReason,
  concurrency: false,
}, async () => {
  const owner = await registerAndLoginRepositoryImportUser();
  const foreign = await registerAndLoginRepositoryImportUser();
  const acceptedJobIds: string[] = [];
  try {
    const publicSuccess = await repositoryImportRequest(owner.cookie, publicGithubRequest());
    assert.equal(publicSuccess.status, 201);
    const publicPayload = await readEnvelope(publicSuccess);
    assertRedactedEnvelope(publicPayload);
    const job = publicPayload.data?.job as { id?: string } | undefined;
    assert.ok(job?.id);
    acceptedJobIds.push(job.id);

    const invalidSentinel = `phase015-redaction-${randomBytes(12).toString("hex")}`;
    const invalidBefore = await repositoryImportSnapshot();
    const invalid = await repositoryImportRequest(owner.cookie, { ...publicGithubRequest(), token: invalidSentinel });
    assert.equal(invalid.status, 400);
    const invalidPayload = await readEnvelope(invalid);
    assert.equal(invalidPayload.error?.code, "INVALID_REQUEST");
    assertRedactedEnvelope(invalidPayload, [invalidSentinel]);
    assertNoRepositoryImportSideEffect(invalidBefore, await repositoryImportSnapshot());

    const missingBefore = await repositoryImportSnapshot();
    const missing = await repositoryImportRequest(owner.cookie, publicGithubRequest({
      repository: { owner: "fixture", name: "redaction-missing", ref: "main", expectedVisibility: "PUBLIC" },
    }));
    assert.equal(missing.status, 404);
    const missingPayload = await readEnvelope(missing);
    assert.equal(missingPayload.error?.code, "REPOSITORY_NOT_FOUND");
    assertRedactedEnvelope(missingPayload);
    assertNoRepositoryImportSideEffect(missingBefore, await repositoryImportSnapshot());

    const token = process.env.SOURCE_CONNECTION_GITEA_TOKEN!;
    const connectionId = await createOwnedRepositoryImportGiteaConnection(owner.cookie, token);
    const privateRequest = publicGiteaRequest({
      credentialMode: "EXISTING_SOURCE_CONNECTION",
      sourceConnectionId: connectionId,
      repository: { owner: "annotation-admin", name: "ImageDatasetPrivate", ref: "main", expectedVisibility: "PRIVATE" },
    });

    const foreignBefore = await repositoryImportSnapshot();
    const foreignResponse = await repositoryImportRequest(foreign.cookie, privateRequest);
    assert.equal(foreignResponse.status, 404);
    const foreignPayload = await readEnvelope(foreignResponse);
    assert.equal(foreignPayload.error?.code, "SOURCE_CONNECTION_NOT_FOUND");
    assertRedactedEnvelope(foreignPayload, [token]);
    assertNoRepositoryImportSideEffect(foreignBefore, await repositoryImportSnapshot());

    await db.sourceConnection.update({
      where: { id: connectionId },
      data: { status: SourceConnectionStatus.EXPIRED, tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    const expiredBefore = await repositoryImportSnapshot();
    const expiredResponse = await repositoryImportRequest(owner.cookie, privateRequest);
    assert.equal(expiredResponse.status, 422);
    const expiredPayload = await readEnvelope(expiredResponse);
    assert.equal(expiredPayload.error?.code, "SOURCE_TOKEN_INVALID");
    assertRedactedEnvelope(expiredPayload, [token]);
    assertNoRepositoryImportSideEffect(expiredBefore, await repositoryImportSnapshot());
  } finally {
    const queue = safeQueueInspector();
    try {
      await Promise.all(acceptedJobIds.map((jobId) => queue.removeJob(jobId)));
    } finally {
      await queue.close();
    }
    await cleanupRepositoryImportUser(owner.userId);
    await cleanupRepositoryImportUser(foreign.userId);
  }
});
