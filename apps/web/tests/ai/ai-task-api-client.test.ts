import assert from "node:assert/strict";
import test from "node:test";

import { cancelAiTaskClient, createAiTaskClient, listActiveAiModelsClient, readAiTaskClient } from "@/lib/ai/ai-task-api-client";

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => { globalThis.fetch = original; });
}

test("listActiveAiModelsClient -- surfaces the models array on success", async () => {
  const result = await withFetch(async (input) => {
    assert.equal(String(input), "/api/ai/models");
    return new Response(JSON.stringify({ data: { models: [{ id: "m1", key: "k1", displayName: "Model 1", modality: "IMAGE", taskType: "DETECT_OBJECTS" }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }, () => listActiveAiModelsClient());
  assert.deepEqual(result, { ok: true, models: [{ id: "m1", key: "k1", displayName: "Model 1", modality: "IMAGE", taskType: "DETECT_OBJECTS" }] });
});

test("listActiveAiModelsClient -- two concurrent callers share one in-flight fetch", async () => {
  let fetchCount = 0;
  let resolveFetch!: (response: Response) => void;
  const fetchStarted = await withFetch(async (input) => {
    fetchCount += 1;
    assert.equal(String(input), "/api/ai/models");
    return new Promise<Response>((resolve) => { resolveFetch = resolve; });
  }, async () => {
    // Mirrors React Strict Mode's double effect invocation: two callers
    // firing before either request settles must produce exactly one fetch.
    const first = listActiveAiModelsClient();
    const second = listActiveAiModelsClient();
    resolveFetch(new Response(JSON.stringify({ data: { models: [{ id: "m1", key: "k1", displayName: "Model 1", modality: "IMAGE", taskType: "DETECT_OBJECTS" }] } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, secondResult);
    return fetchCount;
  });
  assert.equal(fetchStarted, 1, "concurrent callers must coalesce into a single fetch");

  // Once settled, a later call is a fresh, non-stale request.
  const later = await withFetch(async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ data: { models: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }, () => listActiveAiModelsClient());
  assert.deepEqual(later, { ok: true, models: [] });
  assert.equal(fetchCount, 2, "a call after the in-flight request settled must re-fetch");
});

test("listActiveAiModelsClient -- surfaces the error code on failure", async () => {
  const result = await withFetch(async () => new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), { status: 401, headers: { "Content-Type": "application/json" } }), () => listActiveAiModelsClient());
  assert.deepEqual(result, { ok: false, code: "AUTH_REQUIRED", status: 401 });
});

test("createAiTaskClient -- posts the exact contract body and returns taskId/jobId on 202", async () => {
  let sentBody: unknown = null;
  const result = await withFetch(async (input, init) => {
    assert.equal(String(input), "/api/ai/tasks");
    assert.equal(init?.method, "POST");
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: { taskId: "t1", jobId: "j1" } }), { status: 202, headers: { "Content-Type": "application/json" } });
  }, () => createAiTaskClient({ datasetId: "d1", modelId: "m1", assetIds: ["a1"] }));
  assert.deepEqual(sentBody, { datasetId: "d1", modelId: "m1", assetIds: ["a1"] });
  assert.deepEqual(result, { ok: true, taskId: "t1", jobId: "j1" });
});

test("createAiTaskClient -- a rejection never fabricates a taskId", async () => {
  const result = await withFetch(async () => new Response(JSON.stringify({ error: { code: "AI_MODEL_INACTIVE" } }), { status: 409, headers: { "Content-Type": "application/json" } }), () => createAiTaskClient({ datasetId: "d1", modelId: "m1", assetIds: ["a1"] }));
  assert.deepEqual(result, { ok: false, code: "AI_MODEL_INACTIVE", status: 409 });
});

test("readAiTaskClient -- returns the safe status DTO on 200", async () => {
  const task = { taskId: "t1", jobId: "j1", datasetId: "d1", status: "RUNNING", type: "PREANNOTATE_ASSET", modality: "IMAGE", modelNameSnapshot: "Model 1", modelVersionSnapshot: null, pollAttempts: 2, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:02:00.000Z", error: null, errorCode: null };
  const result = await withFetch(async (input) => {
    assert.equal(String(input), "/api/ai/tasks/t1");
    return new Response(JSON.stringify({ data: task }), { status: 200, headers: { "Content-Type": "application/json" } });
  }, () => readAiTaskClient("t1"));
  assert.deepEqual(result, { ok: true, task });
});

test("readAiTaskClient -- 404 is concealed the same way for missing or unauthorized tasks", async () => {
  const result = await withFetch(async () => new Response(JSON.stringify({ error: { code: "AI_TASK_NOT_FOUND" } }), { status: 404, headers: { "Content-Type": "application/json" } }), () => readAiTaskClient("missing"));
  assert.deepEqual(result, { ok: false, code: "AI_TASK_NOT_FOUND", status: 404 });
});

test("cancelAiTaskClient -- posts to the task-scoped cancel route, not the generic Job cancel route", async () => {
  let calledPath = "";
  const result = await withFetch(async (input, init) => {
    calledPath = String(input);
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ data: { taskId: "t1", jobId: "j1", status: "CANCELING" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }, () => cancelAiTaskClient("t1"));
  assert.equal(calledPath, "/api/ai/tasks/t1/cancel");
  assert.deepEqual(result, { ok: true });
});

test("cancelAiTaskClient -- a task that cannot be canceled surfaces JOB_CONFLICT", async () => {
  const result = await withFetch(async () => new Response(JSON.stringify({ error: { code: "JOB_CONFLICT" } }), { status: 409, headers: { "Content-Type": "application/json" } }), () => cancelAiTaskClient("t1"));
  assert.deepEqual(result, { ok: false, code: "JOB_CONFLICT", status: 409 });
});
