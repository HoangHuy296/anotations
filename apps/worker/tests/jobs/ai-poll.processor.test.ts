import assert from "node:assert/strict";
import test from "node:test";

import type { AiProviderAdapter, AiProviderStatusResult } from "@annotationplatform/domain/ai-provider";

import { processAiPoll } from "../../src/jobs/ai-poll.processor.js";
import { createAiPollFixture, hasIntegrationDatabase } from "./ai-fixtures.js";

function fakeAdapter(statusSequence: AiProviderStatusResult[]): AiProviderAdapter {
  let calls = 0;
  return {
    submitTask: async () => ({ externalTaskId: "unused" }),
    getTaskStatus: async () => {
      const result = statusSequence[Math.min(calls, statusSequence.length - 1)];
      calls += 1;
      return result;
    },
    normalizePredictions: (raw) => raw as ReturnType<AiProviderAdapter["normalizePredictions"]>,
  };
}

test("PENDING result reschedules the AiTask without touching Job status", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createAiPollFixture();
  try {
    const registry = { "aioz-company": fakeAdapter([{ status: "PENDING" }]) };
    await processAiPoll(fixture.db, fixture.jobId, "worker-a", registry);

    const aiTask = await fixture.db.aiTask.findUniqueOrThrow({ where: { id: fixture.aiTaskId }, select: { status: true, pollAttempts: true, nextPollAt: true } });
    assert.equal(aiTask.pollAttempts, 1);
    assert.ok(aiTask.nextPollAt && aiTask.nextPollAt.getTime() > Date.now());
    const job = await fixture.db.job.findUniqueOrThrow({ where: { id: fixture.jobId }, select: { status: true } });
    assert.equal(job.status, "RUNNING");
  } finally { await fixture.cleanup(); }
});

test("COMPLETED result creates annotations and finalizes AiTask/Job exactly once under two concurrent poll invocations", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createAiPollFixture();
  try {
    const registry = {
      "aioz-company": fakeAdapter([
        { status: "COMPLETED", rawPredictions: [{ assetId: fixture.assetIds[0], labelKey: "person", confidence: 0.8, boundingBoxes: {} }] },
      ]),
    };

    await Promise.all([
      processAiPoll(fixture.db, fixture.jobId, "worker-a", registry),
      processAiPoll(fixture.db, fixture.jobId, "worker-b", registry),
    ]);

    const annotations = await fixture.db.annotation.findMany({ where: { datasetId: fixture.datasetId, source: "AI" }, select: { id: true } });
    assert.equal(annotations.length, 1, "concurrent poll ticks must never create duplicate annotations");

    const aiTask = await fixture.db.aiTask.findUniqueOrThrow({ where: { id: fixture.aiTaskId }, select: { status: true } });
    assert.equal(aiTask.status, "SUCCEEDED");
    const job = await fixture.db.job.findUniqueOrThrow({ where: { id: fixture.jobId }, select: { status: true, stage: true } });
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.stage, "FINISHED");
  } finally { await fixture.cleanup(); }
});

test("a task that has exceeded its poll budget fails with AI_TASK_TIMEOUT without calling the provider", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createAiPollFixture();
  try {
    await fixture.db.aiTask.update({ where: { id: fixture.aiTaskId }, data: { pollAttempts: 9_999 } });
    let providerCalled = false;
    const registry = {
      "aioz-company": {
        ...fakeAdapter([{ status: "PENDING" }]),
        getTaskStatus: async () => {
          providerCalled = true;
          return { status: "PENDING" } as AiProviderStatusResult;
        },
      },
    };

    await processAiPoll(fixture.db, fixture.jobId, "worker-a", registry);

    assert.equal(providerCalled, false, "a task past its poll budget must never contact the provider");
    const aiTask = await fixture.db.aiTask.findUniqueOrThrow({ where: { id: fixture.aiTaskId }, select: { status: true, errorCode: true } });
    assert.equal(aiTask.status, "FAILED");
    assert.equal(aiTask.errorCode, "AI_TASK_TIMEOUT");
    const job = await fixture.db.job.findUniqueOrThrow({ where: { id: fixture.jobId }, select: { status: true, errorCode: true } });
    assert.equal(job.status, "FAILED");
    assert.equal(job.errorCode, "AI_TASK_TIMEOUT");
  } finally { await fixture.cleanup(); }
});

test("a task is not polled again once terminal — a later duplicate scanner tick is a safe no-op", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createAiPollFixture();
  try {
    const registry = {
      "aioz-company": fakeAdapter([
        { status: "COMPLETED", rawPredictions: [{ assetId: fixture.assetIds[0], labelKey: "person", confidence: 0.8, boundingBoxes: {} }] },
      ]),
    };
    await processAiPoll(fixture.db, fixture.jobId, "worker-a", registry);
    // A duplicate tick after the Job is already COMPLETED must not error and must not create a second annotation.
    await processAiPoll(fixture.db, fixture.jobId, "worker-a", registry);

    const annotations = await fixture.db.annotation.count({ where: { datasetId: fixture.datasetId, source: "AI" } });
    assert.equal(annotations, 1);
  } finally { await fixture.cleanup(); }
});
