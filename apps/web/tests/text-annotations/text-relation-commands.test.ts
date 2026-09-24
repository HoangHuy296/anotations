import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { createTextSpan, deleteTextAnnotation, submitTextAnnotationCommand, updateTextSpan } from "../../src/lib/annotations/text-span-service.js";
import { createTextRelation } from "../../src/lib/annotations/text-relation-service.js";
import { createLabelWithTextEligibility } from "../../src/lib/workspace/label-management.js";
import { writeTextPolicy } from "../../src/lib/annotations/text-policy-write-service.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique, addWorkspaceMember } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/** Mirrors `text-span-command-races.test.ts`'s (T072) own barrier helper exactly, for T120's endpoint-race test. */
function barrier(count: number) {
  let arrived = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === count) release?.();
    await gate;
  };
}

/**
 * `createTextRelation` (US4): links two existing TEXT entity spans under a
 * configured `Dataset.textPolicy.relationTypes` entry. Mirrors
 * `text-span-commands.test.ts`'s fixture/assertion conventions exactly --
 * same real MinIO + Postgres source fixture, same guarded-command outcome
 * shape.
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
  const dataset = await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { textPolicyRevision: true } });
  return dataset.textPolicyRevision;
}

/** Creates an ENTITY label, a RELATION label, and a policy allowing the relation type between that entity label and itself (source==target scope). Returns the ids plus the policy revision *after* the write. */
async function makeEligibleRelationFixture(owner: Awaited<ReturnType<typeof createWorkspaceUser>>, datasetId: string) {
  const entityLabel = await createLabelWithTextEligibility(owner, { datasetId, name: workspaceUnique("Org"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
  assert.equal(entityLabel.ok, true);
  if (!entityLabel.ok) throw new Error("entity label creation failed");
  const relationLabel = await createLabelWithTextEligibility(owner, { datasetId, name: workspaceUnique("worksAt"), color: "#8B5CF6", description: null, hotkey: null, textEligibility: "RELATION" });
  assert.equal(relationLabel.ok, true);
  if (!relationLabel.ok) throw new Error("relation label creation failed");

  const expectedRevision = await currentPolicyRevision(datasetId);
  const policyWrite = await writeTextPolicy(owner, datasetId, {
    expectedRevision,
    policy: { schemaVersion: 1, classificationGroups: [], relationTypes: [{ relationLabelId: relationLabel.label.id, allowedSourceLabelIds: [entityLabel.label.id], allowedTargetLabelIds: [entityLabel.label.id], allowUnlabeledSource: false, allowUnlabeledTarget: false }] },
  });
  assert.equal(policyWrite.ok, true);
  if (!policyWrite.ok) throw new Error("policy write failed");

  return { entityLabelId: entityLabel.label.id, relationLabelId: relationLabel.label.id, expectedPolicyRevision: policyWrite.revision };
}

test("createTextRelation: links two entity spans under a configured relation type; a same-operationId replay returns the same result without a second row", { skip: !hasIntegrationDatabase }, async () => {
  const text = "Alice works at Acme.";
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-basic"), text);
  try {
    const { entityLabelId, relationLabelId, expectedPolicyRevision } = await makeEligibleRelationFixture(fixture.owner, fixture.dataset.id);

    const alice = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: entityLabelId }, // "Alice"
    });
    const acme = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-acme", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 15, endOffset: 19, labelId: entityLabelId }, // "Acme" (before the trailing period)
    });
    assert.equal(alice.ok, true);
    assert.equal(acme.ok, true);
    if (!alice.ok || alice.replayed || !acme.ok || acme.replayed) return;
    assert.equal(text.slice(15, 19), "Acme");

    const relation = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-relation", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.equal(relation.ok, true);
    if (!relation.ok) return;
    assert.equal(relation.replayed, false);
    assert.equal(relation.result.geometry.kind, "text-relation");
    assert.equal(relation.result.fromAnnotationId, alice.result.id);
    assert.equal(relation.result.toAnnotationId, acme.result.id);
    assert.equal(relation.result.labelId, relationLabelId);

    // Same operationId, same payload -- replay, not a second row.
    const replay = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-relation", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.replayed, true);

    const relationCount = await db.annotation.count({ where: { assetId: fixture.asset.id, type: "TEXT_RELATION" } });
    assert.equal(relationCount, 1);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextRelation: rejects a self-relation, an unconfigured relation type, and a nonexistent endpoint", { skip: !hasIntegrationDatabase }, async () => {
  const text = "Alice works at Acme.";
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-reject"), text);
  try {
    const { entityLabelId, relationLabelId, expectedPolicyRevision } = await makeEligibleRelationFixture(fixture.owner, fixture.dataset.id);
    const alice = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: entityLabelId },
    });
    const acme = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-acme", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 15, endOffset: 19, labelId: entityLabelId },
    });
    assert.equal(alice.ok, true);
    assert.equal(acme.ok, true);
    if (!alice.ok || alice.replayed || !acme.ok || acme.replayed) return;

    const selfRelation = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-self", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: alice.result.id },
    });
    assert.deepEqual(selfRelation, { ok: false, reason: "INVALID_REQUEST" });

    const unconfiguredType = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-unconfigured", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId: "not-a-configured-relation-type", fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.equal(unconfiguredType.ok, false);

    const missingEndpoint = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-missing", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: "does-not-exist" },
    });
    assert.deepEqual(missingEndpoint, { ok: false, reason: "NOT_FOUND" });

    const relationCount = await db.annotation.count({ where: { assetId: fixture.asset.id, type: "TEXT_RELATION" } });
    assert.equal(relationCount, 0, "no rejected command leaves a partial row");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextRelation: an endpoint label outside the relation type's allowed set is rejected as INVALID_REQUEST", { skip: !hasIntegrationDatabase }, async () => {
  const text = "Alice works at Acme.";
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-endpoint-scope"), text);
  try {
    const { relationLabelId } = await makeEligibleRelationFixture(fixture.owner, fixture.dataset.id);
    const otherEntityLabel = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Place"), color: "#F59E0B", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(otherEntityLabel.ok, true);
    if (!otherEntityLabel.ok) return;

    // `otherEntityLabel` is a real ENTITY label but was never added to the relation type's allowedSourceLabelIds/allowedTargetLabelIds.
    // Creating it above already bumped textPolicyRevision past the fixture's own -- always read fresh before the next command.
    const refreshedRevision = await currentPolicyRevision(fixture.dataset.id);
    const alice = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision: refreshedRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: otherEntityLabel.label.id },
    });
    const acme = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-acme", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision: refreshedRevision,
      command: { kind: "createSpan", startOffset: 15, endOffset: 19, labelId: otherEntityLabel.label.id },
    });
    assert.equal(alice.ok, true);
    assert.equal(acme.ok, true);
    if (!alice.ok || alice.replayed || !acme.ok || acme.replayed) return;

    const rejected = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-relation", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision: refreshedRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.deepEqual(rejected, { ok: false, reason: "INVALID_REQUEST" });
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("deleteTextAnnotation: a span referenced by a relation cannot be deleted until the relation is removed first (restrictive FK)", { skip: !hasIntegrationDatabase }, async () => {
  const text = "Alice works at Acme.";
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-fk-guard"), text);
  try {
    const { entityLabelId, relationLabelId, expectedPolicyRevision } = await makeEligibleRelationFixture(fixture.owner, fixture.dataset.id);
    const alice = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: entityLabelId },
    });
    const acme = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-acme", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 15, endOffset: 19, labelId: entityLabelId },
    });
    assert.equal(alice.ok, true);
    assert.equal(acme.ok, true);
    if (!alice.ok || alice.replayed || !acme.ok || acme.replayed) return;

    const relation = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-relation", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.equal(relation.ok, true);
    if (!relation.ok || relation.replayed) return;

    const blockedDelete = await deleteTextAnnotation(fixture.owner, fixture.asset.id, {
      operationId: "op-delete-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "deleteAnnotation", annotationId: alice.result.id, expectedRevision: alice.result.revision },
    });
    assert.deepEqual(blockedDelete, { ok: false, reason: "REFERENCED_SCOPE_LOCKED" });

    // Deleting the relation itself is unconstrained -- `deleteTextAnnotation` is already generic across annotation kinds.
    const deletedRelation = await deleteTextAnnotation(fixture.owner, fixture.asset.id, {
      operationId: "op-delete-relation", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "deleteAnnotation", annotationId: relation.result.id, expectedRevision: relation.result.revision },
    });
    assert.equal(deletedRelation.ok, true);
    if (!deletedRelation.ok) return;

    // Now that the relation is gone, the previously-blocked span delete succeeds.
    const nowAllowedDelete = await deleteTextAnnotation(fixture.owner, fixture.asset.id, {
      operationId: "op-delete-alice-again", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "deleteAnnotation", annotationId: alice.result.id, expectedRevision: alice.result.revision },
    });
    assert.equal(nowAllowedDelete.ok, true);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("submitTextAnnotationCommand: dispatches createRelation", { skip: !hasIntegrationDatabase }, async () => {
  const text = "Alice works at Acme.";
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-dispatch"), text);
  try {
    const { entityLabelId, relationLabelId, expectedPolicyRevision } = await makeEligibleRelationFixture(fixture.owner, fixture.dataset.id);
    const alice = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: entityLabelId },
    });
    const acme = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-acme", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 15, endOffset: 19, labelId: entityLabelId },
    });
    assert.equal(alice.ok, true);
    assert.equal(acme.ok, true);
    if (!alice.ok || alice.replayed || !acme.ok || acme.replayed) return;

    const dispatched = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, {
      operationId: "op-relation", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.equal(dispatched.ok, true);
    if (!dispatched.ok || dispatched.replayed) return;
    const result = dispatched.result as { geometry: { kind: string } };
    assert.equal(result.geometry.kind, "text-relation");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("createTextRelation: a LABELER dataset member (annotation.create, not just the owner) can create a relation between another user's spans", { skip: !hasIntegrationDatabase }, async () => {
  const text = "Alice works at Acme.";
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-labeler"), text);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  await addWorkspaceMember(fixture.dataset.id, labeler.id, "LABELER");
  try {
    const { entityLabelId, relationLabelId, expectedPolicyRevision } = await makeEligibleRelationFixture(fixture.owner, fixture.dataset.id);
    const alice = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: entityLabelId },
    });
    const acme = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-acme", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 15, endOffset: 19, labelId: entityLabelId },
    });
    assert.equal(alice.ok, true);
    assert.equal(acme.ok, true);
    if (!alice.ok || alice.replayed || !acme.ok || acme.replayed) return;

    const relation = await createTextRelation(labeler, fixture.asset.id, {
      operationId: "op-relation-by-labeler", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.equal(relation.ok, true);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id, labeler.id], [fixture.dataset.id]);
  }
});

