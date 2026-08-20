import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { RepoAuthType, RepoProvider, SourceConnectionStatus } from "@internal/db";
import { createQueueTransport, getQueueDeliveryId } from "@annotationplatform/queue";

import { db } from "@/lib/db";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import {
  assertNoSourceSecret,
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
} from "./helpers";

const users: string[] = [];
after(async () => {
  await db.dataset.deleteMany({ where: { ownerId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
});

test("source Job HTTP route persists allowlisted data and delivers exactly { jobId }", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const account = await signupAndLogin();
  const user = await db.user.findUniqueOrThrow({ where: { email: account.email }, select: { id: true } });
  users.push(user.id);
  const dataset = await db.dataset.create({
    data: { ownerId: user.id, name: `source-queue-http-${randomBytes(5).toString("hex")}` },
    select: { id: true },
  });
  const sentinel = "source-job-queue-token-sentinel";
  const connection = await db.sourceConnection.create({
    data: {
      userId: user.id,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      baseUrl: "https://private-source.test",
      tokenEncrypted: encryptSourceToken(sentinel),
      status: SourceConnectionStatus.ACTIVE,
    },
    select: { id: true },
  });

  const response = await request("/api/source-import-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: account.cookie },
    body: JSON.stringify({
      datasetId: dataset.id,
      sourceConnectionId: connection.id,
      repository: { provider: "GITEA", owner: "safe-owner", repo: "safe-repository", branch: "main", rootPath: "images", visibility: "PRIVATE" },
      manifest: { itemCount: 1, declaredBytes: 1 },
    }),
  });
  assert.equal(response.status, 201);
  const responsePayload = await response.json() as { data: { job: { id: string } } };
  assertNoSourceSecret(responsePayload, [sentinel, "private-source.test"]);
  const job = await db.job.findUniqueOrThrow({
    where: { id: responsePayload.data.job.id },
    select: { id: true, sourceConnectionId: true, input: true, queueName: true, queueJobId: true, enqueuedAt: true },
  });
  assert.equal(job.sourceConnectionId, connection.id);
  assert.equal(job.queueJobId, getQueueDeliveryId(job.id));
  assert.ok(job.queueName && job.enqueuedAt);
  assertNoSourceSecret(job.input, [sentinel, "private-source.test"]);

  const events = await db.jobEvent.findMany({ where: { jobId: job.id }, select: { data: true } });
  for (const event of events) assertNoSourceSecret(event.data, [sentinel, "private-source.test"]);

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
