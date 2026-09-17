import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db } from "@/lib/db";
import { aiPredictionColor, projectPredictionResults, readAiPredictionResults, saveAiPrediction, savePredictionSchema } from "@/lib/ai/ai-prediction-results";
import type { RequestActor } from "@/lib/auth";

const geometry = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const p = { assetId: "asset", labelKey: "car", confidence: 0.9, boundingBoxes: geometry };

test("preview projection keeps safe normalized fields, preserves indices and enforces task asset scope", () => {
  const output = { predictions: [{ bad: true }, { ...p, privateUrl: "http://private.invalid" }, { ...p, assetId: "other" }, { ...p, boundingBoxes: { ...geometry, width: 10 } }] };
  assert.deepEqual(projectPredictionResults(output, { assetIds: ["asset"] }, "asset"), [{ index: 1, assetId: "asset", labelKey: "car", confidence: 0.9, color: "#f59e0b", geometry, saved: false }]);
  assert.deepEqual(projectPredictionResults(output, { assetIds: ["other"] }, "asset"), []);
  assert.equal(savePredictionSchema.safeParse({ assetId: "asset", index: 0, labelId: "label" }).success, true);
  assert.equal(savePredictionSchema.safeParse({ assetId: "asset", index: 0 }).success, false);
  assert.notEqual(aiPredictionColor("task", 0, "car", ["#f59e0b"]), "#f59e0b");
  assert.equal(aiPredictionColor("task", 0, "motorcycle", []), aiPredictionColor("task", 99, "MOTORCYCLE", []));
  const fullPalette = ["#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#84cc16", "#f97316", "#14b8a6", "#a855f7"];
  assert.equal(fullPalette.includes(aiPredictionColor("task", 0, "motorcycle", fullPalette)), false);
});

