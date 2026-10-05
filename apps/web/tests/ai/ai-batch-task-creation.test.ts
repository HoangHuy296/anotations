import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { Modality, StorageProvider, UserRole } from "@internal/db";
import { aiBatchJobInputV1Schema, AI_BATCH_VERIFIED_MAX_ASSETS } from "@annotationplatform/domain/ai-batch";

import { jobQueuePayloadSchema } from "@annotationplatform/queue";

import { db } from "@/lib/db";
import { recordingQueue } from "./ai-batch-queue";
import { buildDurableJobQueueDelivery } from "@/lib/queue/enqueue-job";
import { cancelAuthorizedAiTask, createAiTask as createAiTaskLive } from "@/lib/ai/ai-task-service";
import { readAuthorizedAiTask } from "@/lib/ai/ai-task-read-service";
import { computeAiPreviewFingerprint, previewAiTarget, resolveAiTarget } from "@/lib/ai/ai-target-service";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "../workspace/helpers";

const enabled = Boolean(process.env.DATABASE_URL);
// Never push test Jobs into the live queue: the running dev worker would claim and mutate them.
const createAiTask = (actor: Parameters<typeof createAiTaskLive>[0], input: unknown, options = recordingQueue().enqueueOptions) => createAiTaskLive(actor, input, options);
const users: string[] = [];
const datasets: string[] = [];
const models: string[] = [];
after(async () => {
  // Datasets first: their AiTask rows reference the models.
  if (users.length || datasets.length) await cleanupWorkspaceFixture(users, datasets);
  if (models.length) await db.aiModel.deleteMany({ where: { id: { in: models } } });
});

let counter = 0;
async function setup(count = 3) {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  users.push(owner.id); datasets.push(dataset.id);
  // Test-only provider: the real-provider catalog/modality gates are exercised separately.
  const model = await db.aiModel.create({ data: { key: workspaceUnique("ai-batch-model"), displayName: "Batch fixture model", provider: "aioz-test-result", modality: Modality.IMAGE, taskType: "DETECT_OBJECTS", isActive: true }, select: { id: true } });
  models.push(model.id);
  const assets = [];
  for (let i = 0; i < count; i += 1) {
    const n = `${workspaceUnique("ai-create")}-${counter++}`;
    assets.push(await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: "same-name.jpg", mimeType: "image/jpeg", sourceFingerprint: n, sizeBytes: BigInt(10), storageProvider: StorageProvider.MINIO, storageBucket: "test-bucket", storageKey: `ai-create/${n}.jpg` }, select: { id: true } }));
  }
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
  return { actor, datasetId: dataset.id, modelId: model.id, assetIds: assets.map((a) => a.id).sort() };
}

const jobCount = (datasetId: string) => db.job.count({ where: { datasetId } });

test("N Assets produce exactly one Job and one AiTask holding the versioned authoritative target", { skip: !enabled }, async () => {
  const f = await setup(3);
  const result = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, target: { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds: [...f.assetIds].reverse() } } });
  // Enqueue needs a reachable Redis; the durable records exist either way (acceptance precedes delivery).
  const jobs = await db.job.findMany({ where: { datasetId: f.datasetId }, include: { aiTasks: true } });
  assert.equal(jobs.length, 1, "one Job for one batch request, never one per Asset");
  const job = jobs[0];
  assert.equal(job.type, "AI_PREANNOTATE_DATASET");
  assert.equal(job.totalItems, 3);
  assert.equal(job.modality, "IMAGE");
  const input = aiBatchJobInputV1Schema.parse(job.input);
  assert.equal(input.targetMode, "EXPLICIT");
  assert.deepEqual(input.targets.map((t) => t.assetId), f.assetIds, "ordered by id, independent of request order");
  assert.equal(input.effectiveLimit, AI_BATCH_VERIFIED_MAX_ASSETS);
  assert.ok(job.aiTasks);
  assert.deepEqual((job.aiTasks!.input as { assetIds: string[] }).assetIds, f.assetIds, "AiTask.input is the consistent projection");
  assert.equal(JSON.stringify(job.input).includes("http"), false, "no URL is ever stored in Job.input");
  if (result.ok) assert.equal(result.jobId, job.id);
});

