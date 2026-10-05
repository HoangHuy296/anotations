import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { createTextSpan } from "../../src/lib/annotations/text-span-service.js";
import { replaceClassification } from "../../src/lib/annotations/text-classification-service.js";
import { createLabelWithTextEligibility } from "../../src/lib/workspace/label-management.js";
import { writeTextPolicy } from "../../src/lib/annotations/text-policy-write-service.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T099-T101/T103 (US3): `replaceClassification` -- document-level
 * classification, atomic full-membership replacement for both SINGLE and
 * MULTI groups (see `text-classification.ts`'s doc comment for why there is
 * one command, not two). Mirrors `text-relation-commands.test.ts`'s
 * fixture/assertion conventions.
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
  return (await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { textPolicyRevision: true } })).textPolicyRevision;
}

async function makeGroupFixture(owner: Awaited<ReturnType<typeof createWorkspaceUser>>, datasetId: string, cardinality: "SINGLE" | "MULTI") {
  const positive = await createLabelWithTextEligibility(owner, { datasetId, name: workspaceUnique("Positive"), color: "#22C55E", description: null, hotkey: null, textEligibility: "SENTIMENT" });
  const negative = await createLabelWithTextEligibility(owner, { datasetId, name: workspaceUnique("Negative"), color: "#EF4444", description: null, hotkey: null, textEligibility: "SENTIMENT" });
  const neutral = await createLabelWithTextEligibility(owner, { datasetId, name: workspaceUnique("Neutral"), color: "#6B7280", description: null, hotkey: null, textEligibility: "SENTIMENT" });
  assert.equal(positive.ok, true); assert.equal(negative.ok, true); assert.equal(neutral.ok, true);
  if (!positive.ok || !negative.ok || !neutral.ok) throw new Error("label creation failed");

  const groupId = "sentiment";
  const expectedRevision = await currentPolicyRevision(datasetId);
  const policyWrite = await writeTextPolicy(owner, datasetId, {
    expectedRevision,
    policy: { schemaVersion: 1, classificationGroups: [{ id: groupId, name: "Sentiment", cardinality, memberLabelIds: [positive.label.id, negative.label.id, neutral.label.id] }], relationTypes: [] },
  });
  assert.equal(policyWrite.ok, true);
  if (!policyWrite.ok) throw new Error("policy write failed");
  return { groupId, positiveId: positive.label.id, negativeId: negative.label.id, neutralId: neutral.label.id, expectedPolicyRevision: policyWrite.revision };
}

