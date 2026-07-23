import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { RepoAuthType, RepoProvider, SourceConnectionStatus } from "@internal/db";
import { createQueueTransport, getQueueDeliveryId } from "@fieldframe/queue";

import { db } from "@/lib/db";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import {
  assertNoSourceSecret,
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
  transportAndStorageSnapshot,
} from "./helpers";

const userIds: string[] = [];
after(async () => {
  await db.dataset.deleteMany({ where: { ownerId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

type SourceJobSnapshot = {
  status: string;
  errorCode: string | null;
  startedAt: Date | null;
  dequeuedAt: Date | null;
  input: unknown;
  sourceConnectionId: string | null;
};

async function waitForTerminalJob(jobId: string): Promise<SourceJobSnapshot | null> {
  let latest: SourceJobSnapshot | null = null;
  // BullMQ's blocking fetch may take several seconds after an isolated worker
  // reconnects. Keep this bounded, but do not race cleanup against receipt.
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const job = await db.job.findUnique({
      where: { id: jobId },
      select: {
        status: true,
        errorCode: true,
        startedAt: true,
        dequeuedAt: true,
        input: true,
        sourceConnectionId: true,
      },
    });
    latest = job;
    if (job?.status === "FAILED" || job?.status === "COMPLETED" || job?.status === "CANCELED") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

test("dedicated worker claims a source-backed Job and safely rejects an unsafe source", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const before = await transportAndStorageSnapshot();
  const account = await signupAndLogin();
  const actor = await db.user.findUniqueOrThrow({
    where: { email: account.email },
    select: { id: true, email: true, name: true, role: true },
  });
  userIds.push(actor.id);
  const dataset = await db.dataset.create({
    data: { ownerId: actor.id, name: `source-worker-e2e-${randomBytes(5).toString("hex")}` },
    select: { id: true },
  });
  const tokenSentinel = "source-worker-e2e-token-sentinel";
  const connection = await db.sourceConnection.create({
    data: {
      userId: actor.id,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      // Numeric private destinations are rejected by the worker policy before
      // token/provider access, making the controlled E2E result deterministic.
      baseUrl: "http://10.0.0.1",
      tokenEncrypted: encryptSourceToken(tokenSentinel),
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
      repository: {
        provider: "GITEA",
        owner: "safe-owner",
        repo: "safe-repository",
        branch: "main",
        rootPath: "images",
        visibility: "PRIVATE",
      },
      manifest: { itemCount: 1, declaredBytes: 1 },
    }),
  });
  assert.equal(response.status, 201);
  const payload = await response.json() as { data: { job: { id: string; datasetId: string; type: string; status: string } } };
  assert.equal(payload.data.job.datasetId, dataset.id);
  assert.equal(payload.data.job.type, "IMPORT_DATASET");
  assertNoSourceSecret(payload, [tokenSentinel, "10.0.0.1"]);
  const jobId = payload.data.job.id;

  const terminal = await waitForTerminalJob(jobId);
  assert.ok(terminal, "dedicated worker must resolve the isolated delivery");
  assert.equal(terminal.status, "FAILED");
  assert.equal(terminal.errorCode, "SOURCE_URL_UNSAFE");
  assert.equal(terminal.sourceConnectionId, connection.id);
  assert.ok(terminal.startedAt && terminal.dequeuedAt, "worker must claim before safe refusal");
  assertNoSourceSecret(terminal.input, [tokenSentinel, "10.0.0.1"]);

  const events = await db.jobEvent.findMany({
    where: { jobId },
    select: { message: true, data: true },
    orderBy: { createdAt: "asc" },
  });
  assert.ok(events.some((event) => event.message === "QUEUE_RECEIVED"));
  assert.ok(events.some((event) => event.message === "JOB_CLAIMED"));
  for (const event of events) assertNoSourceSecret(event, [tokenSentinel, "10.0.0.1"]);

  const queue = createQueueTransport({
    host: process.env.REDIS_HOST ?? "redis",
    port: Number(process.env.REDIS_PORT ?? "6379"),
    password: process.env.REDIS_PASSWORD ?? "",
    db: Number(process.env.REDIS_DB ?? "15"),
    prefix: process.env.BULLMQ_PREFIX ?? "fieldframe-phase013-e2e",
    failFast: true,
  });
  try {
    const delivery = await queue.getJob(getQueueDeliveryId(jobId));
    assert.ok(delivery, "one isolated BullMQ delivery must exist");
    assert.deepEqual(delivery.data, { jobId });
  } finally {
    await queue.close();
  }

  const after = await transportAndStorageSnapshot();
  assert.deepEqual(after.objects, before.objects, "source revalidation must not write MinIO");
});
