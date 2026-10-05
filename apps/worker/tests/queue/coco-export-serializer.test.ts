import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { buildCocoDatasetExport, resolveCocoFileName } from "../../src/jobs/coco-export-serializer.js";
import { hasIntegrationDatabase, createAiPollFixture } from "../jobs/ai-fixtures.js";

/**
 * Pure logic coverage via a fake `db` -- same pattern as
 * export-manifest.test.ts's "export manifest is metadata-only..." test.
 * Exercises every named skip reason (spec §2), the score-inclusion rule,
 * and deterministic ID assignment independent of query/array order.
 */
test("COCO serializer: every eligibility rule, skip reason, and deterministic ID assignment", async () => {
  const T1 = new Date("2026-01-01T00:00:00.000Z");
  const T2 = new Date("2026-01-02T00:00:00.000Z");

  // Deliberately returned out of final sort order, to prove sorting -- not
  // array/query order -- determines image_id/category_id.
  const assets = [
    { id: "asset-b", filename: "b.jpg", width: 100, height: 200 }, // imgA
    { id: "asset-a", filename: "a.jpg", width: 50, height: 50 },   // imgB
  ];
  const labels = [
    { id: "label-cat", name: "Cat", normalizedName: "cat" },
    { id: "label-apple", name: "Apple", normalizedName: "apple" },
  ];

  const annotations = [
    // 1. wrong_modality: asset archived
    { id: "ann-archived", assetId: "asset-archived", labelId: "label-cat", type: "BOUNDING_BOX", status: "DRAFT", source: "MANUAL", geometry: { x: 0, y: 0, width: 0.1, height: 0.1 }, properties: {}, createdAt: T1,
      asset: { modality: "IMAGE", archivedAt: new Date(), deletedAt: null, width: 10, height: 10 } },
    // 2. missing_dimensions
    { id: "ann-nodims", assetId: "asset-nodims", labelId: "label-cat", type: "BOUNDING_BOX", status: "DRAFT", source: "MANUAL", geometry: { x: 0, y: 0, width: 0.1, height: 0.1 }, properties: {}, createdAt: T1,
      asset: { modality: "IMAGE", archivedAt: null, deletedAt: null, width: null, height: null } },
    // 3. unsupported_geometry_type
    { id: "ann-polygon", assetId: "asset-b", labelId: "label-cat", type: "POLYGON", status: "DRAFT", source: "MANUAL", geometry: { points: [] }, properties: {}, createdAt: T1,
      asset: { modality: "IMAGE", archivedAt: null, deletedAt: null, width: 100, height: 200 } },
    // 4. rejected
    { id: "ann-rejected", assetId: "asset-b", labelId: "label-cat", type: "BOUNDING_BOX", status: "REJECTED", source: "MANUAL", geometry: { x: 0, y: 0, width: 0.1, height: 0.1 }, properties: {}, createdAt: T1,
      asset: { modality: "IMAGE", archivedAt: null, deletedAt: null, width: 100, height: 200 } },
    // 5. invalid_geometry (exceeds bounds)
    { id: "ann-badgeo", assetId: "asset-b", labelId: "label-cat", type: "BOUNDING_BOX", status: "DRAFT", source: "MANUAL", geometry: { x: 0.9, y: 0, width: 0.5, height: 0.1 }, properties: {}, createdAt: T1,
      asset: { modality: "IMAGE", archivedAt: null, deletedAt: null, width: 100, height: 200 } },
    // 6. unlabeled
    { id: "ann-nolabel", assetId: "asset-b", labelId: null, type: "BOUNDING_BOX", status: "DRAFT", source: "MANUAL", geometry: { x: 0, y: 0, width: 0.1, height: 0.1 }, properties: {}, createdAt: T1,
      asset: { modality: "IMAGE", archivedAt: null, deletedAt: null, width: 100, height: 200 } },
    // 7. label_not_in_image_category_set (a real label, but CLASSIFICATION scope -- not in the mocked eligibleLabels list)
    { id: "ann-badlabel", assetId: "asset-b", labelId: "label-classification-only", type: "BOUNDING_BOX", status: "DRAFT", source: "MANUAL", geometry: { x: 0, y: 0, width: 0.1, height: 0.1 }, properties: {}, createdAt: T1,
      asset: { modality: "IMAGE", archivedAt: null, deletedAt: null, width: 100, height: 200 } },
    // INCLUDED #1: MANUAL, no score, on asset-b (imageId 2, sorted after a.jpg)
    { id: "ann-manual", assetId: "asset-b", labelId: "label-cat", type: "BOUNDING_BOX", status: "DRAFT", source: "MANUAL", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, properties: {}, createdAt: T2,
      asset: { modality: "IMAGE", archivedAt: null, deletedAt: null, width: 100, height: 200 } },
    // INCLUDED #2: AI with a valid confidence, on asset-a (imageId 1)
    { id: "ann-ai-scored", assetId: "asset-a", labelId: "label-apple", type: "BOUNDING_BOX", status: "DRAFT", source: "AI", geometry: { x: 0, y: 0, width: 0.5, height: 0.5 }, properties: { confidence: 0.87 }, createdAt: T1,
      asset: { modality: "IMAGE", archivedAt: null, deletedAt: null, width: 50, height: 50 } },
    // INCLUDED #3: AI with an invalid confidence (non-number) -> included, score omitted; also proves createdAt ordering within the same image
    { id: "ann-ai-unscored", assetId: "asset-b", labelId: "label-cat", type: "BOUNDING_BOX", status: "DRAFT", source: "AI", geometry: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 }, properties: { confidence: "high" }, createdAt: T1,
      asset: { modality: "IMAGE", archivedAt: null, deletedAt: null, width: 100, height: 200 } },
  ];

  const fakeDb = {
    dataset: { findFirst: async () => ({ id: "dataset-1" }) },
    asset: { findMany: async () => assets },
    label: { findMany: async () => labels },
    annotation: { findMany: async () => annotations },
  };

  const result = await buildCocoDatasetExport(fakeDb as never, "dataset-1");
  assert.ok(result);

  assert.deepEqual(result.document.images, [
    { id: 1, file_name: "a.jpg", width: 50, height: 50 },
    { id: 2, file_name: "b.jpg", width: 100, height: 200 },
  ]);
  assert.deepEqual(result.document.categories, [
    { id: 1, name: "Apple" },
    { id: 2, name: "Cat" },
  ]);

  assert.equal(result.document.annotations.length, 3);
  // Sorted by (image_id, createdAt, id): ai-scored (image 1) first, then the
  // two image-2 annotations ordered by createdAt (ai-unscored T1 before manual T2).
  assert.equal(result.document.annotations[0].image_id, 1);
  assert.equal(result.document.annotations[0].category_id, 1);
  assert.deepEqual(result.document.annotations[0].bbox, [0, 0, 25, 25]);
  assert.equal(result.document.annotations[0].area, 625);
  assert.equal(result.document.annotations[0].score, 0.87);
  assert.equal(result.document.annotations[0].iscrowd, 0);

  assert.equal(result.document.annotations[1].image_id, 2);
  assert.equal(result.document.annotations[1].category_id, 2);
  assert.deepEqual(result.document.annotations[1].bbox, [20, 40, 10, 20]);
  assert.equal(result.document.annotations[1].area, 200);
  assert.equal("score" in result.document.annotations[1], false, "invalid confidence must omit the key, not emit null");

  assert.equal(result.document.annotations[2].image_id, 2);
  assert.deepEqual(result.document.annotations[2].bbox, [10, 20, 20, 60]);
  assert.equal(result.document.annotations[2].area, 1200);
  assert.equal("score" in result.document.annotations[2], false);

  // ids are sequential 1..N in final sorted order, independent of input order
  assert.deepEqual(result.document.annotations.map((a) => a.id), [1, 2, 3]);

  assert.deepEqual(result.skipped, {
    wrong_modality: 1,
    missing_dimensions: 1,
    unsupported_geometry_type: 1,
    invalid_geometry: 1,
    rejected: 1,
    unlabeled: 1,
    label_not_in_image_category_set: 1,
  });
  assert.equal(result.totalAnnotationsConsidered, annotations.length);
});

