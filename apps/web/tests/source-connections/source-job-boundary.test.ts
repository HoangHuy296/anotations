import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { RepoAuthType, RepoProvider, SourceConnectionStatus } from "@internal/db";
import { createQueueTransport, getQueueDeliveryId } from "@annotationplatform/queue";

import { db } from "@/lib/db";
import { createAndEnqueueSourceImportJob } from "@/lib/queue/enqueue-job";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import { signupAndLogin, sourceConnectionHttpEnabled, sourceConnectionHttpSkipReason } from "./helpers";

const cleanupUserIds: string[] = [];
after(async () => {
  await db.dataset.deleteMany({ where: { ownerId: { in: cleanupUserIds } } });
  await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

test("source Job boundary persists only safe metadata and enqueues exactly { jobId }", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const account = await signupAndLogin();
  const user = await db.user.findUniqueOrThrow({ where: { email: account.email }, select: { id: true, email: true, name: true, role: true } });
  const actor = { ...user, name: user.name ?? user.email };
  cleanupUserIds.push(actor.id);
  const dataset = await db.dataset.create({ data: { ownerId: actor.id, name: `source-boundary-${randomBytes(5).toString("hex")}` }, select: { id: true } });
  const connection = await db.sourceConnection.create({
    data: {
      userId: actor.id,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      baseUrl: "https://safe-source.test",
      tokenEncrypted: encryptSourceToken("source-token-sentinel"),
      status: SourceConnectionStatus.ACTIVE,
    },
    select: { id: true },
  });

  const result = await createAndEnqueueSourceImportJob(actor, {
    datasetId: dataset.id,
    sourceConnectionId: connection.id,
    repository: {
      provider: "GITEA",
      owner: "safe-owner",
      repo: "safe-repository",
      branch: "main",
      normalizedRootPath: "images",
      visibility: "PRIVATE",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const job = await db.job.findUniqueOrThrow({
    where: { id: result.job.id },
    select: { id: true, sourceConnectionId: true, input: true, queueName: true, queueJobId: true, enqueuedAt: true },
  });
  assert.equal(job.sourceConnectionId, connection.id);
  assert.equal(job.queueJobId, getQueueDeliveryId(job.id));
  assert.ok(job.queueName && job.enqueuedAt);
  const durable = JSON.stringify(job.input);
  for (const forbidden of ["source-token-sentinel", "safe-source.test", "tokenEncrypted", "SOURCE_CONNECTION_ENCRYPTION_KEY", "DATABASE_URL", "REDIS_PASSWORD"]) {
    assert.equal(durable.includes(forbidden), false, `Job input leaked ${forbidden}`);
  }
  assert.deepEqual(job.input, {
    source: {
      repository: {
        provider: "GITEA",
        owner: "safe-owner",
        repo: "safe-repository",
        branch: "main",
        normalizedRootPath: "images",
        visibility: "PRIVATE",
      },
      manifest: {
        itemCount: 0,
        declaredBytes: 0,
      },
    },
  });

  const events = await db.jobEvent.findMany({ where: { jobId: job.id }, select: { data: true } });
  for (const event of events) assert.equal(JSON.stringify(event.data).includes("source-token-sentinel"), false);

  const queue = createQueueTransport({
    host: process.env.REDIS_HOST ?? "redis",
    port: Number(process.env.REDIS_PORT ?? "6379"),
    password: process.env.REDIS_PASSWORD ?? "",
    db: Number(process.env.REDIS_DB ?? "15"),
    prefix: process.env.BULLMQ_PREFIX ?? "fieldframe-phase013-test",
    failFast: true,
  });
  try {
    const delivery = await queue.getJob(getQueueDeliveryId(job.id));
    assert.ok(delivery);
    assert.deepEqual(delivery.data, { jobId: job.id });
  } finally {
    await queue.close();
  }
});