test("replaceClassification: a SINGLE group accepts 0 or 1 member, rejects 2, and atomically swaps the selected category", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("classification-single"), "This product is great.");
  try {
    const { groupId, positiveId, negativeId, expectedPolicyRevision } = await makeGroupFixture(fixture.owner, fixture.dataset.id, "SINGLE");

    const rejectedTwo = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-two", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [positiveId, negativeId], expectedMembers: [] },
    });
    assert.deepEqual(rejectedTwo, { ok: false, reason: "INVALID_REQUEST" });

    const selectPositive = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-positive", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [positiveId], expectedMembers: [] },
    });
    assert.equal(selectPositive.ok, true);
    if (!selectPositive.ok || selectPositive.replayed) return;
    assert.equal(selectPositive.result.length, 1);
    assert.equal(selectPositive.result[0]?.labelId, positiveId);
    assert.equal(selectPositive.result[0]?.geometry.kind, "text-document");

    // Atomic swap: positive -> negative in one command, using the current membership as expectedMembers.
    const swapToNegative = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-swap", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [negativeId], expectedMembers: [{ id: selectPositive.result[0]!.id, revision: selectPositive.result[0]!.revision }] },
    });
    assert.equal(swapToNegative.ok, true);
    if (!swapToNegative.ok || swapToNegative.replayed) return;
    assert.equal(swapToNegative.result.length, 1);
    assert.equal(swapToNegative.result[0]?.labelId, negativeId);

    const remaining = await db.annotation.count({ where: { assetId: fixture.asset.id, type: { in: ["SENTIMENT"] } } });
    assert.equal(remaining, 1, "the old selection was actually removed, not left alongside the new one");

    // Remove entirely: empty membership.
    const cleared = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-clear", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [], expectedMembers: [{ id: swapToNegative.result[0]!.id, revision: swapToNegative.result[0]!.revision }] },
    });
    assert.equal(cleared.ok, true);
    if (!cleared.ok || cleared.replayed) return;
    assert.equal(cleared.result.length, 0);
    assert.equal(await db.annotation.count({ where: { assetId: fixture.asset.id, type: { in: ["SENTIMENT"] } } }), 0);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("replaceClassification: a stale expectedMembers set (built against an outdated membership) is rejected as REVISION_STALE and cannot remove a newer category", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("classification-stale"), "This product is great.");
  try {
    const { groupId, positiveId, negativeId, expectedPolicyRevision } = await makeGroupFixture(fixture.owner, fixture.dataset.id, "SINGLE");

    // Two editors both start from "empty" (expectedMembers: []).
    const editorA = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-a", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [positiveId], expectedMembers: [] },
    });
    assert.equal(editorA.ok, true);
    if (!editorA.ok || editorA.replayed) return;

    // Editor B still believes the group is empty -- stale.
    const editorB = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-b", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [negativeId], expectedMembers: [] },
    });
    assert.deepEqual(editorB, { ok: false, reason: "REVISION_STALE" });

    const persisted = await db.annotation.findMany({ where: { assetId: fixture.asset.id, type: { in: ["SENTIMENT"] } }, select: { labelId: true } });
    assert.deepEqual(persisted.map((row) => row.labelId), [positiveId], "editor A's category must survive editor B's stale attempt");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("replaceClassification: an explicit MULTI-label policy allows independently-removable distinct categories that survive reload; duplicate membership is rejected", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("classification-multi"), "This product is great.");
  try {
    const { groupId, positiveId, negativeId, neutralId, expectedPolicyRevision } = await makeGroupFixture(fixture.owner, fixture.dataset.id, "MULTI");

    const duplicate = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-duplicate", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [positiveId, positiveId], expectedMembers: [] },
    });
    assert.deepEqual(duplicate, { ok: false, reason: "INVALID_REQUEST" });

    const addTwo = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-add-two", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [positiveId, neutralId], expectedMembers: [] },
    });
    assert.equal(addTwo.ok, true);
    if (!addTwo.ok || addTwo.replayed) return;
    assert.equal(addTwo.result.length, 2);
    assert.deepEqual(new Set(addTwo.result.map((row) => row.labelId)), new Set([positiveId, neutralId]));

    // Independently remove `neutral`, keep `positive`, add `negative` -- one command expressing "current members minus one plus one".
    const positiveRow = addTwo.result.find((row) => row.labelId === positiveId)!;
    const neutralRow = addTwo.result.find((row) => row.labelId === neutralId)!;
    const swapNeutralForNegative = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-swap-one", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [positiveId, negativeId], expectedMembers: [{ id: positiveRow.id, revision: positiveRow.revision }, { id: neutralRow.id, revision: neutralRow.revision }] },
    });
    assert.equal(swapNeutralForNegative.ok, true);
    if (!swapNeutralForNegative.ok || swapNeutralForNegative.replayed) return;
    assert.equal(swapNeutralForNegative.result.length, 2);
    assert.deepEqual(new Set(swapNeutralForNegative.result.map((row) => row.labelId)), new Set([positiveId, negativeId]));
    // `positive`'s own row survived untouched (same id, same revision) -- an independent removal does not disturb unrelated members.
    assert.ok(swapNeutralForNegative.result.some((row) => row.id === positiveRow.id && row.revision === positiveRow.revision));

    const reloaded = await db.annotation.findMany({ where: { assetId: fixture.asset.id, type: { in: ["SENTIMENT"] } }, select: { labelId: true } });
    assert.deepEqual(new Set(reloaded.map((row) => row.labelId)), new Set([positiveId, negativeId]));
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("replaceClassification: editing/removing a document classification does not implicitly change spans, and vice versa", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("classification-isolation"), "This product is great.");
  try {
    const { groupId, positiveId } = await makeGroupFixture(fixture.owner, fixture.dataset.id, "SINGLE");
    const entityLabel = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Org"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(entityLabel.ok, true);
    if (!entityLabel.ok) return;
    // Creating `entityLabel` above bumped `textPolicyRevision` again -- refresh.
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);

    const span = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-span", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 4, labelId: entityLabel.label.id }, // "This"
    });
    assert.equal(span.ok, true);
    if (!span.ok || span.replayed) return;

    const classified = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-classify", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [positiveId], expectedMembers: [] },
    });
    assert.equal(classified.ok, true);
    if (!classified.ok || classified.replayed) return;

    // The span is completely unaffected by the classification write.
    const spanAfter = await db.annotation.findUniqueOrThrow({ where: { id: span.result.id } });
    assert.equal(spanAfter.revision, span.result.revision);
    assert.equal(spanAfter.labelId, entityLabel.label.id);

    // Removing the classification leaves the span alone too.
    const removed = await replaceClassification(fixture.owner, fixture.asset.id, {
      operationId: "op-unclassify", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "replaceClassification", groupId, memberLabelIds: [], expectedMembers: [{ id: classified.result[0]!.id, revision: classified.result[0]!.revision }] },
    });
    assert.equal(removed.ok, true);
    const spanAfterRemoval = await db.annotation.findUniqueOrThrow({ where: { id: span.result.id } });
    assert.equal(spanAfterRemoval.revision, span.result.revision);

    // And the span still exists as the only remaining annotation.
    const remainingTypes = await db.annotation.findMany({ where: { assetId: fixture.asset.id }, select: { type: true } });
    assert.deepEqual(remainingTypes.map((row) => row.type), ["NAMED_ENTITY_RECOGNITION"]);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});
