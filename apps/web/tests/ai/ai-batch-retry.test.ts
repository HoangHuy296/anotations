import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { Modality, StorageProvider, UserRole } from "@internal/db";
import { aiBatchJobInputV1Schema } from "@annotationplatform/domain/ai-batch";

import { db } from "@/lib/db";
import { recordingQueue } from "./ai-batch-queue";
import { createAiTask as createAiTaskLive } from "@/lib/ai/ai-task-service";
import { retryAuthorizedJob as retryLive } from "@/lib/jobs/retry-job";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "../workspace/helpers";

const enabled = Boolean(process.env.DATABASE_URL);
// Never push test Jobs into the live queue: the running dev worker would claim and mutate them.
const createAiTask = (actor: Parameters<typeof createAiTaskLive>[0], input: unknown) => createAiTaskLive(actor, input, recordingQueue().enqueueOptions);
const retryAuthorizedJob = (actor: Parameters<typeof retryLive>[0], jobId: string) => retryLive(actor, jobId, recordingQueue().enqueueOptions);
const users: string[] = [];
const datasets: string[] = [];
const models: string[] = [];
after(async () => {
  if (users.length || datasets.length) await cleanupWorkspaceFixture(users, datasets);
  if (models.length) await db.aiModel.deleteMany({ where: { id: { in: models } } });
});

let counter = 0;
async function failedOperation(count: number, failure: { errorCode: string; reserved?: boolean; externalTaskId?: string }) {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  users.push(owner.id); datasets.push(dataset.id);
  const model = await db.aiModel.create({ data: { key: workspaceUnique("ai-retry-model"), displayName: "Retry fixture", provider: "aioz-test-result", modality: Modality.IMAGE, taskType: "DETECT_OBJECTS", isActive: true }, select: { id: true } });
  models.push(model.id);
  const assetIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const n = `${workspaceUnique("ai-retry")}-${counter++}`;
    assetIds.push((await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: "r.jpg", mimeType: "image/jpeg", sourceFingerprint: n, sizeBytes: BigInt(5), storageProvider: StorageProvider.MINIO, storageBucket: "b", storageKey: `ai-retry/${n}.jpg` }, select: { id: true } })).id);
  }
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
  await createAiTask(actor, { datasetId: dataset.id, modelId: model.id, assetIds });
  const job = await db.job.findFirstOrThrow({ where: { datasetId: dataset.id }, include: { aiTasks: true } });
  await db.aiTask.update({ where: { id: job.aiTasks!.id }, data: { status: "FAILED", errorCode: failure.errorCode, error: "AI provider submission failed.", externalTaskId: failure.externalTaskId ?? null, ...(failure.reserved ? { summary: { aiozSubmission: { version: 1, phase: "SUBMITTING", images: [] } } } : {}), output: { predictions: [], perAsset: [] } } });
  await db.job.update({ where: { id: job.id }, data: { status: "FAILED", errorCode: failure.errorCode, finishedAt: new Date() } });
  return { actor, owner, datasetId: dataset.id, jobId: job.id, assetIds, aiTaskId: job.aiTasks!.id, modelId: model.id };
}

test("a definitely-unsubmitted failure retries into one linked successor with a new AiTask and untouched history", { skip: !enabled }, async () => {
  const f = await failedOperation(3, { errorCode: "AIOZ_SOURCE_CHANGED" });
  const result = await retryAuthorizedJob(f.actor, f.jobId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, 201);
  const successor = await db.job.findUniqueOrThrow({ where: { id: result.job.id }, include: { aiTasks: true } });
  assert.equal(successor.retryOfJobId, f.jobId);
  assert.equal(successor.trigger, "RETRY");
  assert.equal(successor.type, "AI_PREANNOTATE_DATASET");
  assert.equal(successor.totalItems, 3);
  assert.equal(successor.createdById, f.actor.id);
  assert.deepEqual(aiBatchJobInputV1Schema.parse(successor.input).targets.map((t) => t.assetId), [...f.assetIds].sort());
  assert.ok(successor.aiTasks && successor.aiTasks.id !== f.aiTaskId && successor.aiTasks.externalTaskId === null && successor.aiTasks.status === "QUEUED");
  const predecessor = await db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
  assert.equal(predecessor.status, "FAILED", "failure history is immutable");
  assert.equal(predecessor.errorCode, "AIOZ_SOURCE_CHANGED");
  const again = await retryAuthorizedJob(f.actor, f.jobId);
  assert.ok(again.ok && again.status === 200 && again.job.id === result.job.id, "repeat returns the same successor");
});