test("current-Asset, one-member explicit and legacy assetIds create equivalent operations", { skip: !enabled }, async () => {
  const f = await setup(1);
  const bodies = [
    { target: { mode: "CURRENT_ASSET", assetId: f.assetIds[0] } },
    { target: { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds: [f.assetIds[0]] } } },
    { assetIds: [f.assetIds[0]] },
  ];
  for (const body of bodies) await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, ...body });
  const jobs = await db.job.findMany({ where: { datasetId: f.datasetId }, orderBy: { createdAt: "asc" }, include: { aiTasks: true } });
  assert.equal(jobs.length, 3);
  const parsed = jobs.map((job) => aiBatchJobInputV1Schema.parse(job.input));
  assert.deepEqual(parsed.map((p) => p.targets), [parsed[0].targets, parsed[0].targets, parsed[0].targets]);
  assert.deepEqual(parsed.map((p) => p.targetMode), ["CURRENT_ASSET", "EXPLICIT", "LEGACY_ASSET_IDS"]);
  assert.ok(jobs.every((job) => job.type === "AI_PREANNOTATE_ASSET" && job.aiTasks && JSON.stringify(job.aiTasks.input) === JSON.stringify(jobs[0].aiTasks!.input)));
});

test("a request certain to be refused creates no Job, AiTask or provider work", { skip: !enabled }, async () => {
  const f = await setup(AI_BATCH_VERIFIED_MAX_ASSETS + 1);
  const other = await setup(1);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["over the effective limit", { assetIds: f.assetIds }, "TARGET_TOO_LARGE"],
    ["foreign asset", { assetIds: [f.assetIds[0], other.assetIds[0]] }, "ASSET_NOT_IN_DATASET"],
    ["empty filter", { target: { mode: "BULK_SELECTION", selection: { mode: "FILTERED", query: { q: workspaceUnique("no-match") } } } }, "TARGET_EMPTY"],
    ["target and assetIds together", { assetIds: [f.assetIds[0]], target: { mode: "CURRENT_ASSET", assetId: f.assetIds[0] } }, "INVALID_REQUEST"],
    ["client-supplied file locations are not part of the contract", { target: { mode: "CURRENT_ASSET", assetId: f.assetIds[0], url: "http://evil.example/x.jpg" } }, "INVALID_REQUEST"],
  ];
  for (const [label, body, code] of cases) {
    const result = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, ...body });
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.code, code, label);
  }
  assert.equal(await jobCount(f.datasetId), 0);
  assert.equal(await db.aiTask.count({ where: { datasetId: f.datasetId } }), 0);
});

test("mixed modality is rejected atomically before any Job exists", { skip: !enabled }, async () => {
  const f = await setup(1);
  const video = await db.asset.create({ data: { datasetId: f.datasetId, modality: Modality.VIDEO, filename: "v.mp4", mimeType: "video/mp4", sourceFingerprint: workspaceUnique("v"), sizeBytes: BigInt(9), storageProvider: StorageProvider.MINIO, storageBucket: "b", storageKey: workspaceUnique("v") }, select: { id: true } });
  const result = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, assetIds: [f.assetIds[0], video.id] });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.code, "TARGET_MIXED_MODALITY"); assert.equal(result.status, 422); }
  assert.equal(await jobCount(f.datasetId), 0);
});

test("a stale preview fingerprint is refused with TARGET_CHANGED; a fresh one is accepted", { skip: !enabled }, async () => {
  const f = await setup(2);
  const target = { mode: "BULK_SELECTION" as const, selection: { mode: "EXPLICIT" as const, assetIds: f.assetIds } };
  const resolved = await resolveAiTarget(f.datasetId, target);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const fresh = computeAiPreviewFingerprint({ datasetId: f.datasetId, actorId: f.actor.id, modelId: f.modelId }, resolved);
  const stale = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, target, previewFingerprint: "0".repeat(64) });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "TARGET_CHANGED");
  assert.equal(await jobCount(f.datasetId), 0);
  await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, target, previewFingerprint: fresh });
  assert.equal(await jobCount(f.datasetId), 1);
  // Source change after preview: the same selection now fingerprints differently.
  await db.asset.update({ where: { id: f.assetIds[0] }, data: { sourceFingerprint: workspaceUnique("changed") } });
  const changed = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, target, previewFingerprint: fresh });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.code, "TARGET_CHANGED");
});

test("an actor without dataset access is concealed and creates nothing", { skip: !enabled }, async () => {
  const f = await setup(1);
  const stranger = await createWorkspaceUser(UserRole.MANAGER);
  users.push(stranger.id);
  const result = await createAiTask({ id: stranger.id, email: stranger.email, name: stranger.name, role: stranger.role }, { datasetId: f.datasetId, modelId: f.modelId, assetIds: f.assetIds });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "DATASET_NOT_FOUND");
  assert.equal(await jobCount(f.datasetId), 0);
});

