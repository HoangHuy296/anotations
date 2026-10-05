import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { Modality, AnnotationSource, AnnotationStatus } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { runGuardedTextAssetCommand, runGuardedTextDatasetCommand, rejectTextCommand } from "../../src/lib/annotations/text-command-service.js";
import { createWorkspaceUser, createWorkspaceDataset, addWorkspaceMember, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";
import { DatasetMemberRole, UserRole } from "@internal/db";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

/**
 * T037: proves the shared guarded-transaction primitives (T033-T036) using
 * generic guarded-row operations, not unimplemented span/classification/
 * relation commands -- those are proven per-command in their own stories
 * once they exist.
 */

async function seedTextAsset(datasetId: string) {
  return db.asset.create({
    data: { datasetId, modality: Modality.TEXT, filename: `${workspaceUnique("foundation")}.txt`, mimeType: "text/plain", sourceFingerprint: workspaceUnique("foundation") },
    select: { id: true, revision: true },
  });
}

async function genericCreateApply(tx: Parameters<Parameters<typeof runGuardedTextAssetCommand>[2]>[0], ctx: { assetId: string; datasetId: string; actorId: string }) {
  const annotation = await tx.annotation.create({
    data: { datasetId: ctx.datasetId, assetId: ctx.assetId, createdById: ctx.actorId, modality: Modality.TEXT, type: "NAMED_ENTITY_RECOGNITION", source: AnnotationSource.MANUAL, geometry: {}, properties: {}, status: AnnotationStatus.DRAFT },
    select: { id: true, revision: true },
  });
  return { annotationId: annotation.id, revision: annotation.revision };
}

test("runGuardedTextAssetCommand: a generic guarded create succeeds under a real Serializable transaction and advances the parent Asset revision", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const asset = await seedTextAsset(dataset.id);
  try {
    const outcome = await runGuardedTextAssetCommand(owner, { datasetId: dataset.id, assetId: asset.id, operationId: "op-create-1", hash: { commandKind: "test.create", data: { seed: 1 } } }, genericCreateApply);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.replayed, false);

    const refreshedAsset = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { revision: true } });
    assert.equal(refreshedAsset.revision, asset.revision + 1);
    const refreshedDataset = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textMutationRevision: true } });
    assert.equal(refreshedDataset.textMutationRevision, 1);
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("runGuardedTextAssetCommand: identical receipt replay returns the committed outcome without advancing Asset revision or creating a second row", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const asset = await seedTextAsset(dataset.id);
  try {
    const input = { datasetId: dataset.id, assetId: asset.id, operationId: "op-replay-1", hash: { commandKind: "test.create", data: { seed: 42 } } };
    const first = await runGuardedTextAssetCommand(owner, input, genericCreateApply);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.replayed, false);

    const afterFirst = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { revision: true } });
    const annotationCountAfterFirst = await db.annotation.count({ where: { assetId: asset.id } });

    const replay = await runGuardedTextAssetCommand(owner, input, genericCreateApply);
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);

    const afterReplay = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { revision: true } });
    assert.equal(afterReplay.revision, afterFirst.revision, "replay must not advance the editable-asset revision");
    assert.equal(await db.annotation.count({ where: { assetId: asset.id } }), annotationCountAfterFirst, "replay must not create a second row");

    // Per data-model.md, the Dataset mutation guard IS claimed on every
    // attempt (including a replay) to serialize concurrent TEXT writes --
    // only the editable-asset claim/receipt/child-write is skipped on replay.
    const refreshedDataset = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textMutationRevision: true } });
    assert.equal(refreshedDataset.textMutationRevision, 2);
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("runGuardedTextAssetCommand: a duplicate operation id with a changed payload conflicts instead of silently replaying", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const asset = await seedTextAsset(dataset.id);
  try {
    const operationId = "op-conflict-1";
    const first = await runGuardedTextAssetCommand(owner, { datasetId: dataset.id, assetId: asset.id, operationId, hash: { commandKind: "test.create", data: { seed: "a" } } }, genericCreateApply);
    assert.equal(first.ok, true);

    const changed = await runGuardedTextAssetCommand(owner, { datasetId: dataset.id, assetId: asset.id, operationId, hash: { commandKind: "test.create", data: { seed: "b" } } }, genericCreateApply);
    assert.deepEqual(changed, { ok: false, reason: "RECEIPT_CONFLICT" });
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("runGuardedTextAssetCommand: a stale expected revision inside apply rolls back the parent guard claim entirely", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const asset = await seedTextAsset(dataset.id);
  const seeded = await db.annotation.create({
    data: { datasetId: dataset.id, assetId: asset.id, createdById: owner.id, modality: Modality.TEXT, type: "NAMED_ENTITY_RECOGNITION", source: AnnotationSource.MANUAL, geometry: {}, properties: {}, status: AnnotationStatus.DRAFT },
    select: { id: true, revision: true },
  });
  try {
    const assetBefore = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { revision: true } });
    const datasetBefore = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textMutationRevision: true } });

    const staleUpdate = await runGuardedTextAssetCommand(
      owner,
      { datasetId: dataset.id, assetId: asset.id, operationId: "op-stale-1", hash: { commandKind: "test.update", data: { annotationId: seeded.id, expectedRevision: seeded.revision + 5 } } },
      async (tx, ctx) => {
        const changed = await tx.annotation.updateMany({ where: { id: seeded.id, assetId: ctx.assetId, revision: seeded.revision + 5 }, data: { revision: { increment: 1 } } });
        if (changed.count !== 1) rejectTextCommand("CONFLICT");
        return { ok: true };
      },
    );
    assert.deepEqual(staleUpdate, { ok: false, reason: "CONFLICT" });

    // The Dataset guard claim made before `apply` ran must roll back with it.
    const assetAfter = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { revision: true } });
    const datasetAfter = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textMutationRevision: true } });
    assert.equal(assetAfter.revision, assetBefore.revision, "a rejected command must not leave the Asset revision claimed");
    assert.equal(datasetAfter.textMutationRevision, datasetBefore.textMutationRevision, "a rejected command must not leave the Dataset guard claimed");
    assert.equal(await db.annotationMutationReceipt.count({ where: { assetId: asset.id, operationId: "op-stale-1" } }), 0, "no receipt for a rejected command");

    const unchangedAnnotation = await db.annotation.findUniqueOrThrow({ where: { id: seeded.id }, select: { revision: true } });
    assert.equal(unchangedAnnotation.revision, seeded.revision, "the child row itself must be untouched by the rejected command");
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("runGuardedTextAssetCommand: NOT_FOUND for a nonexistent asset, FORBIDDEN concealed as NOT_FOUND for a non-member", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const asset = await seedTextAsset(dataset.id);
  try {
    const missingAsset = await runGuardedTextAssetCommand(owner, { datasetId: dataset.id, assetId: "does-not-exist", operationId: "op-missing", hash: { commandKind: "test.create", data: {} } }, genericCreateApply);
    assert.deepEqual(missingAsset, { ok: false, reason: "NOT_FOUND" });

    const forbidden = await runGuardedTextAssetCommand(outsider, { datasetId: dataset.id, assetId: asset.id, operationId: "op-forbidden", hash: { commandKind: "test.create", data: {} } }, genericCreateApply);
    assert.deepEqual(forbidden, { ok: false, reason: "NOT_FOUND" });
  } finally {
    await cleanupWorkspaceFixture([owner.id, outsider.id], [dataset.id]);
  }
});