test("saved previews preserve AI provenance, authorize scope, serialize replay, and respect review locks", { skip: !process.env.DATABASE_URL }, async () => {
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { email: `${suffix}@test.invalid`, role: "MANAGER" } });
  const actor: RequestActor = { id: owner.id, email: owner.email, role: "MANAGER", name: "Test owner" };
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: "Prediction review test" } });
  const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: "IMAGE", filename: "test.jpg", mimeType: "image/jpeg", sourceFingerprint: suffix } });
  const label = await db.label.create({ data: { datasetId: dataset.id, name: "vehicle", normalizedName: "vehicle", color: "#00ff00" } });
  const model = await db.aiModel.create({ data: { key: suffix, displayName: "Test", provider: "aioz-company", modality: "IMAGE", taskType: "DETECT_OBJECTS" } });
  const job = await db.job.create({ data: { datasetId: dataset.id, createdById: owner.id, type: "AI_PREANNOTATE_ASSET", status: "COMPLETED" } });
  const task = await db.aiTask.create({ data: {
    datasetId: dataset.id, createdById: owner.id, jobId: job.id, modelId: model.id, modelKeySnapshot: model.key, modelNameSnapshot: "Test", modality: "IMAGE", type: "DETECT_OBJECTS", status: "SUCCEEDED",
    input: { assetIds: [asset.id] }, output: { predictions: [{ ...p, assetId: asset.id }, { ...p, assetId: asset.id, boundingBoxes: { ...geometry, x: 0.2 } }] },
  } });
  try {
    const unknownActor = { ...actor, id: "unrelated-user" };
    assert.equal(await readAiPredictionResults(unknownActor, asset.id), null);
    await assert.rejects(saveAiPrediction(unknownActor, task.id, { assetId: asset.id, index: 0, labelId: label.id }), /NOT_FOUND/);
    await assert.rejects(saveAiPrediction(actor, task.id, { assetId: "other", index: 0, labelId: label.id }), /NOT_FOUND/);
    const before = await readAiPredictionResults(actor, asset.id);
    assert.equal(await db.label.count({ where: { datasetId: dataset.id } }), 1);
    assert.equal(before?.predictions.length, 2);
    assert.equal(before?.predictions[0].saved, false);
    const predictionLabel = await db.label.create({ data: { datasetId: dataset.id, name: "car", normalizedName: "car", color: "#f59e0b" } });
    const request = { assetId: asset.id, index: 0, labelId: predictionLabel.id };
    await assert.rejects(saveAiPrediction(actor, task.id, { ...request, labelId: label.id }), /NOT_FOUND/);
    const [a, b] = await Promise.all([saveAiPrediction(actor, task.id, request), saveAiPrediction(actor, task.id, request)]);
    assert.equal(a.id, b.id);
    assert.equal(await db.annotation.count({ where: { assetId: asset.id } }), 1);
    assert.equal(await db.label.count({ where: { datasetId: dataset.id } }), 2);
    const saved = await db.annotation.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(saved.source, "AI");
    assert.equal(saved.status, "DRAFT");
    assert.equal(saved.labelId, predictionLabel.id);
    assert.deepEqual(saved.geometry, geometry);
    assert.equal((saved.properties as { predictedClass: string }).predictedClass, "car");
    assert.equal((saved.properties as { aiDisplayLabel: string }).aiDisplayLabel, "#1 car");
    assert.notEqual((saved.properties as { aiColor: string }).aiColor.toLowerCase(), label.color.toLowerCase());
    assert.equal((await readAiPredictionResults(actor, asset.id))?.predictions[0].saved, true);
    // A later user edit must not be overwritten by replaying the initial save.
    await db.annotation.update({ where: { id: a.id }, data: { geometry: { ...geometry, x: 0.4 }, revision: { increment: 1 } } });
    const replay = await saveAiPrediction(actor, task.id, request);
    assert.equal((replay.geometry as typeof geometry).x, 0.4);
    await db.asset.update({ where: { id: asset.id }, data: { status: "NEEDS_REVIEW" } });
    await assert.rejects(saveAiPrediction(actor, task.id, { ...request, index: 1 }), /WORKFLOW_LOCKED/);
    assert.equal(await db.annotation.count({ where: { assetId: asset.id } }), 1);
    // Completion must read the requested task even when a newer run exists.
    const newerJob = await db.job.create({ data: { datasetId: dataset.id, createdById: owner.id, type: "AI_PREANNOTATE_ASSET", status: "COMPLETED" } });
    const newerTask = await db.aiTask.create({ data: {
      datasetId: dataset.id, createdById: owner.id, jobId: newerJob.id, modelId: model.id, modelKeySnapshot: model.key, modelNameSnapshot: "Newer run", modality: "IMAGE", type: "DETECT_OBJECTS", status: "SUCCEEDED", createdAt: new Date(task.createdAt.getTime() + 1000),
      input: { assetIds: [asset.id] }, output: { predictions: [{ ...p, labelKey: "boat", assetId: asset.id }] },
    } });
    assert.equal((await readAiPredictionResults(actor, asset.id))?.taskId, newerTask.id);
    const exact = await readAiPredictionResults(actor, asset.id, task.id);
    assert.equal(exact?.taskId, task.id);
    assert.equal(exact?.predictions.length, 2);
    assert.equal(exact?.predictions[0].labelKey, "car");
    assert.equal(await readAiPredictionResults(actor, asset.id, "missing-task"), null);
    assert.equal(await readAiPredictionResults(unknownActor, asset.id, task.id), null);
    assert.equal(await readAiPredictionResults(actor, "other-asset", task.id), null);
  } finally {
    await db.annotation.deleteMany({ where: { datasetId: dataset.id } });
    await db.aiTask.deleteMany({ where: { datasetId: dataset.id } });
    await db.job.deleteMany({ where: { datasetId: dataset.id } });
    await db.asset.delete({ where: { id: asset.id } });
    await db.label.deleteMany({ where: { datasetId: dataset.id } });
    await db.dataset.delete({ where: { id: dataset.id } });
    await db.aiModel.delete({ where: { id: model.id } });
    await db.user.delete({ where: { id: owner.id } });
    await db.$disconnect();
  }
});
