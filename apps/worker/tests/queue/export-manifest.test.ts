import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import { buildExportManifest, exportManifestSchema } from "../../src/jobs/export-manifest.js";

test("export manifest is metadata-only, stable, and strips unsafe arbitrary JSON", async () => {
  const calls: unknown[] = [];
  const now = new Date("2026-07-22T00:00:00.000Z");
  const db = {
    dataset: {
      findFirst: async (input: unknown) => {
        calls.push(input);
        return {
          id: "dataset-1", name: "Dataset", description: null, type: "MULTI_MODAL", primaryModality: null,
          sourceMode: "UPLOAD", createdAt: now, updatedAt: now,
          assets: [{
            id: "asset-1", datasetId: "dataset-1", filename: "one.jpg", originalFilename: "one.jpg", modality: "IMAGE",
            mimeType: "image/jpeg", status: "COMPLETED", sizeBytes: 12n, width: 2, height: 3, durationMs: null,
            textLength: null, batchIndex: 0, orderIndex: 0, description: null, checksum: "checksum", revision: 2,
            storageProvider: "MINIO", createdAt: now, updatedAt: now,
          }],
          labels: [{
            id: "label-1", datasetId: "dataset-1", name: "Object", normalizedName: "object", color: "#000000",
            description: null, modality: "IMAGE", scope: "OBJECT", hotkey: null,
            properties: { visible: true, providerToken: "must-not-leak" }, createdAt: now, updatedAt: now,
          }],
          annotations: [{
            id: "annotation-1", datasetId: "dataset-1", assetId: "asset-1", labelId: "label-1", modality: "IMAGE",
            type: "BOUNDING_BOX", source: "MANUAL", status: "COMPLETED", geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            properties: { confidence: 0.9, privateUrl: "https://private.invalid" }, revision: 3, createdAt: now, updatedAt: now,
          }],
        };
      },
    },
  } as unknown as PrismaClient;

  const manifest = await buildExportManifest(db, "dataset-1", now);
  assert.ok(manifest);
  assert.equal(exportManifestSchema.safeParse(manifest).success, true);
  assert.deepEqual(manifest.labels[0]?.properties, { visible: true });
  assert.deepEqual(manifest.annotations[0]?.properties, { confidence: 0.9 });
  assert.deepEqual(manifest.annotations[0]?.geometry, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  assert.equal(manifest.assets[0]?.storage.provider, "MINIO");
  const serialized = JSON.stringify(manifest);
  for (const prohibited of ["storageBucket", "storageKey", "providerToken", "privateUrl", "must-not-leak", "http://", "https://"])
    assert.equal(serialized.includes(prohibited), false);
  assert.equal(calls.length, 1);
});
