import assert from "node:assert/strict";
import test from "node:test";

import { annotationChangeSetSchema, imageAnnotationGeometrySchema } from "@/lib/validation/annotation-api";
import { toSafeAnnotation } from "@/lib/annotations/safe-annotation";

test("image annotation geometry accepts the five approved normalized shapes", () => {
  const cases = [
    { type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
    { type: "POLYGON", geometry: { points: [[0, 0], [1, 0], [0, 1]] } },
    { type: "CIRCLE", geometry: { cx: 0.5, cy: 0.5, r: 0.25 } },
    { type: "POINT", geometry: { px: 0.5, py: 0.5 } },
    { type: "POLYLINE", geometry: { points: [[0, 0], [1, 1]] } },
  ];
  for (const value of cases) assert.equal(imageAnnotationGeometrySchema.safeParse(value).success, true);
});

test("annotation geometry rejects out-of-bounds, malformed, and future image shapes", () => {
  assert.equal(imageAnnotationGeometrySchema.safeParse({ type: "BOUNDING_BOX", geometry: { x: 0.9, y: 0, width: 0.2, height: 0.1 } }).success, false);
  assert.equal(imageAnnotationGeometrySchema.safeParse({ type: "CIRCLE", geometry: { cx: 0.1, cy: 0.1, r: 0.2 } }).success, false);
  assert.equal(imageAnnotationGeometrySchema.safeParse({ type: "POLYGON", geometry: { points: [[0, 0], [0, 0], [1, 1]] } }).success, false);
  assert.equal(imageAnnotationGeometrySchema.safeParse({ type: "SEGMENTATION_MASK", geometry: {} }).success, false);
});

test("change set requires explicit revisions and does not allow duplicate mutations", () => {
  assert.equal(annotationChangeSetSchema.safeParse({ updates: [{ id: "annotation-1", revision: 1 }] }).success, false);
  assert.equal(annotationChangeSetSchema.safeParse({ updates: [{ id: "annotation-1", revision: 1, labelId: null }], deletes: [{ id: "annotation-1", revision: 1 }] }).success, false);
});

test("updates are validated against the persisted shape type and creates require stable identities", () => {
  assert.equal(annotationChangeSetSchema.safeParse({
    creates: [{ type: "POINT", geometry: { px: 0.5, py: 0.5 } }],
  }).success, false);
  assert.equal(annotationChangeSetSchema.safeParse({
    updates: [{ id: "polygon-1", revision: 1, geometry: { points: [[0, 0], [1, 1]] } }],
  }).success, true);
});

test("safe projection excludes creator, source, review, storage, and session fields", () => {
  const dto = toSafeAnnotation({
    id: "annotation", assetId: "asset", labelId: null, modality: "IMAGE", type: "POINT", geometry: { px: 0.5, py: 0.5 },
    status: "DRAFT", properties: {}, revision: 1, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"), label: null,
  });
  const encoded = JSON.stringify(dto);
  for (const forbidden of ["createdById", "updatedById", "reviewedById", "source", "storage", "session", "token"]) assert.equal(encoded.includes(forbidden), false);
});
