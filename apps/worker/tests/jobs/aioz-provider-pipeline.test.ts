import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAiPollFixture, hasIntegrationDatabase } from "./ai-fixtures.js";
import { processAiSubmit } from "../../src/jobs/ai-submit.processor.js";
import { processAiPoll } from "../../src/jobs/ai-poll.processor.js";
import { handleAiTaskCompleted } from "../../src/jobs/ai-prediction-writer.js";
import { AiozAnnotationServicesProvider } from "../../src/providers/ai/aioz-annotation-services-provider.js";
import { createAiozTaskResources } from "../../src/providers/ai/aioz-task-resources.js";

const config = { baseUrl: "http://aioz.test", apiKey: "fixture-key", timeoutMs: 1000 };
const bus = "https://ultralytics.com/images/bus.jpg";
const video = "https://i.ytimg.com/vi/5ku7npMrW40/maxresdefault.jpg";
const worker = "aioz-test-worker";
const lock = "aioz-test-lock";

async function setup() {
  const f = await createAiPollFixture({ assetCount: 2 });
  const modelKey = randomUUID();
  await f.db.aiModel.update({ where: { id: f.modelId }, data: { key: modelKey, metadata: { aioz: { classes: ["person", "bicycle", "car"], confidence_threshold: 0.5, iou_threshold: 0.5 } } } });
  await f.db.aiTask.update({ where: { id: f.aiTaskId }, data: { modelKeySnapshot: modelKey, externalTaskId: null } });
  await f.db.job.update({ where: { id: f.jobId }, data: { lockedBy: worker, lockToken: lock, lockedUntil: new Date(Date.now() + 180_000) } });
  for (const assetId of f.assetIds) await f.db.asset.update({ where: { id: assetId }, data: { storageProvider: "MINIO", storageBucket: "ai-test", storageKey: assetId } });
  const signer = async (_bucket: string, key: string) => key === f.assetIds[0] ? bus : video;
  return { ...f, signer, input: { aiTaskId: f.aiTaskId, assetIds: f.assetIds, modelKey } };
}

test("AIOZ submit, restart, pending/inprocess/success and duplicate ticks use durable mapping and existing Annotation writer", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  const remoteId = randomUUID();
  let posts = 0;
  let polls = 0;
  const http: typeof fetch = async (_url, init) => {
    if (init?.method === "POST") { posts++; return Response.json({ success: true, data: { task_id: remoteId, status: "create", created_at: new Date().toISOString() } }, { status: 202 }); }
    polls++;
    return Response.json({ success: true, data: { task_id: remoteId, status: polls === 1 ? "pending" : polls === 2 ? "inprocess" : "success", error: null, output: polls < 3 ? null : [
      { width: 1280, height: 720, image_path: video, class_names: ["person"], outputs: [{ box: [637.1444702148438, 52.26556396484375, 1274.0462646484375, 715.6981201171875], score: 0.9733365774154663, class_id: 0, class_name: "person" }] },
      { width: 810, height: 1080, image_path: bus, class_names: ["person"], outputs: [{ box: [668.0579109191895, 392.17174530029297, 809, 880.3952407836914], score: 0.9430617690086365, class_id: 0, class_name: "person" }] },
    ] } });
  };
  const provider = () => new AiozAnnotationServicesProvider(config, createAiozTaskResources(f.db, f.signer), http);
  try {
    await processAiSubmit(f.db, f.jobId, lock, { "aioz-company": provider() });
    const submitted = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
    assert.equal(submitted.externalTaskId, remoteId);
    assert.equal(submitted.status, "RUNNING");
    assert.ok(submitted.nextPollAt);
    assert.equal(JSON.stringify(submitted.summary).includes("https://"), false);
    assert.equal(JSON.stringify(submitted).includes(config.apiKey), false);
    await processAiSubmit(f.db, f.jobId, lock, { "aioz-company": provider() });
    assert.equal(posts, 1);
    for (let i = 0; i < 3; i++) await processAiPoll(f.db, f.jobId, worker, { "aioz-company": provider() });
    await processAiPoll(f.db, f.jobId, worker, { "aioz-company": provider() });
    assert.equal(polls, 3);
    const rows = await f.db.annotation.findMany({ where: { datasetId: f.datasetId } });
    assert.equal(rows.length, 2);
    const row = rows.find((item) => item.assetId === f.assetIds[0]);
    assert.ok(row);
    assert.equal(row.type, "BOUNDING_BOX");
    assert.equal(row.labelId, f.labelId);
    assert.equal(row.source, "AI");
    const expected = { x: 668.0579109191895 / 810, y: 392.17174530029297 / 1080, width: (809 - 668.0579109191895) / 810, height: (880.3952407836914 - 392.17174530029297) / 1080 };
    // JSONB/Prisma numeric round trips may differ by one IEEE-754 ULP.
    for (const [key, value] of Object.entries(expected)) assert.ok(Math.abs((row.geometry as Record<string, number>)[key] - value) < 1e-15);
    assert.equal((await f.db.job.findUniqueOrThrow({ where: { id: f.jobId } })).status, "COMPLETED");
  } finally { await f.cleanup(); }
});

