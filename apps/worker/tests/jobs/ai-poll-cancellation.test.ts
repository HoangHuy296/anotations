import assert from "node:assert/strict";
import test from "node:test";

import type { AiProviderAdapter } from "@fieldframe/domain/ai-provider";

import { processAiPoll } from "../../src/jobs/ai-poll.processor.js";
import { createAiPollFixture, hasIntegrationDatabase } from "./ai-fixtures.js";

function neverCompletingAdapter(onCall: () => void): AiProviderAdapter {
  return {
    submitTask: async () => ({ externalTaskId: "unused" }),
    getTaskStatus: async () => {
      onCall();
      return { status: "PENDING" };
    },
    normalizePredictions: (raw) => raw as ReturnType<AiProviderAdapter["normalizePredictions"]>,
  };
}

test("a poll step invoked after cancelRequestedAt is set finalizes CANCELED without calling the provider", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createAiPollFixture();
  try {
    let providerCalls = 0;
    const registry = { "aioz-company": neverCompletingAdapter(() => { providerCalls += 1; }) };

    await fixture.db.job.update({ where: { id: fixture.jobId }, data: { cancelRequestedAt: new Date() } });

    await processAiPoll(fixture.db, fixture.jobId, "worker-a", registry);

    assert.equal(providerCalls, 0, "a canceled task must never reach the provider");
    const aiTask = await fixture.db.aiTask.findUniqueOrThrow({ where: { id: fixture.aiTaskId }, select: { status: true } });
    assert.equal(aiTask.status, "CANCELED");
  } finally { await fixture.cleanup(); }
});

test("a second cancellation poll step on an already-canceled task is a no-op", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createAiPollFixture();
  try {
    let providerCalls = 0;
    const registry = { "aioz-company": neverCompletingAdapter(() => { providerCalls += 1; }) };
    await fixture.db.job.update({ where: { id: fixture.jobId }, data: { cancelRequestedAt: new Date() } });

    await processAiPoll(fixture.db, fixture.jobId, "worker-a", registry);
    await processAiPoll(fixture.db, fixture.jobId, "worker-a", registry);

    assert.equal(providerCalls, 0);
    const aiTask = await fixture.db.aiTask.findUniqueOrThrow({ where: { id: fixture.aiTaskId }, select: { status: true } });
    assert.equal(aiTask.status, "CANCELED", "the already-terminal outcome must be unchanged, not overwritten");
  } finally { await fixture.cleanup(); }
});
