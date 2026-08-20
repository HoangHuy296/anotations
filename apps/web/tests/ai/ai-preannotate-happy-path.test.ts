import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { db } from "@/lib/db";
import type { SafeAnnotation } from "@/lib/annotations/safe-annotation";
import { createFoundationWorker } from "../../../worker/src/queue/bullmq-worker.js";
import { getWorkerConfig } from "../../../worker/src/config.js";
import { pollDueAiTasks } from "../../../worker/src/queue/ai-poll-scanner.js";
import {
  AIOZ_TEST_RESULT_PROVIDER_KEY,
  TEST_BOUNDING_BOX,
  TEST_CONFIDENCE,
  TEST_LABEL_KEY,
} from "../../../worker/src/providers/ai/aioz-test-result-provider.js";
import { aiHttpEnabled, aiHttpSkipReason, request, signupAndLogin } from "./helpers";

/**
 * End-to-end happy path for the 020-ai-integration pre-annotation flow:
 *
 *   POST /api/ai/tasks -> 202 (taskId, jobId)
 *   -> real BullMQ delivery -> queue-router.ts -> ai-submit.processor.ts
 *   -> resolveAiProviderForTask() (real registry, real DB lookup)
 *   -> registered AiozTestResultProvider.submitTask()
 *   -> scanner-driven polling (ai-poll-scanner.ts/ai-poll.processor.ts)
 *   -> AiozTestResultProvider.getTaskStatus() (IN_PROGRESS, then COMPLETED)
 *   -> ai-prediction-writer.ts creates the Annotation
 *   -> GET /api/ai/tasks/{taskId} (existing contract, status only)
 *   -> GET /api/assets/{assetId}/annotations (existing contract, the BBOX)
 *
 * Never calls the real AIOZ-company provider (T006 is blocked, untouched --
 * this seeds an AiModel with a distinct, test-only `provider` value instead
 * of "aioz-company") and never bypasses the queue/worker or
 * resolveAiProviderForTask(): this worker instance is the real
 * `createFoundationWorker` runtime, driven against the real local
 * Postgres/Redis, exactly like `job-queue/export-e2e.test.ts`.
 *
 * `GET /api/ai/tasks/{aiTaskId}` deliberately never carries predictions
 * (contracts/ai-api.md: "The response never includes ... raw provider
 * output") -- this test does not invent a field there. The BBOX is asserted
 * through the same route the frontend already uses for it
 * (`getAssetAnnotations` in `ai-detect-dialog.tsx`/`image-engine.tsx`):
 * `GET /api/assets/{assetId}/annotations`, filtered by `properties.aiTaskId`.
 *
 * Environment note: this test's `runtime` genuinely competes on the real
 * BullMQ queue for the submit delivery with *any other* worker process
 * consuming the same Redis/queue (e.g. a `docker compose`-built worker
 * container running older code). If that other worker wins the race, it
 * will not have `AiozTestResultProvider` registered and the task fails with
 * `AI_PROVIDER_NOT_REGISTERED` instead of completing -- this is an
 * environment hazard, not a bug in this test. Stop any such competing
 * worker for the duration of this run (`docker stop <worker-container>`,
 * restart after) if it's flaky.
 */
const enabled = aiHttpEnabled;

async function createHappyPathFixture(ownerId: string) {
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dataset = await db.dataset.create({ data: { ownerId, name: `ai-happy-path-${suffix}` }, select: { id: true } });
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: "IMAGE", filename: `happy-path-${suffix}.jpg`, mimeType: "image/jpeg", sourceFingerprint: `ai-happy-path-${suffix}` },
    select: { id: true },
  });
  const label = await db.label.create({
    data: { datasetId: dataset.id, modality: "IMAGE", name: "AI Detect", normalizedName: TEST_LABEL_KEY, color: "#22c55e" },
    select: { id: true },
  });
  // The test-only provider, never "aioz-company" (T006/production is untouched).
  const model = await db.aiModel.create({
    data: { key: `ai-happy-path-model-${suffix}`, displayName: "Happy Path Fixture Model", provider: AIOZ_TEST_RESULT_PROVIDER_KEY, modality: "IMAGE", taskType: "DETECT_OBJECTS", isActive: true },
    select: { id: true },
  });
  return { datasetId: dataset.id, assetId: asset.id, labelId: label.id, modelId: model.id, cleanup: () => db.dataset.delete({ where: { id: dataset.id } }).catch(() => undefined) };
}

