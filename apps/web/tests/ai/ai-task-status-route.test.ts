import assert from "node:assert/strict";
import test, { after } from "node:test";

import { db } from "@/lib/db";
import { aiHttpEnabled, aiHttpSkipReason, createAiTaskFixture, request, signupAndLogin } from "./helpers";

const cleanupDatasetIds: string[] = [];
after(async () => {
  if (cleanupDatasetIds.length) await db.dataset.deleteMany({ where: { id: { in: cleanupDatasetIds } } });
});

test("GET /api/ai/tasks/{aiTaskId} reports an in-progress task", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);

  const created = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ datasetId: fixture.datasetId, modelId: fixture.modelId, assetIds: [fixture.assetId] }),
  });
  assert.equal(created.status, 202);
  const { data } = await created.json() as { data: { taskId: string; jobId: string } };

  const response = await request(`/api/ai/tasks/${data.taskId}`, { headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Record<string, unknown> };
  assert.equal(body.data.taskId, data.taskId);
  assert.equal(body.data.jobId, data.jobId);
  assert.equal(body.data.datasetId, fixture.datasetId);
  assert.ok(["QUEUED", "RUNNING"].includes(body.data.status as string));
  assert.equal(body.data.type, "DETECT_OBJECTS");
  assert.equal(body.data.modelNameSnapshot, "Fixture Model");
  assert.equal("externalTaskId" in body.data, false, "externalTaskId must never be returned to a browser client");
});

test("GET /api/ai/tasks/{aiTaskId} reports a succeeded task", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);

  const created = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ datasetId: fixture.datasetId, modelId: fixture.modelId, assetIds: [fixture.assetId] }),
  });
  const { data } = await created.json() as { data: { taskId: string } };
  await db.aiTask.update({ where: { id: data.taskId }, data: { status: "SUCCEEDED", output: { predictions: [] } } });

  const response = await request(`/api/ai/tasks/${data.taskId}`, { headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { status: string } };
  assert.equal(body.data.status, "SUCCEEDED");
});

test("GET /api/ai/tasks/{aiTaskId} reports a failed task with its error", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);

  const created = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ datasetId: fixture.datasetId, modelId: fixture.modelId, assetIds: [fixture.assetId] }),
  });
  const { data } = await created.json() as { data: { taskId: string } };
  await db.aiTask.update({ where: { id: data.taskId }, data: { status: "FAILED", error: "poll budget exceeded", errorCode: "AI_TASK_TIMEOUT" } });

  const response = await request(`/api/ai/tasks/${data.taskId}`, { headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { status: string; error: string | null; errorCode: string | null } };
  assert.equal(body.data.status, "FAILED");
  assert.equal(body.data.errorCode, "AI_TASK_TIMEOUT");
  assert.equal(body.data.error, "poll budget exceeded");
});

test("GET /api/ai/tasks/{aiTaskId} conceals a task that does not exist", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const response = await request("/api/ai/tasks/cm00000000000000000000000", { headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 404);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "AI_TASK_NOT_FOUND");
});

test("GET /api/ai/tasks/{aiTaskId} conceals a task the actor cannot access", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);
  const created = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ datasetId: fixture.datasetId, modelId: fixture.modelId, assetIds: [fixture.assetId] }),
  });
  const { data } = await created.json() as { data: { taskId: string } };

  const stranger = await signupAndLogin();
  const response = await request(`/api/ai/tasks/${data.taskId}`, { headers: { Cookie: stranger.cookie } });
  assert.equal(response.status, 404);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "AI_TASK_NOT_FOUND");
});

test("GET /api/ai/tasks/{aiTaskId} requires authentication", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const response = await request("/api/ai/tasks/cm00000000000000000000000");
  assert.equal(response.status, 401);
});
