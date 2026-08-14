import assert from "node:assert/strict";
import test from "node:test";

import { handleAiTaskCompleted } from "../../src/jobs/ai-prediction-writer.js";
import { createAiPollFixture, hasIntegrationDatabase } from "./ai-fixtures.js";

test("valid prediction becomes a DRAFT/AI annotation; out-of-scope asset and unresolvable label are skipped; manual annotations are untouched", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createAiPollFixture({ assetCount: 1 });
  try {
    const manual = await fixture.db.annotation.create({
      data: {
        datasetId: fixture.datasetId,
        assetId: fixture.assetIds[0],
        labelId: fixture.labelId,
        createdById: fixture.ownerId,
        modality: "IMAGE",
        type: "BOUNDING_BOX",
        source: "MANUAL",
        status: "DRAFT",
        geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      },
      select: { id: true, updatedAt: true, geometry: true },
    });

    const aiTask = await fixture.db.aiTask.findUniqueOrThrow({
      where: { id: fixture.aiTaskId },
      select: { id: true, datasetId: true, createdById: true, modality: true, type: true, modelKeySnapshot: true, input: true },
    });

    await handleAiTaskCompleted(
      fixture.db,
      fixture.jobId,
      aiTask,
      [
        { assetId: fixture.assetIds[0], labelKey: "person", confidence: 0.9, boundingBoxes: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } },
        { assetId: "not-a-submitted-asset", labelKey: "person", confidence: 0.9, boundingBoxes: {} },
        { assetId: fixture.assetIds[0], labelKey: "unknown-label", confidence: 0.9, boundingBoxes: {} },
      ],
      "test-lock-token",
      "test-worker",
    );

    const aiAnnotations = await fixture.db.annotation.findMany({ where: { datasetId: fixture.datasetId, source: "AI" }, select: { assetId: true, status: true, properties: true } });
    assert.equal(aiAnnotations.length, 1, "exactly one valid prediction must become one annotation");
    assert.equal(aiAnnotations[0].assetId, fixture.assetIds[0]);
    assert.equal(aiAnnotations[0].status, "DRAFT");
    assert.equal((aiAnnotations[0].properties as { aiTaskId: string }).aiTaskId, fixture.aiTaskId);

    const stillManual = await fixture.db.annotation.findUniqueOrThrow({ where: { id: manual.id }, select: { source: true, updatedAt: true, geometry: true } });
    assert.equal(stillManual.source, "MANUAL");
    assert.deepEqual(stillManual.geometry, manual.geometry);
    assert.equal(stillManual.updatedAt.getTime(), manual.updatedAt.getTime(), "the manual annotation must never be updated");

    const storedAiTask = await fixture.db.aiTask.findUniqueOrThrow({ where: { id: fixture.aiTaskId }, select: { status: true } });
    assert.equal(storedAiTask.status, "SUCCEEDED");
    const storedJob = await fixture.db.job.findUniqueOrThrow({ where: { id: fixture.jobId }, select: { status: true, stage: true } });
    assert.equal(storedJob.status, "COMPLETED");
    assert.equal(storedJob.stage, "FINISHED");
  } finally { await fixture.cleanup(); }
});
