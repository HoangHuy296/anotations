import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AssetAssignmentType, DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { getAssetAssignments, upsertAssetAssignment } from "../../src/lib/collaboration/asset-assignment-service.js";
import { createAssetComment, listAssetComments } from "../../src/lib/collaboration/asset-comment-service.js";
import { createTextSpan } from "../../src/lib/annotations/text-span-service.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique, addWorkspaceMember } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T137/T138/T141/T146 (US6): TEXT participates in the existing, entirely
 * generic collaboration system -- `asset-assignment-service.ts` and
 * `asset-comment-service.ts` have no modality branch at all (confirmed by
 * inspection, T142/T143), so these tests prove that reuse actually holds
 * for a TEXT asset, the same way the US5 workflow tests proved the generic
 * workflow service holds. T139 (invalidation) and T140 (presence privacy)
 * are covered elsewhere: T139 by the `applyRemoteAnnotations` fix and its
 * tests (T144's note), T140 by the pre-existing generic, modality-agnostic
 * `presence.integration.test.ts` (`apps/realtime`) and
 * `collaboration-presence.vitest.spec.tsx` plus the payload type itself
 * having no content field at any layer (T145's note).
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
  return {
    owner, dataset, asset, sourceIdentity,
    cleanup: async () => {
      await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
      await minio.removeObject(config.MINIO_BUCKET, boundaryArtifactKey).catch(() => undefined);
    },
  };
}

async function currentPolicyRevision(datasetId: string) {
  return (await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { textPolicyRevision: true } })).textPolicyRevision;
}

test("T137: owner assigns ANNOTATION/REVIEW Responsibilities to a TEXT asset exactly as for any other modality", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("text-collab-assign"), "OpenAI builds AI.");
  const annotator = await createWorkspaceUser(UserRole.LABELER);
  const reviewer = await createWorkspaceUser(UserRole.REVIEWER);
  try {
    await addWorkspaceMember(fixture.dataset.id, annotator.id, DatasetMemberRole.LABELER);
    await addWorkspaceMember(fixture.dataset.id, reviewer.id, DatasetMemberRole.REVIEWER);

    const assignAnnotation = await upsertAssetAssignment(fixture.owner, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, type: AssetAssignmentType.ANNOTATION, userId: annotator.id });
    const assignReview = await upsertAssetAssignment(fixture.owner, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, type: AssetAssignmentType.REVIEW, userId: reviewer.id });
    assert.ok(assignAnnotation);
    assert.ok(assignReview);

    const { assignments } = await getAssetAssignments(fixture.owner, { datasetId: fixture.dataset.id, assetId: fixture.asset.id });
    const byType = new Map(assignments.map((row) => [row.type, row.userId]));
    assert.equal(byType.get(AssetAssignmentType.ANNOTATION), annotator.id);
    assert.equal(byType.get(AssetAssignmentType.REVIEW), reviewer.id);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id, annotator.id, reviewer.id], [fixture.dataset.id]);
  }
});

test("T138: Discussion on a TEXT asset uses the existing generic asset-comment service; a comment never appears in annotation custom properties", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("text-collab-discussion"), "OpenAI builds AI.");
  try {
    const secret = `discussion-body-${workspaceUnique("marker")}`;
    const posted = await createAssetComment(fixture.owner, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, body: secret });
    assert.ok(posted.commentId);

    const comments = await listAssetComments(fixture.owner, fixture.dataset.id, fixture.asset.id);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.body, secret);

    // A TEXT annotation on the same asset -- Discussion storage and
    // annotation storage are completely separate tables; the comment body
    // must never leak into (or be derivable from) annotation properties.
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const span = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-span", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.equal(span.ok, true);
    if (!span.ok || span.replayed) return;
    const persistedSpan = await db.annotation.findUniqueOrThrow({ where: { id: span.result.id } });
    assert.deepEqual(persistedSpan.properties, { custom: {} });
    assert.equal(JSON.stringify(persistedSpan.properties).includes(secret), false);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("T141/T146: membership removal denies further protected TEXT reads/writes immediately", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("text-collab-revoke"), "OpenAI builds AI.");
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  try {
    await addWorkspaceMember(fixture.dataset.id, labeler.id, DatasetMemberRole.LABELER);
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);

    // While still a member, the labeler can create a span.
    const whileMember = await createTextSpan(labeler, fixture.asset.id, {
      operationId: "op-while-member", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.equal(whileMember.ok, true);

    // Revoke membership entirely.
    await db.datasetMember.delete({ where: { datasetId_userId: { datasetId: fixture.dataset.id, userId: labeler.id } } });

    const afterRevocation = await createTextSpan(labeler, fixture.asset.id, {
      operationId: "op-after-revocation", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 7, endOffset: 13, labelId: null },
    });
    assert.deepEqual(afterRevocation, { ok: false, reason: "NOT_FOUND" }, "a revoked member's TEXT write is concealed as NOT_FOUND, not a distinguishable FORBIDDEN");
    assert.equal(await db.annotation.count({ where: { assetId: fixture.asset.id, id: { not: whileMember.ok && !whileMember.replayed ? whileMember.result.id : undefined } } }), 0, "no partial write from the denied attempt");

    // Discussion access is denied the same way.
    await assert.rejects(() => createAssetComment(labeler, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, body: "should not be allowed" }));
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id, labeler.id], [fixture.dataset.id]);
  }
});