test("DI-5: a real-provider model absent from the deployed catalog is rejected before any Job; a catalog outage fails closed", { skip: !enabled }, async (t) => {
  const f = await setup(1);
  const key = randomUUID();
  await db.aiModel.update({ where: { id: f.modelId }, data: { provider: "aioz-company", key } });
  const catalog = (ids: string[]) => new Response(JSON.stringify({ success: true, data: ids.map((id) => ({ model_id: id, model_name: "m", type: "image", task_name: "detection" })) }), { status: 200, headers: { "Content-Type": "application/json" } });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => catalog([randomUUID()]));
  const stale = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, target: { mode: "CURRENT_ASSET", assetId: f.assetIds[0] } });
  assert.equal(stale.ok, false);
  if (!stale.ok) { assert.equal(stale.code, "AI_MODEL_INACTIVE"); assert.equal(stale.status, 409); }
  assert.equal(await jobCount(f.datasetId), 0, "no Job may exist for a model the provider would reject");

  fetchMock.mock.mockImplementation(async () => new Response("down", { status: 500 }));
  const outage = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, target: { mode: "CURRENT_ASSET", assetId: f.assetIds[0] } });
  assert.equal(outage.ok, false);
  if (!outage.ok) { assert.equal(outage.code, "AI_MODEL_CATALOG_UNAVAILABLE"); assert.equal(outage.status, 502); }
  assert.equal(await jobCount(f.datasetId), 0);

  fetchMock.mock.mockImplementation(async () => catalog([key]));
  await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, target: { mode: "CURRENT_ASSET", assetId: f.assetIds[0] } });
  assert.equal(await jobCount(f.datasetId), 1, "a model the provider lists is accepted");
});

test("the queue transport carries only { jobId } and rejects any target, URL or credential field (T021)", () => {
  const delivery = buildDurableJobQueueDelivery("job-1");
  assert.deepEqual(delivery.payload, { jobId: "job-1" });
  for (const extra of [{ assetIds: ["a"] }, { input: {} }, { url: "https://x/y?X-Amz-Signature=z" }, { target: { mode: "CURRENT_ASSET" } }]) {
    assert.equal(jobQueuePayloadSchema.safeParse({ jobId: "job-1", ...extra }).success, false);
  }
});

test("the accepted-target summary is safe and reports the effective limit, never 200 as a provider claim", { skip: !enabled }, async () => {
  const f = await setup(2);
  const result = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, assetIds: f.assetIds });
  if (result.ok) assert.deepEqual(result.target, { mode: "LEGACY_ASSET_IDS", count: 2, modality: "IMAGE", effectiveLimit: AI_BATCH_VERIFIED_MAX_ASSETS });
  assert.equal(await jobCount(f.datasetId), 1);
});

test("preview is read-only, reports count/modality/limit, returns nothing for an ineligible target, and its fingerprint is accepted by creation", { skip: !enabled }, async () => {
  const f = await setup(2);
  const target = { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds: f.assetIds } };
  const preview = await previewAiTarget(f.actor, { datasetId: f.datasetId, target, modelId: f.modelId });
  assert.equal(preview.ok, true);
  if (!preview.ok || !preview.preview.eligible) throw new Error("expected an eligible preview");
  assert.deepEqual([preview.preview.count, preview.preview.modality, preview.preview.effectiveLimit, preview.preview.mode], [2, "IMAGE", AI_BATCH_VERIFIED_MAX_ASSETS, "EXPLICIT"]);
  assert.equal(await jobCount(f.datasetId), 0, "preview creates nothing");
  assert.equal(JSON.stringify(preview).includes(f.assetIds[0]), false, "preview never echoes ids");
  await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, target, previewFingerprint: preview.preview.previewFingerprint });
  assert.equal(await jobCount(f.datasetId), 1, "the preview fingerprint is accepted by creation");

  const empty = await previewAiTarget(f.actor, { datasetId: f.datasetId, target: { mode: "BULK_SELECTION", selection: { mode: "FILTERED", query: { q: workspaceUnique("none") } } } });
  assert.deepEqual(empty, { ok: true, preview: { eligible: false, reason: "TARGET_EMPTY", effectiveLimit: AI_BATCH_VERIFIED_MAX_ASSETS } });
  const stranger = await createWorkspaceUser(UserRole.MANAGER);
  users.push(stranger.id);
  const concealed = await previewAiTarget({ id: stranger.id, email: stranger.email, name: stranger.name, role: stranger.role }, { datasetId: f.datasetId, target });
  assert.deepEqual(concealed, { ok: false, status: 404, code: "DATASET_NOT_FOUND" });
  assert.equal((await previewAiTarget(f.actor, { datasetId: f.datasetId, target: { mode: "CURRENT_ASSET", assetId: f.assetIds[0], url: "http://x" } })).ok, false);
});

