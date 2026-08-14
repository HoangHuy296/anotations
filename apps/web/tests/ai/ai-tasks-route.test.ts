import assert from "node:assert/strict";
import test, { after } from "node:test";

import { db } from "@/lib/db";
import { aiHttpEnabled, aiHttpSkipReason, createAiTaskFixture, request, signupAndLogin } from "./helpers";

const cleanupDatasetIds: string[] = [];
after(async () => {
  if (cleanupDatasetIds.length) await db.dataset.deleteMany({ where: { id: { in: cleanupDatasetIds } } });
});

test("POST /api/ai/tasks accepts a valid request and durably creates Job + AiTask before enqueue", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);

  const response = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ datasetId: fixture.datasetId, modelId: fixture.modelId, assetIds: [fixture.assetId] }),
  });
  assert.equal(response.status, 202);
  const body = await response.json() as { data: { taskId: string; jobId: string } };
  assert.ok(body.data.taskId);
  assert.ok(body.data.jobId);

  const job = await db.job.findUniqueOrThrow({ where: { id: body.data.jobId }, select: { type: true, datasetId: true, provider: true } });
  assert.equal(job.type, "AI_PREANNOTATE_ASSET");
  assert.equal(job.datasetId, fixture.datasetId);
  assert.equal(job.provider, null, "AI route must never write Job.provider");

  const aiTask = await db.aiTask.findUniqueOrThrow({ where: { id: body.data.taskId }, select: { jobId: true, modelId: true, status: true } });
  assert.equal(aiTask.jobId, body.data.jobId);
  assert.equal(aiTask.modelId, fixture.modelId);
});

test("POST /api/ai/tasks rejects an asset outside the dataset before creating any durable record", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);
  const foreign = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(foreign.datasetId);

  const before = await db.job.count({ where: { datasetId: fixture.datasetId } });
  const response = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ datasetId: fixture.datasetId, modelId: fixture.modelId, assetIds: [foreign.assetId] }),
  });
  assert.equal(response.status, 409);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "ASSET_NOT_IN_DATASET");
  const after = await db.job.count({ where: { datasetId: fixture.datasetId } });
  assert.equal(after, before, "no Job may be created for a request certain to be rejected");
});

test("POST /api/ai/tasks rejects a disabled AI model", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);
  await db.aiModel.update({ where: { id: fixture.modelId }, data: { isActive: false } });

  const response = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ datasetId: fixture.datasetId, modelId: fixture.modelId, assetIds: [fixture.assetId] }),
  });
  assert.equal(response.status, 409);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "AI_MODEL_INACTIVE");
});

test("POST /api/ai/tasks reports AI_MODEL_NOT_FOUND for an unknown modelId", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);

  const response = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ datasetId: fixture.datasetId, modelId: "cm00000000000000000000000", assetIds: [fixture.assetId] }),
  });
  assert.equal(response.status, 404);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "AI_MODEL_NOT_FOUND");
});

test("POST /api/ai/tasks conceals a dataset the actor cannot access", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);
  const stranger = await signupAndLogin();

  const response = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: stranger.cookie },
    body: JSON.stringify({ datasetId: fixture.datasetId, modelId: fixture.modelId, assetIds: [fixture.assetId] }),
  });
  assert.equal(response.status, 404);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "DATASET_NOT_FOUND");
});

test("POST /api/ai/tasks rejects an invalid body", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const response = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ datasetId: "cm00000000000000000000000" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "INVALID_REQUEST");
});

test("POST /api/ai/tasks requires authentication", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const response = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId: "cm00000000000000000000000", modelId: "cm00000000000000000000000", assetIds: ["cm00000000000000000000000"] }),
  });
  assert.equal(response.status, 401);
});
