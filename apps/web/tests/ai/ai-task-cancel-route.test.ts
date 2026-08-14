import assert from "node:assert/strict";
import test, { after } from "node:test";

import { db } from "@/lib/db";
import { aiHttpEnabled, aiHttpSkipReason, createAiTaskFixture, request, signupAndLogin } from "./helpers";

const cleanupDatasetIds: string[] = [];
after(async () => {
  if (cleanupDatasetIds.length) await db.dataset.deleteMany({ where: { id: { in: cleanupDatasetIds } } });
});

async function createTask(ownerCookie: string, datasetId: string, modelId: string, assetId: string) {
  const created = await request("/api/ai/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: ownerCookie },
    body: JSON.stringify({ datasetId, modelId, assetIds: [assetId] }),
  });
  assert.equal(created.status, 202);
  return (await created.json() as { data: { taskId: string; jobId: string } }).data;
}

test("POST /api/ai/tasks/{aiTaskId}/cancel cancels the task's underlying Job by taskId alone", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);
  const { taskId, jobId } = await createTask(owner.cookie, fixture.datasetId, fixture.modelId, fixture.assetId);

  const response = await request(`/api/ai/tasks/${taskId}/cancel`, { method: "POST", headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { taskId: string; jobId: string; status: string } };
  assert.equal(body.data.taskId, taskId);
  assert.equal(body.data.jobId, jobId);
  // QUEUED -> CANCELED immediately; RUNNING -> CANCELING (a worker may have
  // already claimed it by the time this request lands) -- either is a
  // correct cancellation outcome, matching this suite's existing tolerance
  // for QUEUED-or-RUNNING timing (ai-task-status-route.test.ts).
  assert.ok(["CANCELED", "CANCELING"].includes(body.data.status), `unexpected cancellation status: ${body.data.status}`);

  const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, cancelRequestedAt: true } });
  assert.ok(["CANCELED", "CANCELING"].includes(job.status));
  assert.ok(job.cancelRequestedAt);
});

test("POST /api/ai/tasks/{aiTaskId}/cancel is idempotent-safe: a second cancel on an already-terminal task reports JOB_CONFLICT", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);
  const { taskId } = await createTask(owner.cookie, fixture.datasetId, fixture.modelId, fixture.assetId);

  const first = await request(`/api/ai/tasks/${taskId}/cancel`, { method: "POST", headers: { Cookie: owner.cookie } });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { data: { status: string } };

  const second = await request(`/api/ai/tasks/${taskId}/cancel`, { method: "POST", headers: { Cookie: owner.cookie } });
  if (firstBody.data.status === "CANCELED") {
    // Already terminal -- a second cancel can never succeed again.
    assert.equal(second.status, 409);
    const body = await second.json() as { error: { code: string } };
    assert.equal(body.error.code, "JOB_CONFLICT");
  } else {
    // CANCELING is not yet terminal -- a second request may still legally
    // re-request cancellation (JobStatus.RUNNING branch) until a worker
    // finalizes it; either outcome is acceptable here.
    assert.ok([200, 409].includes(second.status));
  }
});

test("POST /api/ai/tasks/{aiTaskId}/cancel conceals a task that does not exist", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const response = await request("/api/ai/tasks/cm00000000000000000000000/cancel", { method: "POST", headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 404);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "AI_TASK_NOT_FOUND");
});

test("POST /api/ai/tasks/{aiTaskId}/cancel conceals a task the actor cannot access", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const fixture = await createAiTaskFixture(owner.userId);
  cleanupDatasetIds.push(fixture.datasetId);
  const { taskId } = await createTask(owner.cookie, fixture.datasetId, fixture.modelId, fixture.assetId);

  const stranger = await signupAndLogin();
  const response = await request(`/api/ai/tasks/${taskId}/cancel`, { method: "POST", headers: { Cookie: stranger.cookie } });
  assert.equal(response.status, 404);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "AI_TASK_NOT_FOUND");

  // Concealment must not have canceled it as a side effect.
  const job = await db.job.findUniqueOrThrow({ where: { id: (await db.aiTask.findUniqueOrThrow({ where: { id: taskId }, select: { jobId: true } })).jobId }, select: { status: true } });
  assert.notEqual(job.status, "CANCELED");
});

test("POST /api/ai/tasks/{aiTaskId}/cancel requires authentication", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const response = await request("/api/ai/tasks/cm00000000000000000000000/cancel", { method: "POST" });
  assert.equal(response.status, 401);
});