/** Drives the same scanner-driven poll loop `startWorkerReadiness()` runs on a 2s interval (`ai-poll-constants.ts`'s POLL_BASE_DELAY_MS) -- here invoked directly so the test controls timing instead of racing a background timer. */
async function waitForAiTaskTerminal(workerId: string, aiTaskId: string, transitions: Array<{ status: string; pollAttempts: number }>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; pollAttempts: number } | null = null;
  while (Date.now() < deadline) {
    await pollDueAiTasks(db, workerId);
    const aiTask = await db.aiTask.findUniqueOrThrow({ where: { id: aiTaskId }, select: { status: true, pollAttempts: true } });
    if (!last || last.status !== aiTask.status || last.pollAttempts !== aiTask.pollAttempts) {
      transitions.push({ status: aiTask.status, pollAttempts: aiTask.pollAttempts });
      last = aiTask;
    }
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(aiTask.status)) return aiTask;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`AiTask ${aiTaskId} did not reach a terminal state within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

test(
  "AI pre-annotation happy path: POST /api/ai/tasks through real queue/worker/registry/provider to a BOUNDING_BOX annotation",
  { skip: enabled ? false : aiHttpSkipReason },
  async () => {
    const owner = await signupAndLogin();
    const fixture = await createHappyPathFixture(owner.userId);
    // One identity for both the BullMQ queue-delivery claim (submit) and the
    // scanner-driven poll loop below -- matching readiness.ts's production
    // fix: `job-lock.ts#renewOrReclaimLock` (AI polling only) can only renew
    // a lease under the *same* workerId that owns it, so two independent
    // random ids here would make every poll wait out the full 5-minute claim
    // lease (job-claim-lock.ts) before it could even start.
    const workerId = `worker-test-${randomBytes(12).toString("hex")}`;
    const runtime = createFoundationWorker({ config: getWorkerConfig(), db, workerId });
    const transitions: Array<{ status: string; pollAttempts: number }> = [];
    try {
      await runtime.worker.waitUntilReady();

      // 1. POST /api/ai/tasks -> 202, taskId + jobId.
      const created = await request("/api/ai/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ datasetId: fixture.datasetId, modelId: fixture.modelId, assetIds: [fixture.assetId] }),
      });
      assert.equal(created.status, 202);
      const createdBody = await created.json() as { data: { taskId: string; jobId: string } };
      const { taskId, jobId } = createdBody.data;
      assert.ok(taskId);
      assert.ok(jobId);

      // 2. Real queue/worker execution drives submit -> registry resolution
      // -> provider.submitTask() -> scanner-driven poll -> provider.getTaskStatus()
      // (IN_PROGRESS once, then COMPLETED) -> ai-prediction-writer.ts.
      const finalAiTask = await waitForAiTaskTerminal(workerId, taskId, transitions);
      assert.equal(finalAiTask.status, "SUCCEEDED");

      // Proves the real registry resolved AiozTestResultProvider (not a
      // bypass): only that adapter's submitTask() stamps this externalTaskId
      // shape, and only a real submit step sets it at all.
      const persistedAiTask = await db.aiTask.findUniqueOrThrow({ where: { id: taskId }, select: { externalTaskId: true, modelId: true } });
      assert.equal(persistedAiTask.externalTaskId, `test-result-${taskId}`);
      assert.equal(persistedAiTask.modelId, fixture.modelId);
      // At least one non-terminal poll was actually observed -- the real
      // polling path ran, not an immediate first-poll completion.
      assert.ok(transitions.some((t) => t.status === "RUNNING"), `expected a RUNNING transition before SUCCEEDED, observed: ${JSON.stringify(transitions)}`);

      const finishedJob = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, stage: true } });
      assert.equal(finishedJob.status, "COMPLETED");
      assert.equal(finishedJob.stage, "FINISHED");

      // 3. GET /api/ai/tasks/{taskId} -- existing contract, status only.
      const statusResponse = await request(`/api/ai/tasks/${taskId}`, { headers: { Cookie: owner.cookie } });
      assert.equal(statusResponse.status, 200);
      const statusBody = await statusResponse.json() as { data: Record<string, unknown> };
      assert.deepEqual(Object.keys(statusBody.data).sort(), [
        "createdAt", "datasetId", "error", "errorCode", "jobId", "modality", "modelNameSnapshot",
        "modelVersionSnapshot", "pollAttempts", "status", "taskId", "type", "updatedAt",
      ].sort());
      assert.equal(statusBody.data.status, "SUCCEEDED");
      assert.equal(statusBody.data.taskId, taskId);
      assert.equal(statusBody.data.jobId, jobId);
      assert.equal(statusBody.data.datasetId, fixture.datasetId);
      assert.equal(statusBody.data.error, null);
      assert.equal(statusBody.data.errorCode, null);
      // The contract's own "never includes" list -- locking in that this
      // route stays a status-only DTO.
      for (const field of ["externalTaskId", "output", "predictions", "boundingBoxes", "lockToken", "workerId"]) {
        assert.equal(field in statusBody.data, false, `${field} must never appear in GET /api/ai/tasks/{id}`);
      }

      // 4. The BBOX itself: the same route the frontend already reads it
      // from (getAssetAnnotations), not an invented field on the task route.
      const annotationsResponse = await request(`/api/assets/${fixture.assetId}/annotations`, { headers: { Cookie: owner.cookie } });
      assert.equal(annotationsResponse.status, 200);
      const annotationsBody = await annotationsResponse.json() as { data: { annotations: SafeAnnotation[] } };
      const prediction = annotationsBody.data.annotations.find((item) => (item.properties as { aiTaskId?: unknown } | null)?.aiTaskId === taskId);
      assert.ok(prediction, `expected an annotation carrying properties.aiTaskId === ${taskId}`);
      assert.equal(prediction!.type, "BOUNDING_BOX");
      assert.equal(prediction!.assetId, fixture.assetId);
      assert.equal(prediction!.modality, "IMAGE");
      assert.equal(prediction!.status, "DRAFT");
      assert.equal(prediction!.labelId, fixture.labelId);
      assert.equal(prediction!.label?.id, fixture.labelId);
      assert.deepEqual(prediction!.geometry, TEST_BOUNDING_BOX);
      assert.deepEqual(prediction!.properties, { confidence: TEST_CONFIDENCE, aiTaskId: taskId, modelKey: (await db.aiModel.findUniqueOrThrow({ where: { id: fixture.modelId }, select: { key: true } })).key });
    } finally {
      await runtime.close();
      await fixture.cleanup();
    }
  },
);