test("concurrent reservation has one winner; crash before external ID persistence refuses blind resubmission", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  try {
    const a = createAiozTaskResources(f.db, f.signer);
    const outcomes = await Promise.allSettled([a.prepare(f.input), createAiozTaskResources(f.db, f.signer).prepare(f.input)]);
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    await assert.rejects(createAiozTaskResources(f.db, f.signer).prepare(f.input), /AIOZ_SUBMISSION_AMBIGUOUS/);
    assert.equal(await f.db.annotation.count({ where: { datasetId: f.datasetId } }), 0);
  } finally { await f.cleanup(); }
});

test("canceled Job cannot reserve/submit and poll cancellation makes no external call", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  try {
    await f.db.job.update({ where: { id: f.jobId }, data: { status: "CANCELING", cancelRequestedAt: new Date() } });
    let requests = 0;
    const provider = new AiozAnnotationServicesProvider(config, createAiozTaskResources(f.db, f.signer), async () => { requests++; throw new Error("must not call"); });
    await processAiSubmit(f.db, f.jobId, lock, { "aioz-company": provider });
    await processAiPoll(f.db, f.jobId, worker, { "aioz-company": provider });
    assert.equal(requests, 0);
    assert.equal((await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } })).status, "CANCELED");
  } finally { await f.cleanup(); }
});

test("terminal writer replay cannot create duplicate annotations", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  try {
    const task = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
    const predictions = [{ assetId: f.assetIds[0], labelKey: "person", confidence: 0.9, boundingBoxes: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }];
    await handleAiTaskCompleted(f.db, f.jobId, task, predictions, lock, worker);
    await handleAiTaskCompleted(f.db, f.jobId, task, predictions, lock, worker);
    assert.equal(await f.db.annotation.count({ where: { datasetId: f.datasetId } }), 1);
  } finally { await f.cleanup(); }
});

test("cancellation before persistence leaves the Job canceling with no Annotation writes", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  try {
    const task = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
    await f.db.job.update({ where: { id: f.jobId }, data: { status: "CANCELING", cancelRequestedAt: new Date() } });
    await handleAiTaskCompleted(f.db, f.jobId, task, [{ assetId: f.assetIds[0], labelKey: "person", confidence: 0.9, boundingBoxes: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }], lock, worker);
    assert.equal(await f.db.annotation.count({ where: { datasetId: f.datasetId } }), 0);
    assert.equal((await f.db.job.findUniqueOrThrow({ where: { id: f.jobId } })).status, "CANCELING");
  } finally { await f.cleanup(); }
});

test("cancellation during AIOZ HTTP finalizes cancellation rather than the returned success", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  const remoteId = randomUUID();
  try {
    await f.db.aiTask.update({ where: { id: f.aiTaskId }, data: { externalTaskId: remoteId } });
    const adapter = {
      submitTask: async () => ({ externalTaskId: remoteId }),
      getTaskStatus: async () => {
        await f.db.job.update({ where: { id: f.jobId }, data: { status: "CANCELING", cancelRequestedAt: new Date() } });
        return { status: "COMPLETED" as const, rawPredictions: [] };
      },
      normalizePredictions: () => { throw new Error("Canceled result must not be normalized"); },
    };
    await processAiPoll(f.db, f.jobId, worker, { "aioz-company": adapter });
    assert.equal((await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } })).status, "CANCELED");
    assert.equal((await f.db.job.findUniqueOrThrow({ where: { id: f.jobId } })).status, "CANCELED");
    assert.equal(await f.db.annotation.count({ where: { datasetId: f.datasetId } }), 0);
  } finally { await f.cleanup(); }
});

