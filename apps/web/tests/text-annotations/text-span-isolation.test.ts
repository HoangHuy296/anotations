import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { createTextSpan, updateTextSpan } from "../../src/lib/annotations/text-span-service.js";
import { createLabelWithTextEligibility } from "../../src/lib/workspace/label-management.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T067: geometry-only edits must never change label (or vice versa) -- a
 * span's range and its label are independent fields of the same row, and
 * `updateTextSpan` must only touch the field(s) actually present in the
 * patch (data-model.md, FR-013 metadata isolation).
 *
 * Custom-property isolation is out of scope here: `applyCreateSpan`
 * currently hardcodes `properties: { custom: {} }` regardless of what a
 * caller sends (the create schema accepts an optional `properties` field,
 * but nothing reads it yet), and `updateTextSpan` has no `propertyPatch`
 * input at all -- that wiring is T073's job. There is no property value a
 * geometry/label edit could disturb yet.
 *
 * Relation-identity isolation (does moving/relabeling an endpoint span
 * change the relation that references it) is already proven in
 * `text-relation-commands.test.ts`'s "relation mutations preserve
 * direction, revisions, endpoint identities and read-only guards" test
 * (its `moved` step updates an endpoint span's geometry and asserts the
 * relation's `fromAnnotationId`/`toAnnotationId` are unchanged) -- not
 * duplicated here.
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

test("updateTextSpan: a geometry-only patch (range change) never touches labelId; a label-only patch never touches geometry", { skip: !hasIntegrationDatabase }, async () => {
  const text = "OpenAI builds AI systems.";
  const fixture = await makeReadyTextAsset(workspaceUnique("span-isolation"), text);
  try {
    const entityLabel = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Org"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(entityLabel.ok, true);
    if (!entityLabel.ok) return;
    const otherLabel = await createLabelWithTextEligibility(fixture.owner, { datasetId: fixture.dataset.id, name: workspaceUnique("Product"), color: "#F59E0B", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(otherLabel.ok, true);
    if (!otherLabel.ok) return;

    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: entityLabel.label.id }, // "OpenAI"
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;
    assert.equal(created.result.labelId, entityLabel.label.id);

    // Geometry-only patch: range grows to "OpenAI builds", label untouched.
    const geometryOnly = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-geometry-only", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, endOffset: 13 },
    });
    assert.equal(geometryOnly.ok, true);
    if (!geometryOnly.ok || geometryOnly.replayed) return;
    assert.equal(geometryOnly.result.labelId, entityLabel.label.id, "a geometry-only patch must not change the label");
    assert.equal(geometryOnly.result.geometry.kind, "text-span");
    if (geometryOnly.result.geometry.kind === "text-span") {
      assert.equal(geometryOnly.result.geometry.startOffset, 0);
      assert.equal(geometryOnly.result.geometry.endOffset, 13);
    }

    // Label-only patch: relabel to `otherLabel`, geometry untouched.
    const labelOnly = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-label-only", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: geometryOnly.result.revision, labelId: otherLabel.label.id },
    });
    assert.equal(labelOnly.ok, true);
    if (!labelOnly.ok || labelOnly.replayed) return;
    assert.equal(labelOnly.result.labelId, otherLabel.label.id);
    assert.equal(labelOnly.result.geometry.kind, "text-span");
    if (labelOnly.result.geometry.kind === "text-span") {
      assert.equal(labelOnly.result.geometry.startOffset, 0, "a label-only patch must not change the range");
      assert.equal(labelOnly.result.geometry.endOffset, 13, "a label-only patch must not change the range");
    }

    // Confirm against a fresh DB read too, not just the returned result.
    const persisted = await db.annotation.findUniqueOrThrow({ where: { id: created.result.id } });
    assert.equal(persisted.labelId, otherLabel.label.id);
    const persistedGeometry = persisted.geometry as unknown as { startOffset: number; endOffset: number };
    assert.equal(persistedGeometry.startOffset, 0);
    assert.equal(persistedGeometry.endOffset, 13);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});