test("concurrent retry requests converge on exactly one successor", { skip: !enabled }, async () => {
  const f = await failedOperation(2, { errorCode: "AIOZ_ASSET_UNAVAILABLE" });
  const results = await Promise.all(Array.from({ length: 5 }, () => retryAuthorizedJob(f.actor, f.jobId)));
  assert.ok(results.every((r) => r.ok));
  assert.equal(new Set(results.map((r) => (r.ok ? r.job.id : ""))).size, 1);
  assert.equal(await db.job.count({ where: { retryOfJobId: f.jobId } }), 1);
  assert.equal(await db.aiTask.count({ where: { job: { retryOfJobId: f.jobId } } }), 1);
});

test("DI-1: ambiguous or externally-recorded failures are never retried; a definite 4xx refusal is", { skip: !enabled }, async () => {
  for (const [label, failure, allowed] of [
    ["5xx after reservation", { errorCode: "AIOZ_HTTP_5XX", reserved: true }, false],
    ["timeout after reservation", { errorCode: "AIOZ_TIMEOUT", reserved: true }, false],
    ["network failure after reservation", { errorCode: "AIOZ_NETWORK_ERROR", reserved: true }, false],
    ["external task recorded", { errorCode: "AI_TASK_TIMEOUT", externalTaskId: "external-1" }, false],
    ["definite 4xx refusal", { errorCode: "AIOZ_HTTP_4XX", reserved: true }, true],
  ] as const) {
    const f = await failedOperation(1, failure);
    const result = await retryAuthorizedJob(f.actor, f.jobId);
    assert.equal(result.ok, allowed, label);
    if (!allowed) { assert.deepEqual(result, { ok: false, status: 409 }, label); assert.equal(await db.job.count({ where: { retryOfJobId: f.jobId } }), 0, `${label}: no successor and no second external task`); }
  }
});

test("the retry never shrinks the accepted target: a removed member rejects it whole", { skip: !enabled }, async () => {
  const f = await failedOperation(3, { errorCode: "AIOZ_SOURCE_CHANGED" });
  await db.asset.update({ where: { id: f.assetIds[1] }, data: { archivedAt: new Date() } });
  assert.deepEqual(await retryAuthorizedJob(f.actor, f.jobId), { ok: false, status: 409 });
  assert.equal(await db.job.count({ where: { retryOfJobId: f.jobId } }), 0);
});

test("retry is concealed from outsiders, refused for historical or non-failed operations", { skip: !enabled }, async () => {
  const f = await failedOperation(1, { errorCode: "AIOZ_SOURCE_CHANGED" });
  const stranger = await createWorkspaceUser(UserRole.MANAGER);
  users.push(stranger.id);
  const outsider = await retryAuthorizedJob({ id: stranger.id, email: stranger.email, name: stranger.name, role: stranger.role }, f.jobId);
  assert.equal(outsider.ok, false);
  assert.equal(await db.job.count({ where: { retryOfJobId: f.jobId } }), 0);

  const historical = await failedOperation(1, { errorCode: "AIOZ_SOURCE_CHANGED" });
  await db.job.update({ where: { id: historical.jobId }, data: { input: {} } });
  assert.deepEqual(await retryAuthorizedJob(historical.actor, historical.jobId), { ok: false, status: 409 });

  const running = await failedOperation(1, { errorCode: "AIOZ_SOURCE_CHANGED" });
  await db.job.update({ where: { id: running.jobId }, data: { status: "RUNNING" } });
  assert.deepEqual(await retryAuthorizedJob(running.actor, running.jobId), { ok: false, status: 409 });
});
