import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { getWorkerConfig } from "../../src/config.js";
import { buildExportManifest } from "../../src/jobs/export-manifest.js";
import { textRelationsResolveWithinExportSet } from "../../src/jobs/text-export-serializer.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

/**
 * T085: the optional TEXT projection added to `buildExportManifest`
 * (research.md D6) -- span/relation geometry+properties+endpoints, and
 * safe TEXT source metadata on the asset. No MinIO fixture is needed:
 * export reads only durable DB metadata, never the source object itself.
 */

async function createTextExportFixture() {
  const db: PrismaClient = createWorkerDatabase(getWorkerConfig());
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const owner = await db.user.create({ data: { email: `text-export-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `text-export-${suffix}` }, select: { id: true } });
  const label = await db.label.create({ data: { datasetId: dataset.id, name: "Org", normalizedName: "org", color: "#0EA5E9", scope: "ENTITY" }, select: { id: true } });
  const sourceIdentity = `sha256:${"a".repeat(64)}`;
  const textAsset = await db.asset.create({
    data: {
      datasetId: dataset.id, modality: "TEXT", filename: `${suffix}.txt`, mimeType: "text/plain", sourceFingerprint: suffix,
      textAsset: { create: { sourceIdentity, sourceEncoding: "UTF8", offsetUnit: "UTF16_CODE_UNIT", sourceByteLength: 18, sourceCodeUnitLength: 18, preparedSourceFingerprint: suffix, preparedAt: new Date() } },
    },
    select: { id: true },
  });
  const unpreparedTextAsset = await db.asset.create({
    data: { datasetId: dataset.id, modality: "TEXT", filename: `unprepared-${suffix}.txt`, mimeType: "text/plain", sourceFingerprint: `unprepared-${suffix}` },
    select: { id: true },
  });
  const imageAsset = await db.asset.create({
    data: { datasetId: dataset.id, modality: "IMAGE", filename: `${suffix}.jpg`, mimeType: "image/jpeg", sourceFingerprint: `image-${suffix}` },
    select: { id: true },
  });
  const [spanA, spanB] = await Promise.all([
    db.annotation.create({
      data: { id: `${suffix}-span-a`, datasetId: dataset.id, assetId: textAsset.id, labelId: label.id, createdById: owner.id, modality: "TEXT", type: "NAMED_ENTITY_RECOGNITION", source: "MANUAL", geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity, offsetUnit: "UTF16_CODE_UNIT", startOffset: 0, endOffset: 6 }, properties: { custom: { confidence: 0.9 } } },
      select: { id: true },
    }),
    db.annotation.create({
      data: { id: `${suffix}-span-b`, datasetId: dataset.id, assetId: textAsset.id, labelId: label.id, createdById: owner.id, modality: "TEXT", type: "NAMED_ENTITY_RECOGNITION", source: "MANUAL", geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity, offsetUnit: "UTF16_CODE_UNIT", startOffset: 7, endOffset: 13 }, properties: { custom: {} } },
      select: { id: true },
    }),
  ]);
  const relation = await db.annotation.create({
    data: { id: `${suffix}-relation`, datasetId: dataset.id, assetId: textAsset.id, createdById: owner.id, modality: "TEXT", type: "TEXT_RELATION", source: "MANUAL", fromAnnotationId: spanA.id, toAnnotationId: spanB.id, geometry: { schemaVersion: 1, kind: "text-relation", sourceIdentity }, properties: { custom: {} } },
    select: { id: true },
  });
  await db.annotation.create({
    data: { datasetId: dataset.id, assetId: imageAsset.id, createdById: owner.id, modality: "IMAGE", type: "POINT", source: "MANUAL", geometry: { px: 0.5, py: 0.5 }, properties: {} },
  });

  return {
    db, datasetId: dataset.id, textAssetId: textAsset.id, unpreparedTextAssetId: unpreparedTextAsset.id, imageAssetId: imageAsset.id,
    spanAId: spanA.id, spanBId: spanB.id, relationId: relation.id, sourceIdentity,
    cleanup: async () => {
      await db.dataset.delete({ where: { id: dataset.id } }).catch(() => undefined);
      await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
      await db.$disconnect();
    },
  };
}

test("buildExportManifest: TEXT spans/relations carry their safe projection and endpoint identities; TEXT source metadata is present only for a prepared asset; IMAGE is unaffected", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createTextExportFixture();
  try {
    const manifest = await buildExportManifest(fixture.db, fixture.datasetId, new Date());
    assert.ok(manifest);

    const preparedAsset = manifest.assets.find((asset) => asset.id === fixture.textAssetId);
    assert.ok(preparedAsset?.text);
    assert.equal(preparedAsset.text.sourceIdentity, fixture.sourceIdentity);
    assert.equal(preparedAsset.text.sourceEncoding, "UTF8");
    assert.equal(preparedAsset.text.offsetUnit, "UTF16_CODE_UNIT");
    assert.equal(preparedAsset.text.sourceCodeUnitLength, 18);

    const unpreparedAsset = manifest.assets.find((asset) => asset.id === fixture.unpreparedTextAssetId);
    assert.equal(unpreparedAsset?.text, null, "an unprepared TEXT source has no verified metadata to export");

    const imageAsset = manifest.assets.find((asset) => asset.id === fixture.imageAssetId);
    assert.equal(imageAsset?.text, null, "IMAGE assets are unaffected -- always null");

    const spanA = manifest.annotations.find((annotation) => annotation.id === fixture.spanAId);
    assert.ok(spanA?.text);
    assert.equal(spanA.text.geometry.kind, "text-span");
    if (spanA.text.geometry.kind === "text-span") { assert.equal(spanA.text.geometry.startOffset, 0); assert.equal(spanA.text.geometry.endOffset, 6); }
    assert.deepEqual(spanA.text.properties, { custom: { confidence: 0.9 } });
    assert.equal(spanA.fromAnnotationId, null, "a span never carries relation endpoints");
    assert.equal(spanA.toAnnotationId, null);

    const relation = manifest.annotations.find((annotation) => annotation.id === fixture.relationId);
    assert.ok(relation?.text);
    assert.equal(relation.text.geometry.kind, "text-relation");
    assert.equal(relation.fromAnnotationId, fixture.spanAId);
    assert.equal(relation.toAnnotationId, fixture.spanBId);
    assert.equal(relation.text.fromAnnotationId, fixture.spanAId, "the text projection carries the same endpoints as the top-level fields");
    assert.equal(relation.text.toAnnotationId, fixture.spanBId);

    const imagePoint = manifest.annotations.find((annotation) => annotation.assetId === fixture.imageAssetId);
    assert.equal(imagePoint?.text, null);
    assert.equal(imagePoint?.fromAnnotationId, null);
  } finally {
    await fixture.cleanup();
  }
});

test("textRelationsResolveWithinExportSet: true for a closed relation set and for non-TEXT rows, false when an endpoint is missing from the set", () => {
  const spanA = { id: "span-a", modality: "TEXT", fromAnnotationId: null, toAnnotationId: null };
  const spanB = { id: "span-b", modality: "TEXT", fromAnnotationId: null, toAnnotationId: null };
  const closedRelation = { id: "relation", modality: "TEXT", fromAnnotationId: "span-a", toAnnotationId: "span-b" };
  assert.equal(textRelationsResolveWithinExportSet([spanA, spanB, closedRelation]), true);

  const imagePoint = { id: "image-point", modality: "IMAGE", fromAnnotationId: null, toAnnotationId: null };
  assert.equal(textRelationsResolveWithinExportSet([imagePoint]), true);

  const danglingRelation = { id: "relation", modality: "TEXT", fromAnnotationId: "span-a", toAnnotationId: "missing-span" };
  assert.equal(textRelationsResolveWithinExportSet([spanA, danglingRelation]), false);
});

test("buildExportManifest: a relation whose endpoint is missing from the exported set fails the whole export safely (null), never a dangling reference", async () => {
  const now = new Date("2026-07-22T00:00:00.000Z");
  const db = {
    dataset: {
      findFirst: async () => ({
        id: "dataset-1", name: "Dataset", description: null, type: "MULTI_MODAL", primaryModality: null,
        sourceMode: "UPLOAD", createdAt: now, updatedAt: now,
        assets: [{
          id: "text-asset-1", datasetId: "dataset-1", filename: "doc.txt", originalFilename: null, modality: "TEXT",
          mimeType: "text/plain", status: "IN_PROGRESS", sizeBytes: null, width: null, height: null, durationMs: null,
          textLength: 18, batchIndex: 0, orderIndex: 0, description: null, checksum: null, revision: 1,
          storageProvider: "MINIO", createdAt: now, updatedAt: now, textAsset: null,
        }],
        labels: [],
        annotations: [{
          // A dangling relation: `fromAnnotationId` does not resolve to any row in this same set.
          id: "relation-1", datasetId: "dataset-1", assetId: "text-asset-1", labelId: null, modality: "TEXT",
          type: "TEXT_RELATION", source: "MANUAL", status: "DRAFT",
          geometry: { schemaVersion: 1, kind: "text-relation", sourceIdentity: `sha256:${"a".repeat(64)}` }, properties: { custom: {} },
          fromAnnotationId: "does-not-exist", toAnnotationId: "also-does-not-exist",
          revision: 1, createdAt: now, updatedAt: now,
        }],
      }),
    },
  } as unknown as PrismaClient;

  const manifest = await buildExportManifest(db, "dataset-1", now);
  assert.equal(manifest, null);
});
