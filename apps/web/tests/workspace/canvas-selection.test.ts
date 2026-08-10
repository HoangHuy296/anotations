import assert from "node:assert/strict";
import test from "node:test";

import { useAnnotationStore } from "@/stores/image-annotation-store";

const first = { id: "annotation-a", assetId: "asset-a", version: 1, labelId: "label-a", coordinates: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } };
const second = { id: "annotation-b", assetId: "asset-a", version: 3, labelId: null, coordinates: { x: 0.4, y: 0.2, width: 0.2, height: 0.2 } };

test("selection and persisted annotation replacement are synchronized without viewport state", () => {
  const store = useAnnotationStore.getState();
  store.initializeImage("asset-a", "label-a");
  store.setPersistedAnnotations([first, second]);
  useAnnotationStore.getState().setSelectedId(second.id);
  assert.equal(useAnnotationStore.getState().selectedId, second.id);
  useAnnotationStore.getState().replacePersistedAnnotation({ ...second, version: 4, coordinates: { ...second.coordinates, x: 0.5 } });
  assert.equal(useAnnotationStore.getState().annotations.find((item) => item.id === second.id)?.version, 4);
  useAnnotationStore.getState().removePersistedAnnotation(second.id);
  assert.equal(useAnnotationStore.getState().selectedId, null);
  assert.equal("viewport" in useAnnotationStore.getState(), false);
});
