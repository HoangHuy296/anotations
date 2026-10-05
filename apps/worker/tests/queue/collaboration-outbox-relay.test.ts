import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { Redis } from "ioredis";

import { getWorkerConfig } from "../../src/config.js";
import { collaborationRedisChannel } from "../../src/jobs/collaboration-outbox-relay.js";
import { routeQueueDelivery } from "../../src/queue/queue-router.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

test("private worker dispatches a claimed outbox Job through Redis without exposing database payload to the queue", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  const config = getWorkerConfig();
  const subscriber = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    db: config.REDIS_DB,
    maxRetriesPerRequest: null,
  });
  try {
    const job = await fixture.createJob({ type: "COLLABORATION_OUTBOX_DISPATCH", input: {} });
    const event = await fixture.db.collaborationOutboxEvent.create({
      data: {
        datasetId: fixture.datasetId,
        jobId: job.id,
        actorId: fixture.ownerId,
        type: "NOTIFICATION_CREATED",
        dedupeKey: `worker-outbox-${Date.now()}-${Math.random()}`,
        payload: { reason: "worker-test" },
      },
      select: { id: true },
    });
    await fixture.db.job.update({ where: { id: job.id }, data: { input: { outboxEventId: event.id } } });
    await subscriber.subscribe(collaborationRedisChannel(config.BULLMQ_PREFIX));
    let clearDeliveryTimeout = () => undefined;
    const delivered = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for collaboration Redis event.")), 5_000);
      clearDeliveryTimeout = () => clearTimeout(timeout);
      subscriber.once("message", (_channel, raw) => {
        clearTimeout(timeout);
        resolve(JSON.parse(raw) as Record<string, unknown>);
      });
    });

    try {
      assert.deepEqual(await routeQueueDelivery({ db: fixture.db, payload: { jobId: job.id }, workerId: "collaboration-outbox-test" }), { kind: "claimed", jobId: job.id });
      const dispatchedJob = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, errorCode: true } });
      assert.notEqual(dispatchedJob.status, "FAILED", dispatchedJob.errorCode ?? "outbox dispatch failed");
      const envelope = await delivered;
      assert.equal(envelope.id, event.id);
      assert.equal(envelope.datasetId, fixture.datasetId);
      assert.deepEqual(envelope.payload, { reason: "worker-test" });
      assert.equal((await fixture.db.collaborationOutboxEvent.findUniqueOrThrow({ where: { id: event.id }, select: { dispatchedAt: true } })).dispatchedAt instanceof Date, true);
      assert.equal((await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } })).status, "COMPLETED");
    } finally {
      clearDeliveryTimeout();
    }
  } finally {
    await subscriber.quit().catch(() => subscriber.disconnect());
    await fixture.cleanup();
  }
});

// 025-text-workspace-engine T032: the relay forwards every
// CollaborationOutboxEventType generically -- there is no per-type allowlist
// in this file to extend. This proves the newly added ANNOTATION_CHANGED
// enum value actually flows end-to-end through the real Redis channel,
// exactly like every other event type.
test("private worker relays a real ANNOTATION_CHANGED event with only its allowlisted metadata payload", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  const config = getWorkerConfig();
  const subscriber = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    db: config.REDIS_DB,
    maxRetriesPerRequest: null,
  });
  try {
    const job = await fixture.createJob({ type: "COLLABORATION_OUTBOX_DISPATCH", input: {} });
    const asset = await fixture.db.asset.create({
      data: { datasetId: fixture.datasetId, modality: "TEXT", filename: "relay-fixture.txt", mimeType: "text/plain", sourceFingerprint: `relay-${Date.now()}-${Math.random()}` },
      select: { id: true },
    });
    const event = await fixture.db.collaborationOutboxEvent.create({
      data: {
        datasetId: fixture.datasetId,
        assetId: asset.id,
        jobId: job.id,
        actorId: fixture.ownerId,
        type: "ANNOTATION_CHANGED",
        dedupeKey: `worker-outbox-annotation-${Date.now()}-${Math.random()}`,
        payload: { datasetId: fixture.datasetId, assetId: asset.id, parentRevision: 5 },
      },
      select: { id: true },
    });
    await fixture.db.job.update({ where: { id: job.id }, data: { input: { outboxEventId: event.id } } });
    await subscriber.subscribe(collaborationRedisChannel(config.BULLMQ_PREFIX));
    let clearDeliveryTimeout = () => undefined;
    const delivered = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for collaboration Redis event.")), 5_000);
      clearDeliveryTimeout = () => clearTimeout(timeout);
      subscriber.once("message", (_channel, raw) => {
        clearTimeout(timeout);
        resolve(JSON.parse(raw) as Record<string, unknown>);
      });
    });

    try {
      assert.deepEqual(await routeQueueDelivery({ db: fixture.db, payload: { jobId: job.id }, workerId: "collaboration-outbox-test" }), { kind: "claimed", jobId: job.id });
      const envelope = await delivered;
      assert.equal(envelope.type, "ANNOTATION_CHANGED");
      assert.equal(envelope.assetId, asset.id);
      assert.deepEqual(envelope.payload, { datasetId: fixture.datasetId, assetId: asset.id, parentRevision: 5 });
    } finally {
      clearDeliveryTimeout();
    }
  } finally {
    await subscriber.quit().catch(() => subscriber.disconnect());
    await fixture.cleanup();
  }
});
