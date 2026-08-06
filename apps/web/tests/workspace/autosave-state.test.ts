import assert from "node:assert/strict";
import test from "node:test";

import { useAnnotationStore } from "@/stores/annotation-store";

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test("per-resource autosave resets its delay and records the final save state", async () => {
  const store = useAnnotationStore.getState();
  store.clearAutosave("annotation:test-delay");
  let firstCalls = 0;
  let secondCalls = 0;

  store.scheduleAutosave("annotation:test-delay", async () => {
    firstCalls += 1;
    return "saved";
  }, 15);
  store.scheduleAutosave("annotation:test-delay", async () => {
    secondCalls += 1;
    return "saved";
  }, 15);

  assert.equal(useAnnotationStore.getState().saveStates["annotation:test-delay"], "pending");
  await wait(35);
  assert.equal(firstCalls, 0);
  assert.equal(secondCalls, 1);
  assert.equal(useAnnotationStore.getState().saveStates["annotation:test-delay"], "saved");
});

test("flush autosave cancels the timer and awaits the newest draft exactly once", async () => {
  const store = useAnnotationStore.getState();
  store.clearAutosave("annotation:test-flush");
  let calls = 0;
  store.scheduleAutosave("annotation:test-flush", async () => {
    calls += 1;
    return "saved";
  }, 100);

  const result = await useAnnotationStore.getState().flushAutosave("annotation:test-flush");
  assert.equal(result, "saved");
  assert.equal(calls, 1);
  assert.equal(useAnnotationStore.getState().saveStates["annotation:test-flush"], "saved");
  await wait(120);
  assert.equal(calls, 1);
});

test("a newer pending draft remains pending when an older in-flight save completes", async () => {
  const store = useAnnotationStore.getState();
  store.clearAutosave("annotation:test-newer-draft");
  let releaseOlder: (() => void) | undefined;
  store.scheduleAutosave("annotation:test-newer-draft", () => new Promise<"saved">((resolve) => { releaseOlder = () => resolve("saved"); }), 1);
  await wait(10);
  store.scheduleAutosave("annotation:test-newer-draft", async () => "saved", 100);
  releaseOlder?.();
  await wait(10);
  assert.equal(useAnnotationStore.getState().saveStates["annotation:test-newer-draft"], "pending");
  await useAnnotationStore.getState().flushAutosave("annotation:test-newer-draft");
  assert.equal(useAnnotationStore.getState().saveStates["annotation:test-newer-draft"], "saved");
});

test("autosave keeps conflict drafts and does not retry a stale write automatically", async () => {
  const store = useAnnotationStore.getState();
  store.clearAutosave("annotation:test-conflict");
  let calls = 0;
  store.scheduleAutosave("annotation:test-conflict", async () => {
    calls += 1;
    return "conflict";
  }, 1);
  await wait(15);
  store.setConflictDraft("annotation:test-conflict", { geometry: { x: 0.1 } });
  await wait(15);

  assert.equal(calls, 1);
  assert.equal(useAnnotationStore.getState().saveStates["annotation:test-conflict"], "conflict");
  assert.deepEqual(useAnnotationStore.getState().conflictDrafts["annotation:test-conflict"], { geometry: { x: 0.1 } });
  store.clearConflictDraft("annotation:test-conflict");
  assert.equal(useAnnotationStore.getState().conflictDrafts["annotation:test-conflict"], undefined);
});

test("successful mutation replaces the browser-safe annotation revision", () => {
  const store = useAnnotationStore.getState();
  store.initializePersistedImage("asset-autosave", [{
    id: "annotation-autosave",
    assetId: "asset-autosave",
    labelId: null,
    type: "BOUNDING_BOX",
    geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    status: "DRAFT",
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }]);
  store.upsertSafeAnnotation({
    id: "annotation-autosave",
    assetId: "asset-autosave",
    labelId: null,
    type: "BOUNDING_BOX",
    geometry: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 },
    status: "DRAFT",
    revision: 2,
    updatedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(useAnnotationStore.getState().persistedAnnotations[0]?.revision, 2);
});
