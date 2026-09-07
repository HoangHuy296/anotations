import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { buildExportSelectedManifest } from "../../src/jobs/export-selected-manifest.js";
import { createWorkerJobFixture } from "../queue/helpers.js";

const enabled = process.env.GARBAGE_COLLECTION_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const skip = enabled ? false : "explicit GARBAGE_COLLECTION_RUNTIME_TESTS=1 + DATABASE_URL required";

/** T043 (022): the Export Selected manifest -- selected-only, metadata + annotations, zero binary content. */

test("includes only the selected assets' metadata, their labels (both Annotation and Asset-level), and their annotations", { skip }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const marker = randomUUID();
    const label = await fixture.db.label.create({ data: { datasetId: fixture.datasetId, name: "cat", normalizedName: `cat-${marker}`, color: "#0EA5E9", modality: "IMAGE" }, select: { id: true } });
    const assetLabel = await fixture.db.label.create({ data: { datasetId: fixture.datasetId, name: "priority", normalizedName: `priority-${marker}`, color: "#EF4444", modality: "IMAGE" }, select: { id: true } });
    const selected = await fixture.db.asset.create({ data: { datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}-selected.png`, mimeType: "image/png", sourceFingerprint: `${marker}-selected` }, select: { id: true } });
    const notSelected = await fixture.db.asset.create({ data: { datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}-not-selected.png`, mimeType: "image/png", sourceFingerprint: `${marker}-not-selected` }, select: { id: true } });
    await fixture.db.annotation.create({ data: { datasetId: fixture.datasetId, assetId: selected.id, labelId: label.id, createdById: fixture.ownerId, modality: "IMAGE", type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } });
    await fixture.db.annotation.create({ data: { datasetId: fixture.datasetId, assetId: notSelected.id, labelId: label.id, createdById: fixture.ownerId, modality: "IMAGE", type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } });
    await fixture.db.assetLabel.create({ data: { assetId: selected.id, labelId: assetLabel.id } });

    const manifest = await buildExportSelectedManifest(fixture.db, fixture.datasetId, [selected.id], new Date());

    assert.equal(manifest.selectedAssetCount, 1);
    assert.deepEqual(manifest.assets.map((asset) => asset.id), [selected.id], "only the selected asset's metadata is included");
    assert.equal(manifest.annotations.length, 1);
    assert.equal(manifest.annotations[0]!.assetId, selected.id, "only the selected asset's annotations are included");
    assert.deepEqual(manifest.assetLabels, [{ assetId: selected.id, labelId: assetLabel.id }]);
    const labelIds = new Set(manifest.labels.map((item) => item.id));
    assert.ok(labelIds.has(label.id), "the annotation label is included since it's referenced by a selected asset's annotation");
    assert.ok(labelIds.has(assetLabel.id), "the asset-level label is included since it's attached to a selected asset");
  } finally { await fixture.cleanup(); }
});

test("never includes binary content -- only storage provider/contentType/sizeBytes/checksum metadata", { skip }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const marker = randomUUID();
    const asset = await fixture.db.asset.create({
      data: { datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}.png`, mimeType: "image/png", sourceFingerprint: marker, storageProvider: "MINIO", storageBucket: "private", storageKey: "private/should-never-appear.png", sizeBytes: 1234n },
      select: { id: true },
    });
    const manifest = await buildExportSelectedManifest(fixture.db, fixture.datasetId, [asset.id], new Date());
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes("should-never-appear"), false, "the private storage key never appears anywhere in the manifest");
    assert.equal(serialized.includes("storageKey"), false);
    assert.equal(serialized.includes("storageBucket"), false);
    assert.equal(manifest.assets[0]!.storage.sizeBytes, "1234", "non-binary size metadata is fine to include");
  } finally { await fixture.cleanup(); }
});

test("an empty selection produces a valid, empty manifest rather than an error", { skip }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const manifest = await buildExportSelectedManifest(fixture.db, fixture.datasetId, [], new Date());
    assert.deepEqual(manifest, { schemaVersion: "1", exportedAt: manifest.exportedAt, datasetId: fixture.datasetId, selectedAssetCount: 0, assets: [], assetLabels: [], labels: [], annotations: [] });
  } finally { await fixture.cleanup(); }
});
