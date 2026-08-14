import assert from "node:assert/strict";
import test from "node:test";

import {
  aiTaskStatusMessage,
  annotationAiTaskId,
  isAiPredictionAnnotation,
  isTerminalAiTaskStatus,
  modelSupportsModality,
  predictionsForTask,
  shouldPollAiTask,
} from "@/lib/ai/ai-detect-view";

test("isTerminalAiTaskStatus/shouldPollAiTask -- only SUCCEEDED/FAILED/CANCELED stop polling", () => {
  assert.equal(isTerminalAiTaskStatus("QUEUED"), false);
  assert.equal(isTerminalAiTaskStatus("RUNNING"), false);
  assert.equal(isTerminalAiTaskStatus("SUCCEEDED"), true);
  assert.equal(isTerminalAiTaskStatus("FAILED"), true);
  assert.equal(isTerminalAiTaskStatus("CANCELED"), true);

  assert.equal(shouldPollAiTask("QUEUED"), true);
  assert.equal(shouldPollAiTask("RUNNING"), true);
  assert.equal(shouldPollAiTask("SUCCEEDED"), false);
  assert.equal(shouldPollAiTask("FAILED"), false);
  assert.equal(shouldPollAiTask("CANCELED"), false);
  // A hidden tab never polls, terminal or not.
  assert.equal(shouldPollAiTask("RUNNING", false), false);
});

test("aiTaskStatusMessage -- one line per status, AI_TASK_TIMEOUT gets its own copy", () => {
  assert.match(aiTaskStatusMessage({ status: "QUEUED", error: null, errorCode: null }), /waiting/i);
  assert.match(aiTaskStatusMessage({ status: "RUNNING", error: null, errorCode: null }), /processing/i);
  assert.match(aiTaskStatusMessage({ status: "SUCCEEDED", error: null, errorCode: null }), /completed/i);
  assert.match(aiTaskStatusMessage({ status: "CANCELED", error: null, errorCode: null }), /canceled/i);
  assert.match(aiTaskStatusMessage({ status: "FAILED", error: null, errorCode: "AI_TASK_TIMEOUT" }), /did not respond in time/i);
  assert.equal(aiTaskStatusMessage({ status: "FAILED", error: "provider rejected the request", errorCode: "AI_SUBMIT_FAILED" }), "provider rejected the request");
  assert.match(aiTaskStatusMessage({ status: "FAILED", error: null, errorCode: null }), /failed/i);
});

test("modelSupportsModality -- null modality means multi-modal (always applies)", () => {
  assert.equal(modelSupportsModality({ modality: "IMAGE" }, "IMAGE"), true);
  assert.equal(modelSupportsModality({ modality: "IMAGE" }, "VIDEO"), false);
  assert.equal(modelSupportsModality({ modality: null }, "IMAGE"), true);
  assert.equal(modelSupportsModality({ modality: null }, "AUDIO"), true);
});

test("annotationAiTaskId/isAiPredictionAnnotation -- only a string properties.aiTaskId counts", () => {
  assert.equal(annotationAiTaskId({ properties: undefined }), null);
  assert.equal(annotationAiTaskId({ properties: null }), null);
  assert.equal(annotationAiTaskId({ properties: "not-an-object" }), null);
  assert.equal(annotationAiTaskId({ properties: {} }), null);
  assert.equal(annotationAiTaskId({ properties: { aiTaskId: 42 } }), null);
  assert.equal(annotationAiTaskId({ properties: { aiTaskId: "" } }), null);
  assert.equal(annotationAiTaskId({ properties: { aiTaskId: "task-1" } }), "task-1");

  assert.equal(isAiPredictionAnnotation({ properties: {} }), false);
  assert.equal(isAiPredictionAnnotation({ properties: { aiTaskId: "task-1" } }), true);
});

test("predictionsForTask -- keeps only this task's predictions, is idempotent across repeated calls", () => {
  const annotations = [
    { id: "a", properties: { aiTaskId: "task-1", confidence: 0.9 } },
    { id: "b", properties: { aiTaskId: "task-2", confidence: 0.5 } },
    { id: "c", properties: {} }, // manual annotation, no aiTaskId
    { id: "d", properties: { aiTaskId: "task-1", confidence: 0.7 } },
  ];
  const first = predictionsForTask(annotations, "task-1");
  assert.deepEqual(first.map((item) => item.id), ["a", "d"]);
  // Calling again against the same (now-merged) list must not double count.
  const second = predictionsForTask(annotations, "task-1");
  assert.deepEqual(second.map((item) => item.id), ["a", "d"]);
  assert.deepEqual(predictionsForTask(annotations, "task-2").map((item) => item.id), ["b"]);
  assert.deepEqual(predictionsForTask(annotations, "task-3"), []);
});
