import assert from "node:assert/strict";
import test from "node:test";

import {
  runCollaborationTransaction,
  dispatchAnnotationChangedOutboxEvent,
  dispatchTextPolicyChangedOutboxEvent,
} from "@/lib/collaboration/collaboration-outbox-service";
import { db } from "@/lib/db";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";
import { createCollaborationFixture } from "./helpers";

/**
 * T031/T032: ANNOTATION_CHANGED and TEXT_POLICY_CHANGED are metadata-only
 * invalidation events dispatched through the existing generic outbox
 * primitive. The worker relay (collaboration-outbox-relay.ts) and the
 * realtime gateway/client hook forward every event by type generically
 * already -- there is no per-type allowlist to extend in those three
 * layers (confirmed by reading collaboration-outbox-relay.ts's
 * type-agnostic `event.type` forwarding, gateway.ts's `RealtimeEnvelope.type:
 * string`, and use-collaboration-realtime.ts's `onmessage = () =>
 * callback.current()`). What this test proves for real: the two new
 * dispatch helpers produce a correctly-typed, correctly-scoped, safe
 * payload and participate in the same retry-safe/rollback-safe transaction
 * boundary as every other outbox event.
 */

test("dispatchAnnotationChangedOutboxEvent is retry-safe, rolls back with its transaction, and carries only allowlisted metadata", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createCollaborationFixture();
  const operationId = `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const [first, replay] = await Promise.all([
      runCollaborationTransaction((tx) => dispatchAnnotationChangedOutboxEvent(tx, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, actorId: fixture.owner.id, operationId, parentRevision: 3 })),
      runCollaborationTransaction((tx) => dispatchAnnotationChangedOutboxEvent(tx, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, actorId: fixture.owner.id, operationId, parentRevision: 3 })),
    ]);
    assert.equal(first.jobId, replay.jobId);

    const event = await db.collaborationOutboxEvent.findUniqueOrThrow({
      where: { dedupeKey: `annotation-changed:${fixture.asset.id}:${operationId}` },
      select: { type: true, datasetId: true, assetId: true, payload: true },
    });
    assert.equal(event.type, "ANNOTATION_CHANGED");
    assert.equal(event.datasetId, fixture.dataset.id);
    assert.equal(event.assetId, fixture.asset.id);
    assert.deepEqual(event.payload, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, parentRevision: 3 });

    await assert.rejects(() => runCollaborationTransaction(async (tx) => {
      await dispatchAnnotationChangedOutboxEvent(tx, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, actorId: fixture.owner.id, operationId: `${operationId}-rollback` });
      throw new Error("rollback proof");
    }));
    assert.equal(await db.collaborationOutboxEvent.count({ where: { dedupeKey: `annotation-changed:${fixture.asset.id}:${operationId}-rollback` } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("dispatchTextPolicyChangedOutboxEvent is dataset-scoped (no assetId) and keyed by policy revision, not operation id", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createCollaborationFixture();
  try {
    const result = await runCollaborationTransaction((tx) => dispatchTextPolicyChangedOutboxEvent(tx, { datasetId: fixture.dataset.id, actorId: fixture.owner.id, policyRevision: 7 }));
    const event = await db.collaborationOutboxEvent.findUniqueOrThrow({
      where: { dedupeKey: `text-policy-changed:${fixture.dataset.id}:7` },
      select: { type: true, datasetId: true, assetId: true, payload: true, jobId: true },
    });
    assert.equal(event.jobId, result.jobId);
    assert.equal(event.type, "TEXT_POLICY_CHANGED");
    assert.equal(event.datasetId, fixture.dataset.id);
    assert.equal(event.assetId, null);
    assert.deepEqual(event.payload, { datasetId: fixture.dataset.id, policyRevision: 7 });

    // A second write at the same policy revision is the same dedupe key --
    // reused, not duplicated (matches every other outbox event's semantics).
    const reused = await runCollaborationTransaction((tx) => dispatchTextPolicyChangedOutboxEvent(tx, { datasetId: fixture.dataset.id, actorId: fixture.owner.id, policyRevision: 7 }));
    assert.equal(reused.jobId, result.jobId);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { dedupeKey: `text-policy-changed:${fixture.dataset.id}:7` } }), 1);
  } finally {
    await fixture.cleanup();
  }
});
