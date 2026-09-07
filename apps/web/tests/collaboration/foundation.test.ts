import assert from "node:assert/strict";
import test from "node:test";

import { db } from "@/lib/db";
import { createDurableNotification } from "@/lib/collaboration/notification-service";
import { createOrReuseCollaborationOutboxEvent, runCollaborationTransaction } from "@/lib/collaboration/collaboration-outbox-service";

import { createCollaborationFixture } from "./helpers";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

test("foundation constraints enforce pending invitation and active assignment uniqueness", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createCollaborationFixture();
  try {
    const expiresAt = new Date(Date.now() + 60_000);
    await db.datasetInvitation.create({
      data: { datasetId: fixture.dataset.id, inviteeUserId: fixture.labeler.id, invitedById: fixture.owner.id, role: "LABELER", activeKey: "PENDING", expiresAt },
    });
    await assert.rejects(() => db.datasetInvitation.create({
      data: { datasetId: fixture.dataset.id, inviteeUserId: fixture.labeler.id, invitedById: fixture.owner.id, role: "LABELER", activeKey: "PENDING", expiresAt },
    }));
    await db.datasetInvitation.createMany({
      data: [
        { datasetId: fixture.dataset.id, inviteeUserId: fixture.labeler.id, invitedById: fixture.owner.id, role: "LABELER", status: "DECLINED", activeKey: null, expiresAt },
        { datasetId: fixture.dataset.id, inviteeUserId: fixture.labeler.id, invitedById: fixture.owner.id, role: "LABELER", status: "REVOKED", activeKey: null, expiresAt },
      ],
    });
    await db.assetAssignment.create({ data: { datasetId: fixture.dataset.id, assetId: fixture.asset.id, userId: fixture.labeler.id, type: "ANNOTATION" } });
    await assert.rejects(() => db.assetAssignment.create({ data: { datasetId: fixture.dataset.id, assetId: fixture.asset.id, userId: fixture.labeler.id, type: "ANNOTATION" } }));
  } finally {
    await fixture.cleanup();
  }
});

test("notification and outbox intents are transactionally idempotent and retain only safe Job input", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createCollaborationFixture();
  try {
    const result = await db.$transaction(async (tx) => {
      const notification = await createDurableNotification(tx, {
        userId: fixture.labeler.id,
        actorId: fixture.owner.id,
        type: "ASSET_ASSIGNED",
        datasetId: fixture.dataset.id,
        assetId: fixture.asset.id,
        title: "Assignment updated",
        body: "You have annotation work.",
        dedupeKey: "foundation-notification",
      });
      const replay = await createDurableNotification(tx, {
        userId: fixture.labeler.id,
        actorId: fixture.owner.id,
        type: "ASSET_ASSIGNED",
        datasetId: fixture.dataset.id,
        assetId: fixture.asset.id,
        title: "Assignment updated",
        body: "You have annotation work.",
        dedupeKey: "foundation-notification",
      });
      const outbox = await createOrReuseCollaborationOutboxEvent(tx, {
        datasetId: fixture.dataset.id,
        assetId: fixture.asset.id,
        actorId: fixture.owner.id,
        recipientUserId: fixture.labeler.id,
        type: "NOTIFICATION_CREATED",
        dedupeKey: "foundation-outbox",
        payload: { source: "foundation-test" },
      });
      const outboxReplay = await createOrReuseCollaborationOutboxEvent(tx, {
        datasetId: fixture.dataset.id,
        assetId: fixture.asset.id,
        actorId: fixture.owner.id,
        recipientUserId: fixture.labeler.id,
        type: "NOTIFICATION_CREATED",
        dedupeKey: "foundation-outbox",
        payload: { source: "foundation-test" },
      });
      return { notification, replay, outbox, outboxReplay };
    });

    assert.equal(await db.notification.count({ where: { userId: fixture.labeler.id, dedupeKey: "foundation-notification" } }), 1);
    assert.equal(result.outbox.kind, "created");
    assert.equal(result.outboxReplay.kind, "reused");
    const job = await db.job.findUniqueOrThrow({ where: { id: result.outbox.jobId }, select: { type: true, input: true } });
    assert.equal(job.type, "COLLABORATION_OUTBOX_DISPATCH");
    assert.deepEqual(job.input, { outboxEventId: result.outbox.id });

    const concurrent = await Promise.all(Array.from({ length: 2 }, () => runCollaborationTransaction((tx) => createOrReuseCollaborationOutboxEvent(tx, {
      datasetId: fixture.dataset.id,
      assetId: fixture.asset.id,
      actorId: fixture.owner.id,
      recipientUserId: fixture.labeler.id,
      type: "NOTIFICATION_CREATED",
      dedupeKey: "foundation-outbox-concurrent",
      payload: { source: "foundation-test" },
    }))));
    assert.equal(concurrent[0].jobId, concurrent[1].jobId);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { dedupeKey: "foundation-outbox-concurrent" } }), 1);
  } finally {
    await fixture.cleanup();
  }
});
