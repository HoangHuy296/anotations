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

test("a poll step reclaims a CANCELING job's lock and finalizes both the AiTask and the Job as CANCELED", { skip: !hasIntegrationDatabase }, async () => {
  // Mirrors lib/jobs/authorization.ts#cancelAuthorizedJob's actual behavior
  // for a RUNNING Job: it moves status to CANCELING (not just
  // cancelRequestedAt) and expects the next poll step to finish the
  // transition. Regression coverage for two bugs found together: (1)
  // job-lock.ts#renewOrReclaimLock used to require bare status = 'RUNNING',
  // which permanently excluded a CANCELING row from ever being reclaimed --
  // this poll step would otherwise back off forever instead of finalizing;
  // (2) finalizeCanceledAiTask used to only update the AiTask, leaving the
  // Job wedged at CANCELING forever even once reached.
  const fixture = await createAiPollFixture();
  try {
    let providerCalls = 0;
    const registry = { "aioz-company": neverCompletingAdapter(() => { providerCalls += 1; }) };

    await fixture.db.job.update({ where: { id: fixture.jobId }, data: { status: "CANCELING", cancelRequestedAt: new Date() } });

    await processAiPoll(fixture.db, fixture.jobId, "worker-a", registry);

    assert.equal(providerCalls, 0, "a canceled task must never reach the provider");
    const aiTask = await fixture.db.aiTask.findUniqueOrThrow({ where: { id: fixture.aiTaskId }, select: { status: true } });
    assert.equal(aiTask.status, "CANCELED");
    const job = await fixture.db.job.findUniqueOrThrow({ where: { id: fixture.jobId }, select: { status: true, finishedAt: true, canceledAt: true } });
    assert.equal(job.status, "CANCELED", "the Job must not be left stuck at CANCELING");
    assert.ok(job.finishedAt);
    assert.ok(job.canceledAt);
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
