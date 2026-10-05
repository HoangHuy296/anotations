import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { runCollaborationTransaction, createOrReuseCollaborationOutboxEvent } from "@/lib/collaboration/collaboration-outbox-service";
import { db } from "@/lib/db";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";
import { createCollaborationFixture } from "./helpers";

test("outbox intent and durable dispatch Job are retry-safe and rollback together", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createCollaborationFixture();
  const dedupeKey = `outbox-retry-${fixture.asset.id}`;
  try {
    const [first, replay] = await Promise.all([
      runCollaborationTransaction((tx) => createOrReuseCollaborationOutboxEvent(tx, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, actorId: fixture.owner.id, recipientUserId: fixture.reviewer.id, type: "NOTIFICATION_CREATED", dedupeKey, payload: { notificationId: "safe-id" } })),
      runCollaborationTransaction((tx) => createOrReuseCollaborationOutboxEvent(tx, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, actorId: fixture.owner.id, recipientUserId: fixture.reviewer.id, type: "NOTIFICATION_CREATED", dedupeKey, payload: { notificationId: "safe-id" } })),
    ]);
    assert.equal(first.jobId, replay.jobId);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { dedupeKey } }), 1);
    assert.equal(await db.job.count({ where: { id: first.jobId, type: "COLLABORATION_OUTBOX_DISPATCH" } }), 1);

    await assert.rejects(() => runCollaborationTransaction(async (tx) => {
      await createOrReuseCollaborationOutboxEvent(tx, { datasetId: fixture.dataset.id, actorId: fixture.owner.id, type: "NOTIFICATION_CREATED", dedupeKey: `${dedupeKey}-rollback`, payload: { notificationId: "safe-id" } });
      throw new Error("rollback proof");
    }));
    assert.equal(await db.collaborationOutboxEvent.count({ where: { dedupeKey: `${dedupeKey}-rollback` } }), 0);
  } finally { await fixture.cleanup(); }
});