test("runGuardedTextDatasetCommand: a dataset-only policy-style command claims the Dataset guard without touching any Asset revision", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const asset = await seedTextAsset(dataset.id);
  try {
    const outcome = await runGuardedTextDatasetCommand(owner, { datasetId: dataset.id, permission: "label.manage" }, async (tx, ctx) => {
      await tx.dataset.update({ where: { id: ctx.datasetId }, data: { textPolicyRevision: { increment: 1 } } });
      return { newRevision: 2 };
    });
    assert.deepEqual(outcome, { ok: true, result: { newRevision: 2 } });

    const refreshedAsset = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { revision: true } });
    assert.equal(refreshedAsset.revision, asset.revision, "a policy write must never claim an arbitrary asset");

    const refreshedDataset = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true, textMutationRevision: true } });
    assert.equal(refreshedDataset.textPolicyRevision, 2);
    assert.equal(refreshedDataset.textMutationRevision, 1);
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("runGuardedTextDatasetCommand: LABELER lacks label.manage and is forbidden", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
  try {
    const outcome = await runGuardedTextDatasetCommand(labeler, { datasetId: dataset.id, permission: "label.manage" }, async () => ({ never: true }));
    assert.deepEqual(outcome, { ok: false, reason: "FORBIDDEN" });
  } finally {
    await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]);
  }
});
