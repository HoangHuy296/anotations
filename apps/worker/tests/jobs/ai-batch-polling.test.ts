import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { hasIntegrationDatabase } from "./ai-fixtures.js";
import { SECRET, run, setup, worker } from "./ai-batch-fixtures.js";
import { processAiPoll } from "../../src/jobs/ai-poll.processor.js";
import { MAX_POLL_ATTEMPTS } from "../../src/jobs/ai-poll-constants.js";

const remoteId = randomUUID();
const status = (value: string, extra: Record<string, unknown> = {}) => Response.json({ success: true, data: { task_id: remoteId, status: value, output: null, error: null, ...extra } });

/** Submits a 3-Asset batch (one POST), then returns a poll helper answering every GET with `respond()`. */
async function submitted(respond: () => Response | Promise<Response>) {
  const f = await setup(3);
  const submit = f.provider(() => Response.json({ success: true, data: { task_id: remoteId, status: "create", created_at: new Date().toISOString() } }));
  await run(f, submit);
  const poll = () => processAiPoll(f.db, f.jobId, worker, { "aioz-company": f.provider(respond) });
  return { ...f, poll };
}
const state = async (f: Awaited<ReturnType<typeof submitted>>) => ({
  task: await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } }),
  job: await f.db.job.findUniqueOrThrow({ where: { id: f.jobId } }),
});

test("DI-3: failed_system is non-terminal and durable, never success, never a resubmission, and does not read its error text", { skip: !hasIntegrationDatabase }, async () => {
  let current = "failed_system";
  const f = await submitted(() => status(current, current === "failed_system" ? { error: `Failed to access https://files.test/x.jpg?X-Amz-Signature=${SECRET}` } : {}));
  try {
    await f.poll();
    let { task, job } = await state(f);
    assert.equal(task.status, "RUNNING", "not terminal");
    assert.equal(job.status, "RUNNING");
    assert.equal(task.pollAttempts, 1);
    assert.equal((task.summary as { providerStatus?: string }).providerStatus, "PROVIDER_DEGRADED");
    assert.equal(f.posts.length, 1, "polling never re-sends the create call");
    assert.equal(await f.db.annotation.count({ where: { datasetId: f.datasetId } }), 0);
    // It may recover: nothing assumed either way.
    current = "inprocess";
    await f.poll();
    ({ task } = await state(f));
    assert.equal((task.summary as { providerStatus?: string }).providerStatus, "PROVIDER_ACTIVE");
    assert.equal(task.status, "RUNNING");
    const dump = JSON.stringify(await state(f), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    assert.equal(dump.includes(SECRET) || dump.includes("files.test"), false);
  } finally { await f.cleanup(); }
});

test("DI-3: a provider still degraded when the poll budget ends fails as AI_PROVIDER_FAILED_SYSTEM with every target accounted for", { skip: !hasIntegrationDatabase }, async () => {
  const f = await submitted(() => status("failed_system"));
  try {
    await f.poll();
    await f.db.aiTask.update({ where: { id: f.aiTaskId }, data: { pollAttempts: MAX_POLL_ATTEMPTS } });
    await f.poll();
    const { task, job } = await state(f);
    assert.equal(task.status, "FAILED");
    assert.equal(task.errorCode, "AI_PROVIDER_FAILED_SYSTEM");
    assert.equal(job.status, "FAILED");
    const outcomes = (task.output as { perAsset: Array<{ outcome: string; reason: string }> }).perAsset;
    assert.equal(outcomes.length, 3);
    assert.ok(outcomes.every((o) => o.outcome === "FAILED" && o.reason === "AI_PROVIDER_FAILED_SYSTEM"));
    assert.deepEqual([job.totalItems, job.processedItems, job.failedItems], [3, 3, 3]);
    assert.equal(f.posts.length, 1);
  } finally { await f.cleanup(); }
});

test("DI-3: an unrecognized provider status fails closed with no writes", { skip: !hasIntegrationDatabase }, async () => {
  const f = await submitted(() => status("brand_new_status"));
  try {
    await f.poll();
    const { task } = await state(f);
    assert.equal(task.status, "FAILED");
    assert.equal(task.errorCode, "AIOZ_STATUS_UNKNOWN");
    assert.ok((task.output as { perAsset: Array<{ reason: string }> }).perAsset.every((o) => o.reason === "AI_PROVIDER_STATUS_UNKNOWN"));
    assert.equal(await f.db.annotation.count({ where: { datasetId: f.datasetId } }), 0);
  } finally { await f.cleanup(); }
});

test("DI-2/DI-4: a terminal provider failure fails the whole batch with one sanitized reason and never persists provider text", { skip: !hasIntegrationDatabase }, async () => {
  const f = await submitted(() => status("failed", { error: `Failed to access URL https://files.test/x.jpg?X-Amz-Signature=${SECRET}: 404 Client Error` }));
  try {
    await f.poll();
    const { task, job } = await state(f);
    assert.equal(task.status, "FAILED");
    assert.equal(job.status, "FAILED");
    const outcomes = (task.output as { perAsset: Array<{ outcome: string; reason: string }> }).perAsset;
    assert.equal(outcomes.length, 3, "every accepted target is accounted for");
    assert.ok(outcomes.every((o) => o.outcome === "FAILED" && o.reason === "AI_PROVIDER_FAILED"), "one whole-batch reason, no per-Asset attribution guessed from error text");
    const dump = JSON.stringify(await state(f), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    assert.equal(dump.includes(SECRET) || dump.includes("X-Amz") || dump.includes("files.test") || dump.includes("404"), false, "provider error text is never stored");
  } finally { await f.cleanup(); }
});

test("a provider outage while polling is a durable failure, never an empty success", { skip: !hasIntegrationDatabase }, async () => {
  const f = await submitted(() => new Response("down", { status: 503 }));
  try {
    await f.poll();
    const { task } = await state(f);
    assert.equal(task.status, "FAILED");
    assert.equal(task.errorCode, "AIOZ_HTTP_5XX");
    assert.ok((task.output as { perAsset: Array<{ reason: string }> }).perAsset.every((o) => o.reason === "AI_PROVIDER_UNAVAILABLE"));
    assert.equal(await f.db.annotation.count({ where: { datasetId: f.datasetId } }), 0);
  } finally { await f.cleanup(); }
});

test("cancellation of a versioned operation finalizes every accepted target CANCELED, calls the provider no further, and keeps the terminal state", { skip: !hasIntegrationDatabase }, async () => {
  let gets = 0;
  const f = await submitted(() => { gets += 1; return status("inprocess"); });
  try {
    await f.db.job.update({ where: { id: f.jobId }, data: { status: "CANCELING", cancelRequestedAt: new Date() } });
    await f.poll();
    const { task, job } = await state(f);
    assert.equal(gets, 0, "no provider call after cancellation was requested");
    assert.equal(f.posts.length, 1);
    assert.equal(task.status, "CANCELED");
    assert.equal(job.status, "CANCELED");
    const outcomes = (task.output as { perAsset: Array<{ outcome: string; reason: string }> }).perAsset;
    assert.equal(outcomes.length, 3);
    assert.ok(outcomes.every((o) => o.outcome === "CANCELED" && o.reason === "OPERATION_CANCELED"));
    assert.deepEqual([job.totalItems, job.processedItems, (job.summary as { canceledItems: number }).canceledItems], [3, 3, 3]);
    await f.poll(); // idempotent: a second tick changes nothing
    assert.equal((await state(f)).job.status, "CANCELED");
  } finally { await f.cleanup(); }
});