test("the task read view projects the accepted target and per-Asset outcomes without provider or storage detail, and stays null for historical tasks", { skip: !enabled }, async () => {
  const f = await setup(3);
  await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, assetIds: f.assetIds });
  const job = await db.job.findFirstOrThrow({ where: { datasetId: f.datasetId }, include: { aiTasks: true } });
  const taskId = job.aiTasks!.id;

  const inflight = await readAuthorizedAiTask(f.actor, taskId);
  assert.ok(inflight.ok && inflight.task.batch);
  if (!inflight.ok || !inflight.task.batch) return;
  assert.deepEqual([inflight.task.batch.count, inflight.task.batch.modality, inflight.task.batch.counts.total, inflight.task.batch.counts.processed], [3, "IMAGE", 3, 0]);
  assert.equal(inflight.task.batch.retryable, false, "only a failed operation can be retryable");

  const outcomes = f.assetIds.map((assetId, inputIndex) => ({ assetId, inputIndex, outcome: "FAILED", predictionCount: 0, reason: "ASSET_UNAVAILABLE" }));
  await db.aiTask.update({ where: { id: taskId }, data: { status: "FAILED", errorCode: "AIOZ_ASSET_UNAVAILABLE", output: { predictions: [], perAsset: outcomes } } });
  const failed = await readAuthorizedAiTask(f.actor, taskId);
  assert.ok(failed.ok && failed.task.batch);
  if (!failed.ok || !failed.task.batch) return;
  assert.deepEqual(failed.task.batch.counts, { total: 3, processed: 3, succeeded: 0, failed: 3, skipped: 0, canceled: 0 });
  assert.equal(failed.task.batch.outcomes.length, 3);
  assert.equal(failed.task.batch.retryable, true);
  const dump = JSON.stringify(failed.task);
  for (const forbidden of ["externalTaskId", "urlDigest", "sourceIdentityDigest", "storageKey", "http"]) assert.equal(dump.includes(forbidden), false, forbidden);

  await db.aiTask.update({ where: { id: taskId }, data: { errorCode: "AIOZ_TIMEOUT", summary: { aiozSubmission: { version: 1, images: [] } } } });
  const ambiguous = await readAuthorizedAiTask(f.actor, taskId);
  assert.ok(ambiguous.ok && ambiguous.task.batch?.retryable === false, "an ambiguous submission is not retryable");

  const stranger = await createWorkspaceUser(UserRole.MANAGER);
  users.push(stranger.id);
  assert.deepEqual(await readAuthorizedAiTask({ id: stranger.id, email: stranger.email, name: stranger.name, role: stranger.role }, taskId), { ok: false, status: 404 });

  await db.job.update({ where: { id: job.id }, data: { input: {} } });
  const historical = await readAuthorizedAiTask(f.actor, taskId);
  assert.ok(historical.ok && historical.task.batch === null, "historical detail is never invented");
});

test("the real queue payload is exactly { jobId } and an enqueue failure after commit keeps the durable references (T021/T025)", { skip: !enabled }, async () => {
  const f = await setup(2);
  const sent = recordingQueue();
  const accepted = await createAiTaskLive(f.actor, { datasetId: f.datasetId, modelId: f.modelId, assetIds: f.assetIds }, sent.enqueueOptions);
  assert.equal(accepted.ok, true);
  const job = await db.job.findFirstOrThrow({ where: { datasetId: f.datasetId } });
  assert.equal(sent.adds.length, 1, "one queue message for one operation");
  assert.deepEqual(sent.adds[0].payload, { jobId: job.id }, "no asset list, URL or config in the transport");
  assert.equal(JSON.stringify(sent.adds[0]).includes(f.assetIds[0]), false);
  assert.ok(job.enqueuedAt && job.queueJobId, "delivery stamped only after the durable commit");

  const g = await setup(1);
  const broken = recordingQueue({ failOnAdd: true });
  const pending = await createAiTaskLive(g.actor, { datasetId: g.datasetId, modelId: g.modelId, assetIds: g.assetIds }, broken.enqueueOptions);
  assert.equal(pending.ok, true, "the operation is durably accepted even though delivery is pending");
  if (pending.ok) assert.ok(pending.taskId && pending.jobId, "references are returned, so the caller never resubmits");
  const kept = await db.job.findFirstOrThrow({ where: { datasetId: g.datasetId } });
  assert.equal(kept.status, "QUEUED");
  assert.equal(kept.enqueuedAt, null, "left for the recovery scanner");
  assert.equal(await jobCount(g.datasetId), 1);
});

