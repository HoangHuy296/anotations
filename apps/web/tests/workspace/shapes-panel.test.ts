import assert from "node:assert/strict";
import test from "node:test";

import { useAnnotationStore } from "@/stores/image-annotation-store";

const annotation = {
  id: "shape-a",
  assetId: "asset-shapes",
  labelId: "label-person",
  type: "BOUNDING_BOX" as const,
  geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  status: "DRAFT" as const,
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("Shapes and canvas use one selected persisted annotation projection", () => {
  const store = useAnnotationStore.getState();
  store.initializePersistedImage("asset-shapes", [annotation]);
  store.setSelectedId(annotation.id);
  assert.equal(useAnnotationStore.getState().selectedId, annotation.id);

  store.upsertSafeAnnotation({ ...annotation, labelId: "label-vehicle", revision: 2 });
  const relabeled = useAnnotationStore.getState().persistedAnnotations.find((item) => item.id === annotation.id);
  assert.equal(relabeled?.labelId, "label-vehicle");
  assert.equal(relabeled?.revision, 2);

  store.removeSafeAnnotation(annotation.id);
  assert.equal(useAnnotationStore.getState().persistedAnnotations.length, 0);
  assert.equal(useAnnotationStore.getState().selectedId, null);
});
