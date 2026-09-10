import assert from "node:assert/strict";
import test from "node:test";
import { loadModelClasses, parseModelLabels } from "@/lib/ai/ai-model-service";
import { createAiTaskSchema } from "@/lib/validation/ai-task";
import { listModelClassesClient, createAiTaskClient } from "@/lib/ai/ai-task-api-client";

const modelId = "0307ee22-5bfa-4f68-bcb5-42fef7d26de3";
const response = { success: true, data: { model_id: modelId, classes: ["person", "car", "person"] } };

test("labels validate upstream identity and success and deduplicate classes", () => {
  assert.deepEqual(parseModelLabels(response, modelId), ["person", "car"]);
  assert.throws(() => parseModelLabels({ ...response, success: false }, modelId));
  assert.throws(() => parseModelLabels(response, "1516e00c-64f3-442d-93fd-71d224088c28"));
  assert.throws(() => parseModelLabels({ success: true, data: { model_id: modelId, classes: [42] } }, modelId));
});

test("server loads classes from the model labels path with bounded requests", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.pathname, `/api/v1/models/labels/${modelId}`);
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal);
    return Response.json(response);
  });
  assert.deepEqual(await loadModelClasses(modelId), ["person", "car"]);
});

test("class selection is optional for legacy clients, but cannot be empty or duplicated", () => {
  const input = { datasetId: modelId, modelId, assetIds: ["asset-id"] };
  assert.ok(createAiTaskSchema.safeParse(input).success);
  assert.ok(createAiTaskSchema.safeParse({ ...input, classes: ["person"] }).success);
  assert.equal(createAiTaskSchema.safeParse({ ...input, classes: [] }).success, false);
  assert.equal(createAiTaskSchema.safeParse({ ...input, classes: ["person", "person"] }).success, false);
});

test("browser requests coalesce and selected classes reach the task API", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, `/api/ai/models/${modelId}/labels`);
    assert.equal(init.credentials, "same-origin");
    return Response.json({ data: { classes: ["person", "car"] } });
  });
  const results = await Promise.all([listModelClassesClient(modelId), listModelClassesClient(modelId)]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], { ok: true, classes: ["person", "car"] });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(_url, "/api/ai/tasks");
    assert.deepEqual(JSON.parse(init.body as string).classes, ["car"]);
    assert.equal(JSON.parse(init.body as string).confidence_threshold, 0.55);
    assert.equal(JSON.parse(init.body as string).iou_threshold, 0.65);
    return Response.json({ data: { taskId: "task", jobId: "job" } });
  });
  assert.equal((await createAiTaskClient({ datasetId: "dataset", modelId, assetIds: ["asset"], classes: ["car"], confidence_threshold: 0.55, iou_threshold: 0.65 })).ok, true);
});

test("label network failures are recoverable safe failures", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private upstream details"); });
  assert.deepEqual(await listModelClassesClient(modelId), { ok: false, code: "AI_MODEL_LABELS_UNAVAILABLE", status: 0 });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { classes: ["car"] } }));
  assert.deepEqual(await listModelClassesClient(modelId), { ok: true, classes: ["car"] });
});


test("thresholds default to 0.5 and accept arbitrary decimals within inclusive bounds", () => {
  const input = { datasetId: modelId, modelId, assetIds: ["asset-id"] };
  const defaults = createAiTaskSchema.parse(input);
  assert.equal(defaults.confidence_threshold, 0.5);
  assert.equal(defaults.iou_threshold, 0.5);
  for (const field of ["confidence_threshold", "iou_threshold"]) {
    for (const value of [0, 0.55, 0.65, 1]) assert.ok(createAiTaskSchema.safeParse({ ...input, [field]: value }).success);
    for (const value of [-0.1, 1.1, "0.5", null, NaN, Infinity]) assert.equal(createAiTaskSchema.safeParse({ ...input, [field]: value }).success, false);
  }
});