test("relation mutations preserve direction, revisions, endpoint identities and read-only guards", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-edit"), "Alice works at Acme.");
  const other = await makeReadyTextAsset(workspaceUnique("relation-other"), "Elsewhere");
  try {
    const { entityLabelId, relationLabelId, expectedPolicyRevision } = await makeEligibleRelationFixture(fixture.owner, fixture.dataset.id);
    const envelope = { sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision };
    const createSpan = async (operationId: string, startOffset: number, endOffset: number) => {
      const result = await createTextSpan(fixture.owner, fixture.asset.id, { ...envelope, operationId, command: { kind: "createSpan", startOffset, endOffset, labelId: entityLabelId } });
      assert.ok(result.ok && !result.replayed);
      return result.result;
    };
    const alice = await createSpan("alice", 0, 5);
    const acme = await createSpan("acme", 15, 19);
    const before = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    const created = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, { ...envelope, operationId: "reverse-direction", command: { kind: "createRelation", relationLabelId, fromAnnotationId: acme.id, toAnnotationId: alice.id } });
    assert.ok(created.ok && !created.replayed && "geometry" in created.result);
    const relation = created.result;
    assert.equal(relation.fromAnnotationId, acme.id, "selection order wins over source offset");
    assert.equal(relation.toAnnotationId, alice.id);
    const afterCreate = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    assert.ok(afterCreate.revision > before.revision);
    const updated = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, { ...envelope, operationId: "reverse-again", command: { kind: "updateRelation", annotationId: relation.id, expectedRevision: relation.revision, fromAnnotationId: alice.id, toAnnotationId: acme.id } });
    assert.ok(updated.ok && !updated.replayed && "geometry" in updated.result);
    assert.equal(updated.result.revision, relation.revision + 1);
    assert.equal(updated.result.fromAnnotationId, alice.id);
    const afterUpdate = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    assert.ok(afterUpdate.revision > afterCreate.revision);
    const stale = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, { ...envelope, operationId: "stale", command: { kind: "updateRelation", annotationId: relation.id, expectedRevision: relation.revision, relationLabelId } });
    assert.deepEqual(stale, { ok: false, reason: "REVISION_STALE" });
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } })).revision, afterUpdate.revision);
    const outsider = await createTextSpan(other.owner, other.asset.id, { operationId: "other", sourceIdentity: other.sourceIdentity, expectedPolicyRevision: await currentPolicyRevision(other.dataset.id), command: { kind: "createSpan", startOffset: 0, endOffset: 4, labelId: null } });
    assert.ok(outsider.ok && !outsider.replayed);
    for (const endpoint of [outsider.result.id, "nonexistent-endpoint"]) {
      const rejected = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, { ...envelope, operationId: `cross-${endpoint}`, command: { kind: "updateRelation", annotationId: relation.id, expectedRevision: updated.result.revision, toAnnotationId: endpoint } });
      assert.deepEqual(rejected, { ok: false, reason: "NOT_FOUND" });
      const createRejected = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, { ...envelope, operationId: `create-cross-${endpoint}`, command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.id, toAnnotationId: endpoint } });
      assert.deepEqual(createRejected, { ok: false, reason: "NOT_FOUND" });
    }
    const moved = await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, { ...envelope, operationId: "move", command: { kind: "updateSpan", annotationId: alice.id, expectedRevision: alice.revision, endOffset: 4 } });
    assert.ok(moved.ok);
    const persisted = await db.annotation.findUniqueOrThrow({ where: { id: relation.id } });
    assert.equal(persisted.fromAnnotationId, alice.id);
    assert.equal(persisted.toAnnotationId, acme.id);
    for (const status of ["NEEDS_REVIEW", "REVIEWED", "REJECTED"] as const) {
      await db.asset.update({ where: { id: fixture.asset.id }, data: { status } });
      const revision = (await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } })).revision;
      const commands = [
        { kind: "createRelation", relationLabelId, fromAnnotationId: acme.id, toAnnotationId: alice.id },
        { kind: "updateRelation", annotationId: relation.id, expectedRevision: persisted.revision, fromAnnotationId: acme.id, toAnnotationId: alice.id },
        { kind: "updateRelation", annotationId: relation.id, expectedRevision: persisted.revision, relationLabelId },
        { kind: "deleteAnnotation", annotationId: relation.id, expectedRevision: persisted.revision },
        { kind: "createSpan", startOffset: 6, endOffset: 11, labelId: entityLabelId },
        { kind: "updateSpan", annotationId: acme.id, expectedRevision: acme.revision, labelId: null },
        { kind: "deleteAnnotation", annotationId: acme.id, expectedRevision: acme.revision },
      ];
      for (const [index, command] of commands.entries()) {
        assert.deepEqual(await submitTextAnnotationCommand(fixture.owner, fixture.asset.id, { ...envelope, operationId: `${status}-${index}`, command }), { ok: false, reason: "WORKFLOW_LOCKED" });
      }
      assert.equal((await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } })).revision, revision);
    }
    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: "IN_PROGRESS" } });
    const deleted = await deleteTextAnnotation(fixture.owner, fixture.asset.id, { ...envelope, operationId: "delete-relation", command: { kind: "deleteAnnotation", annotationId: relation.id, expectedRevision: persisted.revision } });
    assert.ok(deleted.ok);
    assert.equal(await db.annotation.count({ where: { id: { in: [alice.id, acme.id] } } }), 2);
  } finally {
    await fixture.cleanup(); await other.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id, other.owner.id], [fixture.dataset.id, other.dataset.id]);
  }
});

