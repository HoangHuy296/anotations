import assert from "node:assert/strict";
import test from "node:test";

import { NotificationType } from "@internal/db";

import { runCollaborationTransaction } from "@/lib/collaboration/collaboration-outbox-service";
import { createDurableNotification, listNotifications, markAllNotificationsRead, markNotificationRead } from "@/lib/collaboration/notification-service";
import { db } from "@/lib/db";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";
import { createCollaborationFixture } from "./helpers";

test("durable notifications dedupe, suppress self, redact inaccessible context, and preserve read state", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createCollaborationFixture();
  try {
    await runCollaborationTransaction(async (tx) => {
      await createDurableNotification(tx, { userId: fixture.labeler.id, actorId: fixture.owner.id, type: NotificationType.ASSET_ASSIGNED, datasetId: fixture.dataset.id, assetId: fixture.asset.id, title: "Assigned", body: "Safe", dedupeKey: "notification-test" });
      await createDurableNotification(tx, { userId: fixture.labeler.id, actorId: fixture.owner.id, type: NotificationType.ASSET_ASSIGNED, datasetId: fixture.dataset.id, assetId: fixture.asset.id, title: "Assigned", body: "Safe", dedupeKey: "notification-test" });
      const self = await createDurableNotification(tx, { userId: fixture.owner.id, actorId: fixture.owner.id, type: NotificationType.ASSET_ASSIGNED, datasetId: fixture.dataset.id, assetId: fixture.asset.id, title: "Self", body: "No", dedupeKey: "self-test" });
      assert.equal(self.kind, "suppressed");
    });
    assert.equal(await db.notification.count({ where: { userId: fixture.labeler.id } }), 1);
    const listed = await listNotifications(fixture.labeler, { limit: 25 });
    assert.equal(listed.unreadCount, 1);
    assert.equal(listed.items[0]?.unavailable, false);
    const id = listed.items[0]!.id;
    assert.deepEqual(await markNotificationRead(fixture.labeler, id), { id, read: true });
    assert.equal((await listNotifications(fixture.labeler, { limit: 25 })).unreadCount, 0);
    await markAllNotificationsRead(fixture.labeler);
    assert.equal(await markNotificationRead(fixture.owner, id), null, "another recipient cannot acknowledge it");
  } finally { await fixture.cleanup(); }
});

test("notification retry and a failed parent transaction cannot leave duplicate or partial durable state", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createCollaborationFixture();
  const input = {
    userId: fixture.reviewer.id,
    actorId: fixture.owner.id,
    type: NotificationType.REVIEW_SUBMITTED,
    datasetId: fixture.dataset.id,
    assetId: fixture.asset.id,
    title: "Submitted",
    body: "Safe",
    dedupeKey: "retry-proof",
  };
  try {
    await Promise.all([
      runCollaborationTransaction((tx) => createDurableNotification(tx, input)),
      runCollaborationTransaction((tx) => createDurableNotification(tx, input)),
    ]);
    assert.equal(await db.notification.count({ where: { userId: fixture.reviewer.id, dedupeKey: input.dedupeKey } }), 1);

    await assert.rejects(() => runCollaborationTransaction(async (tx) => {
      await createDurableNotification(tx, { ...input, dedupeKey: "rollback-proof" });
      throw new Error("intended rollback");
    }));
    assert.equal(await db.notification.count({ where: { userId: fixture.reviewer.id, dedupeKey: "rollback-proof" } }), 0);
  } finally { await fixture.cleanup(); }
});