/**
 * Prepared post-migration acceptance fixture (spec §10/§13): once the real
 * `select` gains `relativePath: true` (the one deferred line -- see
 * coco-export-serializer.ts's module docstring), this exact scenario is
 * what proves the switch worked. Uses relativePath directly on fabricated
 * assets (mock db, no schema dependency) since the real column does not
 * exist yet -- resolveCocoFileName()/the sort key are exercised for real,
 * only the DB `select` line is what's deferred.
 */
test("COCO acceptance: a/1.png and b/1.png (same basename, different folders) both survive distinctly into images[].file_name once relativePath is present", async () => {
  const assets = [
    { id: "asset-b", filename: "1.png", relativePath: "b/1.png", width: 10, height: 10 },
    { id: "asset-a", filename: "1.png", relativePath: "a/1.png", width: 20, height: 20 },
  ];
  const fakeDb = {
    dataset: { findFirst: async () => ({ id: "dataset-1" }) },
    asset: { findMany: async () => assets },
    label: { findMany: async () => [] },
    annotation: { findMany: async () => [] },
  };
  const result = await buildCocoDatasetExport(fakeDb as never, "dataset-1");
  assert.ok(result);
  assert.deepEqual(result.document.images.map((i) => i.file_name), ["a/1.png", "b/1.png"]);
  assert.notEqual(result.document.images[0].file_name, result.document.images[1].file_name);
  assert.equal(resolveCocoFileName({ filename: "1.png", relativePath: "a/1.png" }), "a/1.png");
  assert.equal(resolveCocoFileName({ filename: "1.png", relativePath: null }), "1.png");
  assert.equal(resolveCocoFileName({ filename: "1.png" }), "1.png");
});

test("COCO serializer: returns null for a missing or archived Dataset", async () => {
  const fakeDb = {
    dataset: { findFirst: async () => null },
    asset: { findMany: async () => [] },
    label: { findMany: async () => [] },
    annotation: { findMany: async () => [] },
  };
  assert.equal(await buildCocoDatasetExport(fakeDb as never, "missing-dataset"), null);
});

test("COCO serializer: real Dataset with zero-annotation and annotated IMAGE assets, against live DB", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createAiPollFixture({ assetCount: 2 });
  try {
    await fixture.db.asset.updateMany({ where: { id: { in: fixture.assetIds } }, data: { width: 40, height: 20 } });
    await fixture.db.annotation.create({
      data: {
        datasetId: fixture.datasetId, assetId: fixture.assetIds[0], labelId: fixture.labelId, createdById: fixture.ownerId,
        modality: "IMAGE", type: "BOUNDING_BOX", source: "MANUAL", geometry: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      },
    });
    const result = await buildCocoDatasetExport(fixture.db, fixture.datasetId);
    assert.ok(result);
    // Both fixture assets are eligible IMAGE assets with dimensions -- both
    // must appear in images[] even though only one has an annotation.
    assert.equal(result.document.images.length, 2);
    assert.equal(result.document.annotations.length, 1);
    assert.deepEqual(result.document.annotations[0].bbox, [10, 5, 20, 10]);
    assert.equal(result.document.categories.length, 1);
  } finally { await fixture.cleanup(); }
});
