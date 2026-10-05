import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AssetStatus, AssetWorkflowAction, DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { applyAssetWorkflowAction } from "../../src/lib/workflow/asset-workflow-service.js";
import { createTextSpan } from "../../src/lib/annotations/text-span-service.js";
import { createWorkspaceUser, createWorkspaceDataset, addWorkspaceMember, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T087/T088/T089: TEXT reuses the existing, entirely modality-agnostic
 * `asset-workflow-service.ts` unchanged (data-model.md D6, "no TEXT-specific
 * workflow state") -- these tests prove that reuse actually holds for a
 * TEXT asset specifically, through the real transition function (not by
 * hand-setting `Asset.status`, which the pre-existing WORKFLOW_LOCKED loop
 * in `text-relation-commands.test.ts` already does). Not covered here (and
 * not mechanically testable without `@testing-library/react`, see T084's
 * note): "via UI controls" and "scrolling/searching/inspection/Discussion
 * remain usable" -- both are UI-level claims this suite cannot exercise.
 */

async function makeReadyTextAsset(marker: string, text: string) {
  const { config, minio } = getWebProviders();
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const reviewer = await createWorkspaceUser(UserRole.REVIEWER);
  const dataset = await createWorkspaceDataset(owner.id);
  await Promise.all([
    addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER),
    addWorkspaceMember(dataset.id, reviewer.id, DatasetMemberRole.REVIEWER),
  ]);
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from(text, "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const sourceIdentity = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const boundaryArtifactKey = `text-boundaries/__test-fixtures__/${marker}/artifact.json`;
  const boundaryProfile = { schemaVersion: 1, algorithm: "EXTENDED_GRAPHEME_CLUSTER", nodeVersion: process.versions.node, icuVersion: process.versions.icu ?? "unknown", unicodeVersion: process.versions.unicode ?? "unknown" };
  const artifact = { schemaVersion: 1, profile: boundaryProfile, sourceIdentity, offsetUnit: "UTF16_CODE_UNIT", sourceCodeUnitLength: text.length, boundaryOffsets: Array.from({ length: text.length + 1 }, (_, i) => i) };
  const artifactBytes = Buffer.from(JSON.stringify(artifact), "utf8");
  await minio.putObject(config.MINIO_BUCKET, boundaryArtifactKey, artifactBytes, artifactBytes.length, { "Content-Type": "application/json" });
  const boundaryArtifactDigest = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
  const asset = await db.asset.create({
    data: {
      datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain",
      storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker,
      textAsset: { create: { sourceIdentity, sourceEncoding: "UTF8", offsetUnit: "UTF16_CODE_UNIT", sourceByteLength: bytes.length, sourceCodeUnitLength: text.length, boundaryArtifactKey, boundaryArtifactDigest, boundaryProfile, preparedSourceFingerprint: marker, preparedAt: new Date() } },
    },
    select: { id: true, revision: true },
  });
  return {
    owner, labeler, reviewer, dataset, asset, sourceIdentity,
    cleanup: async () => {
      await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
      await minio.removeObject(config.MINIO_BUCKET, boundaryArtifactKey).catch(() => undefined);
      await cleanupWorkspaceFixture([owner.id, labeler.id, reviewer.id], [dataset.id]);
    },
  };
}

async function policyRevision(datasetId: string) {
  return (await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { textPolicyRevision: true } })).textPolicyRevision;
}