test("regression: an Asset missing its size or storage location is rejected at acceptance with no Job, whether requested alone or in a batch", { skip: !enabled }, async () => {
  const f = await setup(2);
  const noSize = await db.asset.create({ data: { datasetId: f.datasetId, modality: Modality.IMAGE, filename: "ns.jpg", mimeType: "image/jpeg", sourceFingerprint: workspaceUnique("no-size"), storageProvider: StorageProvider.MINIO, storageBucket: "b", storageKey: workspaceUnique("k") }, select: { id: true } });
  const noStorage = await db.asset.create({ data: { datasetId: f.datasetId, modality: Modality.IMAGE, filename: "nst.jpg", mimeType: "image/jpeg", sourceFingerprint: workspaceUnique("no-storage"), sizeBytes: BigInt(4) }, select: { id: true } });
  for (const [label, ids] of [["alone, no size", [noSize.id]], ["alone, no storage", [noStorage.id]], ["in a batch", [f.assetIds[0], noSize.id]]] as const) {
    const result = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, assetIds: [...ids] });
    assert.equal(result.ok, false, label);
    if (!result.ok) { assert.equal(result.code, "TARGET_INELIGIBLE", label); assert.equal(result.status, 422, label); }
  }
  assert.equal(await jobCount(f.datasetId), 0);
  assert.equal(await db.aiTask.count({ where: { datasetId: f.datasetId } }), 0);
});

test("regression: existing single-Asset VIDEO AI (real provider path, deployed catalog) is still accepted through the unified path, while a VIDEO batch is refused before any Job", { skip: !enabled }, async (t) => {
  const f = await setup(1);
  const key = randomUUID();
  await db.aiModel.update({ where: { id: f.modelId }, data: { provider: "aioz-company", key, modality: Modality.VIDEO, taskType: "TRACKING" } });
  const makeVideo = (name: string) => db.asset.create({ data: { datasetId: f.datasetId, modality: Modality.VIDEO, filename: name, mimeType: "video/mp4", sourceFingerprint: workspaceUnique(name), sizeBytes: BigInt(99), storageProvider: StorageProvider.MINIO, storageBucket: "b", storageKey: workspaceUnique(name) }, select: { id: true } });
  const [v1, v2] = [await makeVideo("v1.mp4"), await makeVideo("v2.mp4")];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true, data: [{ model_id: key, model_name: "tracker", type: "video", task_name: "tracking" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));

  const single = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, target: { mode: "CURRENT_ASSET", assetId: v1.id } });
  assert.equal(single.ok, true, "single-Asset VIDEO keeps working");
  const job = await db.job.findFirstOrThrow({ where: { datasetId: f.datasetId }, include: { aiTasks: true } });
  assert.equal(job.type, "AI_PREANNOTATE_ASSET");
  assert.equal(job.modality, "VIDEO");
  assert.equal(job.aiTasks?.type, "TRACKING");

  const batch = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, assetIds: [v1.id, v2.id] });
  assert.equal(batch.ok, false);
  if (!batch.ok) assert.equal(batch.code, "AI_CAPABILITY_UNVERIFIED");
  assert.equal(await jobCount(f.datasetId), 1, "the refused batch created nothing");
});

test("canceling a still-queued operation closes its AiTask and accounts for every accepted target (no stuck QUEUED task)", { skip: !enabled }, async () => {
  const f = await setup(2);
  const accepted = await createAiTask(f.actor, { datasetId: f.datasetId, modelId: f.modelId, assetIds: f.assetIds });
  assert.ok(accepted.ok);
  if (!accepted.ok) return;
  const cancel = await cancelAuthorizedAiTask(f.actor, accepted.taskId);
  assert.ok(cancel.ok && cancel.jobStatus === "CANCELED");
  const task = await db.aiTask.findUniqueOrThrow({ where: { id: accepted.taskId } });
  const job = await db.job.findUniqueOrThrow({ where: { id: accepted.jobId } });
  assert.equal(task.status, "CANCELED");
  assert.equal(job.status, "CANCELED");
  const outcomes = (task.output as { perAsset: Array<{ outcome: string }> }).perAsset;
  assert.ok(outcomes.length === 2 && outcomes.every((o) => o.outcome === "CANCELED"));
  assert.deepEqual([job.totalItems, job.processedItems, (job.summary as { canceledItems: number }).canceledItems], [2, 2, 2]);
  const read = await readAuthorizedAiTask(f.actor, accepted.taskId);
  assert.ok(read.ok && read.task.status === "CANCELED" && read.task.batch?.counts.canceled === 2);
});