test("createTextRelation: an exact duplicate directed pair/type under a different operationId is rejected as DUPLICATE_RELATION, but a same-operationId replay returns the committed result without a second row (T119)", { skip: !hasIntegrationDatabase }, async () => {
  const text = "Alice works at Acme.";
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-duplicate"), text);
  try {
    const { entityLabelId, relationLabelId, expectedPolicyRevision } = await makeEligibleRelationFixture(fixture.owner, fixture.dataset.id);
    const alice = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: entityLabelId },
    });
    const acme = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-acme", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 15, endOffset: 19, labelId: entityLabelId },
    });
    assert.equal(alice.ok, true);
    assert.equal(acme.ok, true);
    if (!alice.ok || alice.replayed || !acme.ok || acme.replayed) return;

    const first = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-first", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.equal(first.ok, true);
    if (!first.ok || first.replayed) return;

    const duplicate = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-second", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.deepEqual(duplicate, { ok: false, reason: "DUPLICATE_RELATION" });

    const replay = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-first", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.replayed, true);

    const relationCount = await db.annotation.count({ where: { assetId: fixture.asset.id, type: "TEXT_RELATION" } });
    assert.equal(relationCount, 1, "duplicate rejection and replay both leave exactly one row");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("updateTextSpan: relabeling an endpoint span incompatible with an attached relation is rejected atomically (span/relation both unchanged); a compatible relabel preserves the relation's identity and revision untouched (T126, proving T125's guard)", { skip: !hasIntegrationDatabase }, async () => {
  const text = "Alice works at Acme.";
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-relabel"), text);
  try {
    const labelA = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Org"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    const labelB = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Person"), color: "#22C55E", description: null, hotkey: null, textEligibility: "ENTITY" });
    const labelExcluded = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Place"), color: "#F59E0B", description: null, hotkey: null, textEligibility: "ENTITY" });
    const relationLabel = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("worksAt"), color: "#8B5CF6", description: null, hotkey: null, textEligibility: "RELATION" });
    assert.equal(labelA.ok, true); assert.equal(labelB.ok, true); assert.equal(labelExcluded.ok, true); assert.equal(relationLabel.ok, true);
    if (!labelA.ok || !labelB.ok || !labelExcluded.ok || !relationLabel.ok) return;

    const revisionBeforePolicy = await currentPolicyRevision(fixture.dataset.id);
    const policyWrite = await writeTextPolicy(fixture.owner, fixture.dataset.id, {
      expectedRevision: revisionBeforePolicy,
      // Both labelA and labelB are allowed endpoints; labelExcluded is not.
      policy: { schemaVersion: 1, classificationGroups: [], relationTypes: [{ relationLabelId: relationLabel.label.id, allowedSourceLabelIds: [labelA.label.id, labelB.label.id], allowedTargetLabelIds: [labelA.label.id, labelB.label.id], allowUnlabeledSource: false, allowUnlabeledTarget: false }] },
    });
    assert.equal(policyWrite.ok, true);
    if (!policyWrite.ok) return;
    const expectedPolicyRevision = policyWrite.revision;

    const alice = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: labelA.label.id },
    });
    const acme = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-acme", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 15, endOffset: 19, labelId: labelA.label.id },
    });
    assert.equal(alice.ok, true);
    assert.equal(acme.ok, true);
    if (!alice.ok || alice.replayed || !acme.ok || acme.replayed) return;

    const relation = await createTextRelation(fixture.owner, fixture.asset.id, {
      operationId: "op-relation", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createRelation", relationLabelId: relationLabel.label.id, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
    });
    assert.equal(relation.ok, true);
    if (!relation.ok || relation.replayed) return;

    // Incompatible: alice -> labelExcluded (not in allowedSourceLabelIds) must fail atomically.
    const incompatible = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-incompatible", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: alice.result.id, expectedRevision: alice.result.revision, labelId: labelExcluded.label.id },
    });
    assert.deepEqual(incompatible, { ok: false, reason: "REFERENCED_SCOPE_LOCKED" });
    const aliceAfterReject = await db.annotation.findUniqueOrThrow({ where: { id: alice.result.id } });
    assert.equal(aliceAfterReject.labelId, labelA.label.id, "a rejected relabel must not change the label");
    assert.equal(aliceAfterReject.revision, alice.result.revision);
    const relationAfterReject = await db.annotation.findUniqueOrThrow({ where: { id: relation.result.id } });
    assert.equal(relationAfterReject.revision, relation.result.revision, "a rejected relabel must not touch the attached relation");

    // Compatible: alice -> labelB (also allowed) succeeds and leaves the relation's identity/revision completely untouched.
    const compatible = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-compatible", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: alice.result.id, expectedRevision: alice.result.revision, labelId: labelB.label.id },
    });
    assert.equal(compatible.ok, true);
    if (!compatible.ok || compatible.replayed) return;
    assert.equal(compatible.result.labelId, labelB.label.id);
    const relationAfterCompatible = await db.annotation.findUniqueOrThrow({ where: { id: relation.result.id } });
    assert.equal(relationAfterCompatible.revision, relation.result.revision, "a compatible relabel does not touch the relation row at all");
    assert.equal(relationAfterCompatible.fromAnnotationId, alice.result.id);
    assert.equal(relationAfterCompatible.toAnnotationId, acme.result.id);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("T120: a concurrent relation-create and span-delete targeting the same endpoint cannot both succeed -- real Postgres Serializable isolation, never a dangling reference either way", { skip: !hasIntegrationDatabase }, async () => {
  const text = "Alice works at Acme.";
  const fixture = await makeReadyTextAsset(workspaceUnique("relation-endpoint-race"), text);
  try {
    const { entityLabelId, relationLabelId, expectedPolicyRevision } = await makeEligibleRelationFixture(fixture.owner, fixture.dataset.id);
    const alice = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-alice", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 5, labelId: entityLabelId },
    });
    const acme = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-acme", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 15, endOffset: 19, labelId: entityLabelId },
    });
    assert.equal(alice.ok, true);
    assert.equal(acme.ok, true);
    if (!alice.ok || alice.replayed || !acme.ok || acme.replayed) return;

    const gate = barrier(2);
    const relate = (async () => {
      await gate();
      return createTextRelation(fixture.owner, fixture.asset.id, {
        operationId: "op-race-relate", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
        command: { kind: "createRelation", relationLabelId, fromAnnotationId: alice.result.id, toAnnotationId: acme.result.id },
      });
    })();
    const remove = (async () => {
      await gate();
      return deleteTextAnnotation(fixture.owner, fixture.asset.id, {
        operationId: "op-race-delete", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
        command: { kind: "deleteAnnotation", annotationId: alice.result.id, expectedRevision: alice.result.revision },
      });
    })();
    const [relateResult, deleteResult] = await Promise.all([relate, remove]);

    const relationExists = relateResult.ok && !relateResult.replayed;
    const spanDeleted = deleteResult.ok;
    // Exactly one side's *intended effect* actually lands -- either the
    // relation was created (and the endpoint survives, protected by the
    // restrictive FK from here on) or the span was deleted (and no relation
    // referencing it exists). Both landing, or neither, would both be bugs.
    assert.notEqual(relationExists, spanDeleted, "the relation existing and the span being deleted are mutually exclusive outcomes");

    const spanCount = await db.annotation.count({ where: { id: alice.result.id } });
    const relationCount = await db.annotation.count({ where: { assetId: fixture.asset.id, type: "TEXT_RELATION", fromAnnotationId: alice.result.id } });
    if (relationExists) {
      assert.equal(spanCount, 1, "a relation that landed must still have its endpoint intact");
      assert.equal(relationCount, 1);
    } else {
      assert.equal(spanCount, 0, "the delete landed -- the span is actually gone");
      assert.equal(relationCount, 0, "no relation can reference a deleted span");
    }
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});
