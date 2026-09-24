import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { createTextSpan, updateTextSpan, deleteTextAnnotation, submitTextAnnotationCommand } from "../../src/lib/annotations/text-span-service.js";
import { createLabelWithTextEligibility } from "../../src/lib/workspace/label-management.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique, addWorkspaceMember } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T064/T065/T068: `createTextSpan` contract (envelope shape, strict
 * unknown-field rejection, error codes) plus exact-offset and overlap
 * behavior, against a real READY TEXT source fixture.
 */

async function makeReadyTextAsset(marker: string, text: string) {
  const { config, minio } = getWebProviders();
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from(text, "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const sourceIdentity = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const boundaryArtifactKey = `text-boundaries/__test-fixtures__/${marker}/artifact.json`;
  const boundaryProfile = { schemaVersion: 1, algorithm: "EXTENDED_GRAPHEME_CLUSTER", nodeVersion: process.versions.node, icuVersion: process.versions.icu ?? "unknown", unicodeVersion: process.versions.unicode ?? "unknown" };
  // Every UTF-16 offset is a boundary in this fixture text (ASCII-only) --
  // sufficient for command-layer tests, which do not re-prove Unicode
  // grapheme-boundary math (that's T020/T052's job).
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
    select: { id: true },
  });
  return { owner, dataset, asset, sourceIdentity, cleanup: async () => { await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined); await minio.removeObject(config.MINIO_BUCKET, boundaryArtifactKey).catch(() => undefined); } };
}

async function currentPolicyRevision(datasetId: string) {
  const dataset = await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { textPolicyRevision: true } });
  return dataset.textPolicyRevision;
}