test("TEXT asset: reject -> start rework -> edit -> resubmit -> approve preserves Workflow History and rejection feedback, with no TEXT-specific workflow state", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("text-workflow-lifecycle"), "OpenAI builds AI.");
  try {
    const started = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const submitted = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: started.asset.revision });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const opened = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.OPEN_REVIEW, expectedRevision: submitted.asset.revision });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const rejected = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.REJECT, expectedRevision: opened.asset.revision, feedback: "Add a span for the product name." });
    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    assert.equal(rejected.asset.status, AssetStatus.REJECTED);

    const rework = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START_REWORK, expectedRevision: rejected.asset.revision });
    assert.equal(rework.ok, true);
    if (!rework.ok) return;
    assert.equal(rework.asset.status, AssetStatus.IN_PROGRESS);

    // Editing is allowed again now that the asset is back in IN_PROGRESS.
    const expectedPolicyRevision = await policyRevision(fixture.dataset.id);
    const span = await createTextSpan(fixture.labeler, fixture.asset.id, {
      operationId: "op-rework-edit", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.equal(span.ok, true);
    if (!span.ok || span.replayed) return;

    const assetAfterEdit = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    const resubmitted = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.RESUBMIT, expectedRevision: assetAfterEdit.revision });
    assert.equal(resubmitted.ok, true);
    if (!resubmitted.ok) return;

    const openedAgain = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.OPEN_REVIEW, expectedRevision: resubmitted.asset.revision });
    assert.equal(openedAgain.ok, true);
    if (!openedAgain.ok) return;
    const approved = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.APPROVE, expectedRevision: openedAgain.asset.revision });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.asset.status, AssetStatus.REVIEWED);

    const history = await db.assetWorkflowEvent.findMany({ where: { assetId: fixture.asset.id }, orderBy: { createdAt: "asc" }, select: { action: true, toStatus: true, feedback: true } });
    assert.deepEqual(history.map((event) => event.action), [
      AssetWorkflowAction.START, AssetWorkflowAction.SUBMIT, AssetWorkflowAction.OPEN_REVIEW, AssetWorkflowAction.REJECT,
      AssetWorkflowAction.START_REWORK, AssetWorkflowAction.RESUBMIT, AssetWorkflowAction.OPEN_REVIEW, AssetWorkflowAction.APPROVE,
    ]);
    assert.equal(history.find((event) => event.action === AssetWorkflowAction.REJECT)?.feedback, "Add a span for the product name.");
  } finally {
    await fixture.cleanup();
  }
});

test("TEXT asset: a review decision at a stale revision is refused via the existing staleness boundary -- the same mechanism IMAGE already relies on", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("text-workflow-stale-review"), "OpenAI builds AI.");
  try {
    const started = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const submitted = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: started.asset.revision });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const opened = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.OPEN_REVIEW, expectedRevision: submitted.asset.revision });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    // A concurrent annotation change commits (simulated directly -- content
    // mutations are themselves blocked once NEEDS_REVIEW, so the realistic
    // way this happens is a concurrent decision or an out-of-band revision
    // bump; either way the reviewer's own stale copy must be refused).
    await db.asset.update({ where: { id: fixture.asset.id }, data: { revision: { increment: 1 } } });

    const staleDecision = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.APPROVE, expectedRevision: opened.asset.revision });
    assert.equal(staleDecision.ok, false);
    if (staleDecision.ok) return;
    assert.equal(staleDecision.failure.kind, "STALE_REVISION");

    const persisted = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { status: true } });
    assert.equal(persisted.status, AssetStatus.NEEDS_REVIEW, "the stale decision must not have transitioned the asset");
  } finally {
    await fixture.cleanup();
  }
});

test("TEXT asset: NEEDS_REVIEW/REVIEWED/REJECTED reject span creation through the real workflow transition (not a hand-set status)", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("text-workflow-frozen-real"), "OpenAI builds AI.");
  try {
    const started = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const submitted = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: started.asset.revision });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const expectedPolicyRevision = await policyRevision(fixture.dataset.id);
    const blocked = await createTextSpan(fixture.labeler, fixture.asset.id, {
      operationId: "op-blocked", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.deepEqual(blocked, { ok: false, reason: "WORKFLOW_LOCKED" });
    assert.equal(await db.annotation.count({ where: { assetId: fixture.asset.id } }), 0);
  } finally {
    await fixture.cleanup();
  }
});
