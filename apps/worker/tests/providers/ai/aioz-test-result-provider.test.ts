import assert from "node:assert/strict";
import test from "node:test";

import {
  AiozTestResultProvider,
  TEST_BOUNDING_BOX,
  TEST_CONFIDENCE,
  TEST_LABEL_KEY,
} from "../../../src/providers/ai/aioz-test-result-provider.js";

test("submitTask -- returns a deterministic externalTaskId derived from the aiTaskId", async () => {
  const adapter = new AiozTestResultProvider();
  const result = await adapter.submitTask({ aiTaskId: "task-1", assetIds: ["asset-1"], modelKey: "model-key" });
  assert.equal(result.externalTaskId, "test-result-task-1");
});

test("getTaskStatus -- IN_PROGRESS on the first check, COMPLETED from the second check onward", async () => {
  const adapter = new AiozTestResultProvider();
  const { externalTaskId } = await adapter.submitTask({ aiTaskId: "task-2", assetIds: ["asset-1", "asset-2"], modelKey: "model-key" });

  const first = await adapter.getTaskStatus(externalTaskId);
  assert.equal(first.status, "IN_PROGRESS", "the real polling path must see at least one non-terminal result");

  const second = await adapter.getTaskStatus(externalTaskId);
  assert.equal(second.status, "COMPLETED");
  if (second.status !== "COMPLETED") return;
  assert.deepEqual(second.rawPredictions, [
    { asset_id: "asset-1", label_key: TEST_LABEL_KEY, score: TEST_CONFIDENCE, bbox: TEST_BOUNDING_BOX },
    { asset_id: "asset-2", label_key: TEST_LABEL_KEY, score: TEST_CONFIDENCE, bbox: TEST_BOUNDING_BOX },
  ]);

  // A third check for an already-completed task keeps returning COMPLETED --
  // ai-poll.processor.ts never calls getTaskStatus again once a task is
  // terminal, but the adapter itself should stay deterministic regardless.
  const third = await adapter.getTaskStatus(externalTaskId);
  assert.equal(third.status, "COMPLETED");
});

test("getTaskStatus -- an externalTaskId this adapter never submitted fails closed", async () => {
  const adapter = new AiozTestResultProvider();
  const result = await adapter.getTaskStatus("test-result-never-submitted");
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.equal(result.error.code, "AI_TEST_PROVIDER_UNKNOWN_TASK");
});

test("getTaskStatus -- two different tasks poll independently", async () => {
  const adapter = new AiozTestResultProvider();
  const taskA = await adapter.submitTask({ aiTaskId: "task-a", assetIds: ["asset-a"], modelKey: "model-key" });
  const taskB = await adapter.submitTask({ aiTaskId: "task-b", assetIds: ["asset-b"], modelKey: "model-key" });

  assert.equal((await adapter.getTaskStatus(taskA.externalTaskId)).status, "IN_PROGRESS");
  assert.equal((await adapter.getTaskStatus(taskB.externalTaskId)).status, "IN_PROGRESS");
  assert.equal((await adapter.getTaskStatus(taskA.externalTaskId)).status, "COMPLETED");
  // taskB's own poll count is unaffected by taskA's checks above.
  assert.equal((await adapter.getTaskStatus(taskB.externalTaskId)).status, "COMPLETED");
});

test("normalizePredictions -- maps this adapter's raw wire shape to the canonical AiProviderPrediction shape", () => {
  const adapter = new AiozTestResultProvider();
  const normalized = adapter.normalizePredictions([
    { asset_id: "asset-1", label_key: TEST_LABEL_KEY, score: TEST_CONFIDENCE, bbox: TEST_BOUNDING_BOX },
  ]);
  assert.deepEqual(normalized, [
    { assetId: "asset-1", labelKey: TEST_LABEL_KEY, confidence: TEST_CONFIDENCE, boundingBoxes: TEST_BOUNDING_BOX },
  ]);
});

test("normalizePredictions -- rejects a shape that doesn't match this adapter's own raw wire format", () => {
  const adapter = new AiozTestResultProvider();
  assert.throws(() => adapter.normalizePredictions([{ assetId: "wrong-shape" }]));
});
