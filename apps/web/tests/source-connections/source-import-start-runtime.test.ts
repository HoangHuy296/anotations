import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { createQueueTransport, getQueueDeliveryId } from "@annotationplatform/queue";

import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import {
  assertNoSourceSecret,
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
} from "./helpers";

const cleanup = { datasetIds: [] as string[], connectionIds: [] as string[], userIds: [] as string[], queueJobIds: [] as string[] };

function isolatedQueue() {
  return createQueueTransport({
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? "6379"),
    password: process.env.REDIS_PASSWORD ?? "",
    db: Number(process.env.REDIS_DB ?? "15"),
    prefix: process.env.BULLMQ_PREFIX ?? "fieldframe-phase014-test",
    failFast: true,
  });
}

async function sourceSnapshot() {
  const { config, minio } = getDirectUploadProviders();
  const objects: string[] = [];
  for await (const object of minio.listObjectsV2(config.MINIO_BUCKET, "phase014-test/", true)) if (object.name) objects.push(object.name);
  return {
    datasets: await db.dataset.findMany({ select: { id: true }, orderBy: { id: "asc" } }),
    connections: await db.sourceConnection.findMany({ select: { id: true }, orderBy: { id: "asc" } }),
    jobs: await db.job.findMany({ select: { id: true }, orderBy: { id: "asc" } }),
    objects: objects.sort(),
  };
}

after(async () => {
  const queue = isolatedQueue();
  try {
    await Promise.all(cleanup.queueJobIds.map((id) => queue.remove(id).catch(() => undefined)));
  } finally {
    await queue.close();
  }
  await db.dataset.deleteMany({ where: { id: { in: cleanup.datasetIds } } });
  await db.sourceConnection.deleteMany({ where: { id: { in: cleanup.connectionIds } } });
  await db.user.deleteMany({ where: { id: { in: cleanup.userIds } } });
});