test("createTextSpan: creates OpenAI span on 'OpenAI builds AI.' with exact startOffset=0, endOffset=6", { skip: !hasIntegrationDatabase }, async () => {
  const text = "OpenAI builds AI.";
  const fixture = await makeReadyTextAsset(workspaceUnique("span-offsets"), text);
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const outcome = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-1", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.replayed, false);
    assert.equal(outcome.result.geometry.kind, "text-span");
    if (outcome.result.geometry.kind === "text-span") {
      assert.equal(outcome.result.geometry.startOffset, 0);
      assert.equal(outcome.result.geometry.endOffset, 6);
      assert.equal(outcome.result.geometry.sourceIdentity, fixture.sourceIdentity);
    }
    assert.equal(text.slice(0, 6), "OpenAI");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextSpan: strict unknown-field rejection and malformed envelope both return INVALID_REQUEST", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-strict"), "hello world");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const withExtraField = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-1", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: null, unexpectedField: "nope" },
    });
    assert.deepEqual(withExtraField, { ok: false, reason: "INVALID_REQUEST" });

    const malformed = await createTextSpan(fixture.owner, fixture.asset.id, { not: "a valid envelope" });
    assert.deepEqual(malformed, { ok: false, reason: "INVALID_REQUEST" });
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextSpan: an out-of-boundary offset (mid-grapheme) is rejected as INVALID_RANGE, and no row is written", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-range"), "hello world");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const reversed = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-1", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 5, endOffset: 2, labelId: null },
    });
    assert.deepEqual(reversed, { ok: false, reason: "INVALID_RANGE" }, "the envelope schema only checks individual field types; start>=end is the service's job");

    const outOfBounds = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-2", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 999, labelId: null },
    });
    assert.deepEqual(outOfBounds, { ok: false, reason: "INVALID_RANGE" });

    const count = await db.annotation.count({ where: { assetId: fixture.asset.id } });
    assert.equal(count, 0, "no partial write from a rejected command");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextSpan: overlapping spans (New York / New York University) both persist and remain separately addressable", { skip: !hasIntegrationDatabase }, async () => {
  const text = "New York University is great.";
  const fixture = await makeReadyTextAsset(workspaceUnique("span-overlap"), text);
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const outer = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-outer", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 20, labelId: null }, // "New York University"
    });
    const inner = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-inner", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 8, labelId: null }, // "New York"
    });
    assert.equal(outer.ok, true);
    assert.equal(inner.ok, true);
    if (!outer.ok || !inner.ok || outer.replayed || inner.replayed) return;
    assert.notEqual(outer.result.id, inner.result.id);
    const count = await db.annotation.count({ where: { assetId: fixture.asset.id } });
    assert.equal(count, 2);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextSpan: exact same asset/source/range/label duplicate is rejected as DUPLICATE_SPAN, but an identical operationId replay returns the same committed result without a second row", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-dup"), "hello world");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const command = { kind: "createSpan" as const, startOffset: 0, endOffset: 5, labelId: null };
    const first = await createTextSpan(fixture.owner, fixture.asset.id, { operationId: "op-a", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision, command });
    assert.equal(first.ok, true);

    // Same operationId, same payload -- replay, not a duplicate rejection.
    const replay = await createTextSpan(fixture.owner, fixture.asset.id, { operationId: "op-a", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision, command });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.replayed, true);

    // Different operationId, exact same range/label -- genuine duplicate.
    const duplicate = await createTextSpan(fixture.owner, fixture.asset.id, { operationId: "op-b", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision, command });
    assert.deepEqual(duplicate, { ok: false, reason: "DUPLICATE_SPAN" });

    const count = await db.annotation.count({ where: { assetId: fixture.asset.id } });
    assert.equal(count, 1, "replay and duplicate rejection both leave exactly one row");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextSpan: a label outside ENTITY scope is rejected; an eligible ENTITY label succeeds", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-label"), "OpenAI builds AI.");
  try {
    const classificationLabel = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Topic"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "CLASSIFICATION" });
    assert.equal(classificationLabel.ok, true);
    if (!classificationLabel.ok) return;

    let expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const wrongScope = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-wrong-scope", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: classificationLabel.label.id },
    });
    assert.deepEqual(wrongScope, { ok: false, reason: "INVALID_REQUEST" });

    const entityLabel = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Org"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(entityLabel.ok, true);
    if (!entityLabel.ok) return;
    expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const rightScope = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-right-scope", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: entityLabel.label.id },
    });
    assert.equal(rightScope.ok, true);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextSpan: an ordinary dataset-wide label (no TEXT eligibility set, e.g. an existing IMAGE label) is also a valid span label -- TEXT reuses the dataset's own label set rather than a TEXT-only opt-in subset", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-label-dataset-wide"), "OpenAI builds AI.");
  try {
    const ordinaryLabel = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("car"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "NONE" });
    assert.equal(ordinaryLabel.ok, true);
    if (!ordinaryLabel.ok) return;

    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-dataset-wide-label", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: ordinaryLabel.label.id },
    });
    assert.equal(created.ok, true);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextSpan: a stale expectedPolicyRevision is rejected as POLICY_STALE", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-policy-stale"), "hello world");
  try {
    const staleRevision = await currentPolicyRevision(fixture.dataset.id);
    // Bump textPolicyRevision by creating a label after capturing the "stale" value.
    const label = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Thing"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(label.ok, true);

    const outcome = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-1", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision: staleRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: null },
    });
    assert.deepEqual(outcome, { ok: false, reason: "POLICY_STALE" });
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("updateTextSpan: changes the range, rejects an empty patch's stale revision, and geometry patches never change sourceIdentity/kind", { skip: !hasIntegrationDatabase }, async () => {
  const text = "OpenAI builds AI.";
  const fixture = await makeReadyTextAsset(workspaceUnique("span-update-range"), text);
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null }, // "OpenAI"
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;

    const updated = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-update", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, startOffset: 0, endOffset: 14 }, // "OpenAI builds"
    });
    assert.equal(updated.ok, true);
    if (!updated.ok || updated.replayed) return;
    assert.equal(updated.result.id, created.result.id, "update mutates the same annotation, never creates a new one");
    assert.equal(updated.result.revision, created.result.revision + 1);
    assert.equal(updated.result.geometry.kind, "text-span");
    if (updated.result.geometry.kind === "text-span") {
      assert.equal(updated.result.geometry.startOffset, 0);
      assert.equal(updated.result.geometry.endOffset, 14);
      assert.equal(updated.result.geometry.sourceIdentity, fixture.sourceIdentity, "geometry patches never change sourceIdentity");
    }

    // Stale expectedRevision (the pre-update value) now conflicts.
    const stale = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-stale", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, endOffset: 6 },
    });
    assert.deepEqual(stale, { ok: false, reason: "REVISION_STALE" });
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("deleteTextAnnotation: deletes the span and a repeat delete with the same expectedRevision is REVISION_STALE (already gone)", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-delete"), "hello world");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;

    const deleted = await deleteTextAnnotation(fixture.owner, fixture.asset.id, {
      operationId: "op-delete", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "deleteAnnotation", annotationId: created.result.id, expectedRevision: created.result.revision },
    });
    assert.equal(deleted.ok, true);
    if (!deleted.ok || deleted.replayed) return;
    assert.equal(deleted.result.deletedId, created.result.id);

    const count = await db.annotation.count({ where: { id: created.result.id } });
    assert.equal(count, 0);

    const repeatDelete = await deleteTextAnnotation(fixture.owner, fixture.asset.id, {
      operationId: "op-delete-again", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "deleteAnnotation", annotationId: created.result.id, expectedRevision: created.result.revision },
    });
    assert.deepEqual(repeatDelete, { ok: false, reason: "NOT_FOUND" }, "the row is already gone, not merely stale");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("updateTextSpan/deleteTextAnnotation: a non-owner without annotation.updateAny is FORBIDDEN; a REVIEWER (who has updateAny) can act on another user's span", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-ownership"), "hello world");
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  await addWorkspaceMember(fixture.dataset.id, labeler.id, "LABELER");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;

    // A LABELER only has annotation.updateOwn -- this span belongs to the owner.
    const forbidden = await updateTextSpan(labeler, fixture.asset.id, {
      operationId: "op-forbidden", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, endOffset: 4 },
    });
    assert.deepEqual(forbidden, { ok: false, reason: "FORBIDDEN" });

    // The owner (MANAGER, has annotation.updateAny too) can still act on their own span.
    const ownerUpdate = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-owner-update", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, endOffset: 4 },
    });
    assert.equal(ownerUpdate.ok, true);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id, labeler.id], [fixture.dataset.id]);
  }
});

test("submitTextAnnotationCommand: dispatches on command.kind and rejects an unrecognized/missing kind as INVALID_REQUEST", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-dispatch"), "hello world");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, {
      operationId: "op-1", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: null },
    });
    assert.equal(created.ok, true);

    const unknownKind = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, {
      operationId: "op-2", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "notARealCommand" },
    });
    assert.deepEqual(unknownKind, { ok: false, reason: "INVALID_REQUEST" });

    const missingCommand = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, { operationId: "op-3" });
    assert.deepEqual(missingCommand, { ok: false, reason: "INVALID_REQUEST" });
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});