test("ID persistence includes scanner handoff and reloaded resources reuse the external task", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  const remoteId = randomUUID();
  try {
    const resources = createAiozTaskResources(f.db, f.signer);
    await resources.prepare(f.input);
    await resources.recordSubmission(f.aiTaskId, remoteId);
    const saved = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
    assert.ok(saved.nextPollAt);
    assert.equal(saved.externalTaskId, remoteId);
    assert.deepEqual(await createAiozTaskResources(f.db, f.signer).prepare(f.input), { externalTaskId: remoteId });
  } finally { await f.cleanup(); }
});

test("completion write failure rolls back Job finalization and Asset revision along with annotations", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  try {
    const task = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
    const before = await f.db.asset.findUniqueOrThrow({ where: { id: f.assetIds[0] } });
    // Missing author deliberately trips the existing Annotation foreign key.
    await assert.rejects(handleAiTaskCompleted(f.db, f.jobId, { ...task, createdById: "missing-author" }, [{ assetId: f.assetIds[0], labelKey: "person", confidence: 0.9, boundingBoxes: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }], lock, worker));
    assert.equal((await f.db.job.findUniqueOrThrow({ where: { id: f.jobId } })).status, "RUNNING");
    assert.equal((await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } })).status, "RUNNING");
    assert.equal((await f.db.asset.findUniqueOrThrow({ where: { id: f.assetIds[0] } })).revision, before.revision);
    assert.equal(await f.db.annotation.count({ where: { datasetId: f.datasetId } }), 0);
  } finally { await f.cleanup(); }
});

test("late AI output preserves review-frozen Asset status, revision and workflow history", { skip: !hasIntegrationDatabase }, async () => {
  for (const status of ["NEEDS_REVIEW", "REVIEWED", "REJECTED"] as const) {
    const f = await setup();
    try {
      const before = await f.db.asset.update({ where: { id: f.assetIds[0] }, data: { status }, select: { status: true, revision: true } });
      const task = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
      await handleAiTaskCompleted(f.db, f.jobId, task, [{ assetId: f.assetIds[0], labelKey: "person", confidence: 0.9, boundingBoxes: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }], lock, worker);
      assert.deepEqual(await f.db.asset.findUniqueOrThrow({ where: { id: f.assetIds[0] }, select: { status: true, revision: true } }), before);
      assert.equal(await f.db.annotation.count({ where: { datasetId: f.datasetId } }), 0);
      assert.equal(await f.db.assetWorkflowEvent.count({ where: { assetId: f.assetIds[0] } }), 0);
    } finally { await f.cleanup(); }
  }
});

test("unavailable binary and changed asset scope never reserve a submission", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  try {
    await assert.rejects(createAiozTaskResources(f.db, f.signer).prepare({ ...f.input, assetIds: ["not-submitted"] }), /AIOZ_INVALID_INPUT/);
    await f.db.asset.update({ where: { id: f.assetIds[0] }, data: { storageKey: null } });
    await assert.rejects(createAiozTaskResources(f.db, f.signer).prepare(f.input), /AIOZ_ASSET_BINARY_UNAVAILABLE/);
    assert.deepEqual((await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } })).summary, {});
  } finally { await f.cleanup(); }
});

test("persisted task classes and thresholds override model defaults in the actual provider request", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  try {
    await f.db.aiTask.update({ where: { id: f.aiTaskId }, data: { input: { assetIds: f.assetIds, classes: ["car"], confidence_threshold: 0.55, iou_threshold: 0.65 } } });
    let requests = 0;
    const provider = new AiozAnnotationServicesProvider(config, createAiozTaskResources(f.db, f.signer), async (_url, init) => {
      requests++;
      const body = JSON.parse(init?.body as string);
      assert.deepEqual(body.classes, ["car"]);
      assert.equal(body.confidence_threshold, 0.55);
      assert.equal(body.iou_threshold, 0.65);
      return Response.json({ success: true, data: { task_id: randomUUID(), status: "create", created_at: new Date().toISOString() } });
    });
    await provider.submitTask(f.input);
    assert.equal(requests, 1);
  } finally { await f.cleanup(); }
});