test("saved one-time Gitea PAT preflight stays read-only; Start Import creates encrypted connection, Dataset, and queued Job", {
  skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason,
}, async () => {
  const actor = await signupAndLogin("MANAGER");
  const user = await db.user.findUniqueOrThrow({ where: { email: actor.email }, select: { id: true } });
  cleanup.userIds.push(user.id);
  const token = process.env.SOURCE_CONNECTION_GITEA_TOKEN!;
  const requestBody = {
    provider: "GITEA",
    datasetName: `IMG987-${randomBytes(4).toString("hex")}`,
    credentialMode: "ONE_TIME_PAT",
    // Browser-facing URL. The server maps its configured public Gitea root to
    // the Compose-internal endpoint; callers never select that private host.
    serverUrl: process.env.SOURCE_CONNECTION_GITEA_BASE_URL!,
    personalAccessToken: token,
    saveAsSourceConnection: true,
    connectionName: "IMG987 Gitea",
    idempotencyKey: `phase015-one-time-${randomBytes(12).toString("hex")}`,
    repository: {
      owner: "annotation-admin",
      repo: "ImageDataset",
      ref: "main",
      expectedVisibility: "PUBLIC",
    },
  };
  const preflightRequestBody = {
    provider: requestBody.provider,
    datasetName: requestBody.datasetName,
    credentialMode: requestBody.credentialMode,
    serverUrl: requestBody.serverUrl,
    personalAccessToken: requestBody.personalAccessToken,
    saveAsSourceConnection: requestBody.saveAsSourceConnection,
    connectionName: requestBody.connectionName,
    repository: requestBody.repository,
  };
  const { repo, ...repositoryForAcceptance } = requestBody.repository;
  const durableRequestBody = {
    ...requestBody,
    repository: { ...repositoryForAcceptance, name: repo },
  };

  const before = await sourceSnapshot();
  const publicPreview = await request("/api/source-import-preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({
      provider: "GITEA",
      datasetName: "IMG987 public preview",
      credentialMode: "PUBLIC",
      serverUrl: process.env.SOURCE_CONNECTION_GITEA_BASE_URL!,
      repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" },
    }),
  });
  const publicPreviewBody = await publicPreview.json();
  assert.equal(publicPreview.status, 200);
  assertNoSourceSecret(publicPreviewBody, [token]);
  assert.deepEqual(await sourceSnapshot(), before, "public preflight must not create durable or storage state");

  const preview = await request("/api/source-import-preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    // Preflight is a distinct strict read-only contract; idempotency belongs
    // only to the later Dataset/Job write boundary.
    body: JSON.stringify(preflightRequestBody),
  });
  const previewBody = await preview.json();
  assert.equal(preview.status, 200);
  assert.equal(previewBody.data.repository.fullName, "annotation-admin/ImageDataset");
  assert.equal(previewBody.data.visibility.actual, "PUBLIC");
  assertNoSourceSecret(previewBody, [token]);
  assert.deepEqual(await sourceSnapshot(), before, "preflight must not create durable or storage state");

  const start = await request("/api/datasets/from-repository", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify(durableRequestBody),
  });
  const startBody = await start.json();
  assert.equal(start.status, 201);
  assertNoSourceSecret(startBody, [token]);

  const datasetId = startBody.data.dataset.id as string;
  const jobId = startBody.data.job.id as string;
  cleanup.datasetIds.push(datasetId);
  cleanup.queueJobIds.push(getQueueDeliveryId(jobId));

  const [dataset, job] = await Promise.all([
    db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { id: true, ownerId: true, name: true, sourceConnectionId: true } }),
    db.job.findUniqueOrThrow({ where: { id: jobId }, select: { id: true, datasetId: true, sourceConnectionId: true, status: true, input: true, queueName: true, queueJobId: true, enqueuedAt: true } }),
  ]);
  assert.equal(dataset.ownerId, user.id);
  assert.equal(dataset.name, requestBody.datasetName);
  assert.ok(dataset.sourceConnectionId);
  assert.equal(job.datasetId, dataset.id);
  assert.equal(job.sourceConnectionId, dataset.sourceConnectionId);
  assert.equal(job.status, "QUEUED");
  assert.equal(job.queueJobId, getQueueDeliveryId(jobId));
  assert.ok(job.queueName && job.enqueuedAt);
  assertNoSourceSecret(job.input, [token]);

  const events = await db.jobEvent.findMany({ where: { jobId }, select: { message: true, data: true } });
  for (const event of events) assertNoSourceSecret(event, [token]);

  const connection = await db.sourceConnection.findUniqueOrThrow({
    where: { id: dataset.sourceConnectionId! },
    select: { id: true, userId: true, name: true, tokenEncrypted: true, status: true },
  });
  cleanup.connectionIds.push(connection.id);
  assert.equal(connection.userId, user.id);
  assert.equal(connection.name, "IMG987 Gitea");
  assert.equal(connection.status, "ACTIVE");
  assert.ok(connection.tokenEncrypted);
  assert.notEqual(connection.tokenEncrypted, token);

  const replay = await request("/api/datasets/from-repository", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify(durableRequestBody),
  });
  const replayBody = await replay.json();
  assert.equal(replay.status, 200, "same one-time request must reuse the durable acceptance");
  assert.equal(replayBody.data.dataset.id, datasetId);
  assert.equal(replayBody.data.job.id, jobId);
  assert.equal(
    await db.sourceConnection.count({ where: { userId: user.id, name: requestBody.connectionName } }),
    1,
    "idempotent reuse must not create another encrypted SourceConnection",
  );

  const beforeExistingPreview = await sourceSnapshot();
  const existingPreview = await request("/api/source-import-preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({
      provider: "GITEA",
      datasetName: "IMG987 existing preview",
      credentialMode: "EXISTING_SOURCE_CONNECTION",
      sourceConnectionId: connection.id,
      repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" },
    }),
  });
  const existingPreviewBody = await existingPreview.json();
  assert.equal(existingPreview.status, 200);
  assertNoSourceSecret(existingPreviewBody, [token]);
  assert.deepEqual(await sourceSnapshot(), beforeExistingPreview, "existing-connection preflight must not create durable or storage state");

  const queue = isolatedQueue();
  try {
    const delivery = await queue.getJob(getQueueDeliveryId(jobId));
    assert.ok(delivery, "durable Job must have an isolated queue delivery");
    assert.deepEqual(delivery.data, { jobId });
  } finally {
    await queue.close();
  }

  const afterStart = await sourceSnapshot();
  assert.deepEqual(afterStart.objects, before.objects, "source Start Import must not write a MinIO object before worker processing");

  for (const credentialMode of ["PUBLIC", "EXISTING_SOURCE_CONNECTION"] as const) {
    const response = await request("/api/datasets/from-repository", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: actor.cookie },
      body: JSON.stringify(credentialMode === "PUBLIC" ? {
        provider: "GITEA",
        datasetName: `IMG987-public-${randomBytes(4).toString("hex")}`,
        credentialMode,
        serverUrl: process.env.SOURCE_CONNECTION_GITEA_BASE_URL!,
        idempotencyKey: `phase015-public-${randomBytes(12).toString("hex")}`,
        repository: { owner: "annotation-admin", name: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" },
      } : {
        provider: "GITEA",
        datasetName: `IMG987-existing-${randomBytes(4).toString("hex")}`,
        credentialMode,
        sourceConnectionId: connection.id,
        idempotencyKey: `phase015-existing-${randomBytes(12).toString("hex")}`,
        repository: { owner: "annotation-admin", name: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assertNoSourceSecret(body, [token]);
    const nextDatasetId = body.data.dataset.id as string;
    const nextJobId = body.data.job.id as string;
    cleanup.datasetIds.push(nextDatasetId);
    cleanup.queueJobIds.push(getQueueDeliveryId(nextJobId));
    const [nextDataset, nextJob] = await Promise.all([
      db.dataset.findUniqueOrThrow({ where: { id: nextDatasetId }, select: { sourceConnectionId: true } }),
      db.job.findUniqueOrThrow({ where: { id: nextJobId }, select: { sourceConnectionId: true, input: true } }),
    ]);
    assert.equal(nextDataset.sourceConnectionId, credentialMode === "PUBLIC" ? null : connection.id);
    assert.equal(nextJob.sourceConnectionId, credentialMode === "PUBLIC" ? null : connection.id);
    assertNoSourceSecret(nextJob.input, [token]);
    const verificationQueue = isolatedQueue();
    try {
      const delivery = await verificationQueue.getJob(getQueueDeliveryId(nextJobId));
      assert.deepEqual(delivery?.data, { jobId: nextJobId });
    } finally {
      await verificationQueue.close();
    }
  }
});
