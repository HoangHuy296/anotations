import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAiPollFixture, hasIntegrationDatabase } from "./ai-fixtures.js";
import { handleAiTaskCompleted } from "../../src/jobs/ai-prediction-writer.js";
import { processAiSubmit } from "../../src/jobs/ai-submit.processor.js";
import { processAiPoll } from "../../src/jobs/ai-poll.processor.js";
import { normalizeAiozVideoOutput } from "../../src/providers/ai/aioz-video-normalization.js";
import { AiozAnnotationServicesProvider } from "../../src/providers/ai/aioz-annotation-services-provider.js";
import { createAiozTaskResources } from "../../src/providers/ai/aioz-task-resources.js";

const fixture = JSON.parse(readFileSync(new URL("../providers/ai/fixtures/aioz-video-output.json", import.meta.url), "utf8"));
const worker = "video-test-worker", lock = "video-test-lock";
async function setup() {
  const f = await createAiPollFixture();
  const key = randomUUID();
  await f.db.asset.update({ where: { id: f.assetIds[0] }, data: { modality: "VIDEO", mimeType: "video/mp4", storageProvider: "MINIO", storageBucket: "test", storageKey: "video.mp4", videoAsset: { create: { fps: 29.907, totalFrames: 850 } } } });
  await f.db.aiModel.update({ where: { id: f.modelId }, data: { key, modality: "VIDEO", taskType: "TRACKING" } });
  await f.db.aiTask.update({ where: { id: f.aiTaskId }, data: { modality: "VIDEO", type: "TRACKING", modelKeySnapshot: key, externalTaskId: null } });
  await f.db.job.update({ where: { id: f.jobId }, data: { lockedBy: worker, lockToken: lock, lockedUntil: new Date(Date.now() + 180_000) } });
  const predictions = normalizeAiozVideoOutput(fixture, [{ assetId: f.assetIds[0], imageUrl: fixture[0].video_path }]);
  return { ...f, predictions, task: await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } }) };
}

test("video submit/poll/restart writes ten labeled tracks and 38 AI keyframes once", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup(); const remoteId = randomUUID(); let posts = 0;
  const provider = () => new AiozAnnotationServicesProvider({ baseUrl: "http://aioz.test", apiKey: "test", timeoutMs: 1000 }, createAiozTaskResources(f.db, async () => fixture[0].video_path), async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      assert.deepEqual(JSON.parse(String(init.body)), {
        type: "video", task_name: "tracking", files: [fixture[0].video_path], model_id: key,
        confidence_threshold: 0.5, iou_threshold: 0.5,
      });
      return Response.json({ success: true, data: { task_id: remoteId, status: "create", created_at: new Date().toISOString() } });
    }
    return Response.json({ success: true, data: { task_id: remoteId, status: "success", output: fixture, error: null } });
  });
  try {
    await processAiSubmit(f.db, f.jobId, lock, { "aioz-company": provider() });
    await processAiSubmit(f.db, f.jobId, lock, { "aioz-company": provider() });
    assert.equal(posts, 1);
    await processAiPoll(f.db, f.jobId, worker, { "aioz-company": provider() });
    await processAiPoll(f.db, f.jobId, worker, { "aioz-company": provider() });
    const tracks = await f.db.videoObjectTrack.findMany({ where: { videoAsset: { assetId: f.assetIds[0] } } });
    const frames = await f.db.annotation.findMany({ where: { assetId: f.assetIds[0] }, orderBy: { frameIndex: "asc" } });
    assert.equal(tracks.length, 10); assert.equal(frames.length, 38);
    assert.ok(tracks.every((track) => track.labelId !== null && track.interpolationMode === "NONE" && track.status === "DRAFT"));
    assert.ok(frames.every((frame) => frame.source === "AI" && frame.isKeyframe && !frame.isInterpolated && frame.modality === "VIDEO" && frame.trackId && frame.revision === 1));
    assert.equal(frames[0].frameIndex, 54); assert.equal(frames[0].timestampMs, 1806);
    assert.equal((frames[0].properties as { providerClassId: number }).providerClassId, 56);
    const task = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
    assert.equal(task.status, "SUCCEEDED");
    assert.deepEqual(task.output, { tracksCreated: 10, keyframesCreated: 38 });
    assert.equal(JSON.stringify({ tracks, frames, task }).includes("https://"), false);
  } finally { await f.cleanup(); }
});

test("video writer retains manual rows, matches known labels, and rejects stale ownership", { skip: !hasIntegrationDatabase }, async () => {
  const f = await setup();
  try {
    const manual = await f.db.annotation.create({ data: { assetId: f.assetIds[0], datasetId: f.datasetId, createdById: f.ownerId, modality: "VIDEO", type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } });
    const predictions = f.predictions.map((p) => ({ ...p, labelKey: "person" }));
    await handleAiTaskCompleted(f.db, f.jobId, f.task, predictions, "wrong-lock", worker);
    assert.equal(await f.db.videoObjectTrack.count({ where: { videoAsset: { assetId: f.assetIds[0] } } }), 0);
    await handleAiTaskCompleted(f.db, f.jobId, f.task, predictions, lock, worker);
    await handleAiTaskCompleted(f.db, f.jobId, f.task, predictions, lock, worker);
    assert.equal(await f.db.annotation.count({ where: { assetId: f.assetIds[0], labelId: f.labelId } }), 38);
    assert.deepEqual(await f.db.annotation.findUniqueOrThrow({ where: { id: manual.id } }), manual);
  } finally { await f.cleanup(); }
});

test("video completion respects cancellation, review freeze and transaction rollback", { skip: !hasIntegrationDatabase }, async () => {
  for (const mode of ["cancel", "freeze", "rollback"] as const) {
    const f = await setup();
    try {
      if (mode === "cancel") await f.db.job.update({ where: { id: f.jobId }, data: { status: "CANCELING", cancelRequestedAt: new Date() } });
      if (mode === "freeze") await f.db.asset.update({ where: { id: f.assetIds[0] }, data: { status: "NEEDS_REVIEW" } });
      const before = await f.db.asset.findUniqueOrThrow({ where: { id: f.assetIds[0] }, select: { revision: true } });
      const run = () => handleAiTaskCompleted(f.db, f.jobId, mode === "rollback" ? { ...f.task, createdById: "missing-user" } : f.task, f.predictions, lock, worker);
      if (mode === "rollback") await assert.rejects(run()); else await run();
      assert.equal(await f.db.annotation.count({ where: { assetId: f.assetIds[0] } }), 0);
      assert.equal(await f.db.videoObjectTrack.count({ where: { videoAsset: { assetId: f.assetIds[0] } } }), 0);
      assert.deepEqual(await f.db.asset.findUniqueOrThrow({ where: { id: f.assetIds[0] }, select: { revision: true } }), before);
      assert.equal((await f.db.job.findUniqueOrThrow({ where: { id: f.jobId } })).status, mode === "cancel" ? "CANCELING" : mode === "freeze" ? "COMPLETED" : "RUNNING");
    } finally { await f.cleanup(); }
  }
});
