import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { hasIntegrationDatabase } from "./ai-fixtures.js";
import { SECRET, run, setup } from "./ai-batch-fixtures.js";

test("N accepted Assets produce one reservation and exactly one create call with all files in accepted order", { skip: !hasIntegrationDatabase }, async () => {
  for (const count of [2, 3]) {
    const f = await setup(count);
    try {
      const provider = f.provider(() => f.created());
      await run(f, provider);
      await run(f, provider); // duplicate delivery must not create a second external task
      assert.equal(f.posts.length, 1, `exactly one create call for ${count} Assets`);
      assert.equal(f.posts[0].files.length, count);
      assert.deepEqual(f.posts[0].files.map((url) => url.split("/").pop()!.split(".")[0]), f.targets.map((t) => t.assetId), "files follow inputIndex order");
      assert.equal(f.posts[0].model_id, f.modelKey);
      const task = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
      assert.ok(task.externalTaskId, "external identity persisted");
      const manifest = (task.summary as { aiozSubmission: { images: Array<{ assetId: string; urlDigest: string; inputIndex: number; sourceIdentityDigest: string }> } }).aiozSubmission.images;
      assert.deepEqual(manifest.map((m) => m.inputIndex), f.targets.map((_, i) => i));
      assert.deepEqual(manifest.map((m) => m.sourceIdentityDigest), f.targets.map((t) => t.sourceIdentityDigest));
      assert.equal(new Set(manifest.map((m) => m.urlDigest)).size, count);
      assert.equal((await f.everything()).includes(SECRET), false, "no signed-URL material is persisted anywhere");
    } finally { await f.cleanup(); }
  }
});

test("dispatch rejects the whole operation, never a smaller batch, when an accepted Asset is unavailable or changed", { skip: !hasIntegrationDatabase }, async () => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof setup>>) => Promise<unknown>, string, string]> = [
    ["archived Asset", (f) => f.db.asset.update({ where: { id: f.targets[1].assetId }, data: { archivedAt: new Date() } }), "AIOZ_ASSET_UNAVAILABLE", "ASSET_UNAVAILABLE"],
    ["changed source", (f) => f.db.asset.update({ where: { id: f.targets[2].assetId }, data: { sourceFingerprint: "changed-after-acceptance" } }), "AIOZ_SOURCE_CHANGED", "SOURCE_CHANGED"],
    ["removed storage", (f) => f.db.asset.update({ where: { id: f.targets[0].assetId }, data: { storageProvider: null, storageBucket: null, storageKey: null } }), "AIOZ_ASSET_BINARY_UNAVAILABLE", "ASSET_UNAVAILABLE"],
  ];
  for (const [label, mutate, errorCode, reason] of cases) {
    const f = await setup(3);
    try {
      await mutate(f);
      await run(f, f.provider(() => f.created()));
      assert.equal(f.posts.length, 0, `${label}: nothing is submitted`);
      const task = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
      const job = await f.db.job.findUniqueOrThrow({ where: { id: f.jobId } });
      assert.equal(task.status, "FAILED", label);
      assert.equal(task.errorCode, errorCode, label);
      assert.equal(job.status, "FAILED", label);
      const outcomes = (task.output as { perAsset: Array<{ assetId: string; outcome: string; reason: string }> }).perAsset;
      assert.equal(outcomes.length, 3, `${label}: every accepted target is accounted for`);
      assert.ok(outcomes.every((o) => o.outcome === "FAILED" && o.reason === reason), label);
      assert.deepEqual([job.totalItems, job.processedItems, job.failedItems, job.successItems], [3, 3, 3, 0], label);
    } finally { await f.cleanup(); }
  }
});

test("a Job whose AiTask projection disagrees, whose input is invalid, or whose requester lost access is not dispatched", { skip: !hasIntegrationDatabase }, async () => {
  const mismatch = await setup(2);
  try {
    await mismatch.db.aiTask.update({ where: { id: mismatch.aiTaskId }, data: { input: { assetIds: [mismatch.targets[0].assetId], confidence_threshold: 0.5, iou_threshold: 0.5 } } });
    await run(mismatch, mismatch.provider(() => mismatch.created()));
    assert.equal(mismatch.posts.length, 0);
    assert.equal((await mismatch.db.aiTask.findUniqueOrThrow({ where: { id: mismatch.aiTaskId } })).errorCode, "AI_INPUT_MISMATCH");
  } finally { await mismatch.cleanup(); }

  const invalid = await setup(2);
  try {
    await invalid.db.job.update({ where: { id: invalid.jobId }, data: { input: { schemaVersion: 1, garbage: true } } });
    await run(invalid, invalid.provider(() => invalid.created()));
    assert.equal(invalid.posts.length, 0);
    assert.equal((await invalid.db.aiTask.findUniqueOrThrow({ where: { id: invalid.aiTaskId } })).errorCode, "AI_INPUT_INVALID");
  } finally { await invalid.cleanup(); }

  const lost = await setup(2, { requesterIsOwner: false });
  try {
    await run(lost, lost.provider(() => lost.created()));
    assert.equal(lost.posts.length, 0);
    assert.equal((await lost.db.aiTask.findUniqueOrThrow({ where: { id: lost.aiTaskId } })).errorCode, "REQUESTER_ACCESS_LOST");
  } finally { await lost.cleanup(); }
});

test("DI-1: after any create-call failure exactly one POST was made and a redelivery never repeats it; unknown outcomes are ambiguous", { skip: !hasIntegrationDatabase }, async () => {
  const cases: Array<[string, () => Response | Promise<Response>, string]> = [
    ["HTTP 500", () => new Response("boom", { status: 500 }), "AI_SUBMISSION_AMBIGUOUS"],
    ["network failure", () => { throw new Error("socket hang up"); }, "AI_SUBMISSION_AMBIGUOUS"],
    ["unparseable body", () => new Response("not json", { status: 200 }), "AI_SUBMISSION_AMBIGUOUS"],
    ["HTTP 422 (definite refusal)", () => new Response(JSON.stringify({ detail: `Failed https://files.test/x.jpg?X-Amz-Signature=${SECRET}` }), { status: 422 }), "AI_PROVIDER_REJECTED"],
  ];
  for (const [label, respond, reason] of cases) {
    const f = await setup(3);
    try {
      const provider = f.provider(respond);
      await run(f, provider);
      await run(f, provider); // redelivery of the same Job
      assert.equal(f.posts.length, 1, `${label}: never a second create call`);
      const task = await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } });
      assert.equal(task.status, "FAILED", label);
      const outcomes = (task.output as { perAsset: Array<{ reason: string }> }).perAsset;
      assert.ok(outcomes.every((o) => o.reason === reason), `${label}: ${outcomes[0]?.reason}`);
      const dump = await f.everything();
      assert.equal(dump.includes(SECRET) || dump.includes("X-Amz"), false, `${label}: provider error text or signed URL never persisted`);
      assert.equal(dump.includes("files.test"), false, `${label}: no URL persisted`);
    } finally { await f.cleanup(); }
  }
});
