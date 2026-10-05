import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { createTextSpan, updateTextSpan } from "../../src/lib/annotations/text-span-service.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique, addWorkspaceMember } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T073: the shared custom-property patch validator
 * (`packages/domain/src/text-properties-contract.ts`, T004) wired into
 * span commands -- `createSpan`'s optional initial `properties` and
 * `updateSpan`'s new `propertyPatch` (`{set, unset}`, merge/unset/null
 * semantics from `applyTextPropertyPatch`). Mirrors
 * `text-span-isolation.test.ts`'s fixture/assertion conventions.
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

test("createTextSpan: an initial properties.custom map is persisted exactly; omitting it defaults to an empty map", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-props-create"), "OpenAI builds AI.");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const withProperties = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-with-props", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null, properties: { custom: { confidence: 0.9, note: "manual" } } },
    });
    assert.equal(withProperties.ok, true);
    if (!withProperties.ok || withProperties.replayed) return;
    assert.deepEqual(withProperties.result.properties, { custom: { confidence: 0.9, note: "manual" } });

    const withoutProperties = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-without-props", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 6, endOffset: 13, labelId: null },
    });
    assert.equal(withoutProperties.ok, true);
    if (!withoutProperties.ok || withoutProperties.replayed) return;
    assert.deepEqual(withoutProperties.result.properties, { custom: {} });
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("updateTextSpan propertyPatch: set merges into existing custom properties, unset removes a key, null is a valid stored value, and geometry/label are left untouched", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-props-patch"), "OpenAI builds AI.");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null, properties: { custom: { confidence: 0.5, keep: "yes" } } },
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;

    // Merge: `confidence` overwritten, `note` added, `keep` untouched.
    const merged = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-merge", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, propertyPatch: { set: { confidence: 0.9, note: "reviewed" }, unset: [] } },
    });
    assert.equal(merged.ok, true);
    if (!merged.ok || merged.replayed) return;
    assert.deepEqual(merged.result.properties, { custom: { confidence: 0.9, note: "reviewed", keep: "yes" } });
    assert.equal(merged.result.labelId, null, "a property-only patch must not touch labelId");
    assert.equal(merged.result.geometry.kind, "text-span");
    if (merged.result.geometry.kind === "text-span") {
      assert.equal(merged.result.geometry.startOffset, 0);
      assert.equal(merged.result.geometry.endOffset, 6);
    }

    // Unset removes `keep`; explicit null is a valid stored value for `note`.
    const unset = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-unset", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: merged.result.revision, propertyPatch: { set: { note: null }, unset: ["keep"] } },
    });
    assert.equal(unset.ok, true);
    if (!unset.ok || unset.replayed) return;
    assert.deepEqual(unset.result.properties, { custom: { confidence: 0.9, note: null } });

    // Confirm against a fresh DB read too.
    const persisted = await db.annotation.findUniqueOrThrow({ where: { id: created.result.id } });
    assert.deepEqual(persisted.properties, { custom: { confidence: 0.9, note: null } });
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("updateTextSpan propertyPatch: a stale expectedRevision is rejected, and an unset+set collision on the same key is INVALID_REQUEST with no partial write", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-props-stale"), "OpenAI builds AI.");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;

    const first = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-first", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, propertyPatch: { set: { a: 1 }, unset: [] } },
    });
    assert.equal(first.ok, true);
    if (!first.ok || first.replayed) return;

    const stale = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-stale", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, propertyPatch: { set: { a: 2 }, unset: [] } },
    });
    assert.deepEqual(stale, { ok: false, reason: "REVISION_STALE" });

    const collision = await updateTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-collision", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: first.result.revision, propertyPatch: { set: { a: 3 }, unset: ["a"] } },
    });
    assert.deepEqual(collision, { ok: false, reason: "INVALID_REQUEST" });

    const persisted = await db.annotation.findUniqueOrThrow({ where: { id: created.result.id } });
    assert.equal(persisted.revision, first.result.revision, "neither rejection left a partial write");
    assert.deepEqual(persisted.properties, { custom: { a: 1 } });
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("updateTextSpan propertyPatch: a non-owner without annotation.updateAny is FORBIDDEN for a property-only patch", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-props-ownership"), "OpenAI builds AI.");
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  await addWorkspaceMember(fixture.dataset.id, labeler.id, "LABELER");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;

    const forbidden = await updateTextSpan(labeler, fixture.asset.id, {
      operationId: "op-forbidden", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, propertyPatch: { set: { a: 1 }, unset: [] } },
    });
    assert.deepEqual(forbidden, { ok: false, reason: "FORBIDDEN" });
    assert.equal(await db.annotation.count({ where: { id: created.result.id, revision: created.result.revision } }), 1, "the forbidden attempt left the row unchanged");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id, labeler.id], [fixture.dataset.id]);
  }
});

test("updateTextSpan propertyPatch: NEEDS_REVIEW/REVIEWED/REJECTED reject a property-only patch too (T094 -- the pre-existing frozen-workflow regression loop predates propertyPatch)", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-props-frozen"), "OpenAI builds AI.");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;

    for (const status of ["NEEDS_REVIEW", "REVIEWED", "REJECTED"] as const) {
      await db.asset.update({ where: { id: fixture.asset.id }, data: { status } });
      const revision = (await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } })).revision;
      const rejected = await updateTextSpan(fixture.owner, fixture.asset.id, {
        operationId: `op-frozen-${status}`, sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
        command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, propertyPatch: { set: { a: 1 }, unset: [] } },
      });
      assert.deepEqual(rejected, { ok: false, reason: "WORKFLOW_LOCKED" });
      assert.equal((await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id } })).revision, revision, "no revision bump from a rejected frozen command");
    }
    const persisted = await db.annotation.findUniqueOrThrow({ where: { id: created.result.id } });
    assert.deepEqual(persisted.properties, { custom: {} }, "no property leaked through while frozen");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});
