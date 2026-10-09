import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify the disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { Modality } from "@internal/db";
import { MEDIA_VERIFICATION_MAX_NON_TERMINAL as LIMIT } from "@annotationplatform/domain/media-verification";

import { db } from "@/lib/db";
import { actorWithDataset, admit, cleanup, datasets, enabled, staged, terminalize, users } from "./support";
import { createWorkspaceDataset } from "../workspace/helpers";

/**
 * G-CAP (contract section 8), real PostgreSQL. >= 120 DISTINCT concurrent requests per scope are fired through the one Serializable admission transaction while a sampler
 * reads the COMMITTED non-terminal counts continuously. The invariant under test: committed non-terminal rows NEVER exceed 50 for either scope, at any sampled instant or at
 * the end; every request ends admitted, 429 (limit) or 503 (serialization retries exhausted); a refusal creates nothing.
 */
process.env.MEDIA_VERIFICATION_ENABLED = "1";
after(cleanup);
const skip = !enabled;
const N = 120;
const NON_TERMINAL = ["PENDING", "SEALED", "VERIFIED"] as const;

type Outcome = "ADMITTED" | "REPLAYED" | "LIMIT_ACTOR" | "LIMIT_DATASET" | "BUSY";
const outcomeOf = (result: Awaited<ReturnType<typeof admit>>): Outcome => result.ok ? (result.replayed ? "REPLAYED" : "ADMITTED") : result.status === 503 ? "BUSY" : (result as { scope: string }).scope === "ACTOR" ? "LIMIT_ACTOR" : "LIMIT_DATASET";

async function sampleWhile<T>(work: Promise<T>, where: Array<{ datasetId?: string; requestedById?: string }>) {
  let done = false, samples = 0, max = 0;
  const sampler = (async () => {
    while (!done) {
      for (const scope of where) { const count = await db.mediaVerification.count({ where: { ...scope, status: { in: [...NON_TERMINAL] } } }); samples += 1; max = Math.max(max, count); }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  })();
  try { return { value: await work, samples: () => samples, max: () => max }; } finally { done = true; await sampler; }
}

async function invariants(where: Array<{ datasetId?: string; requestedById?: string }>) {
  for (const scope of where) assert.ok(await db.mediaVerification.count({ where: { ...scope, status: { in: [...NON_TERMINAL] } } }) <= LIMIT, `final committed non-terminal count exceeds ${LIMIT} for ${JSON.stringify(scope)}`);
  // (3) no orphan PENDING without its Job, and no live verification Job without its verification
  const dsIds = where.map((scope) => scope.datasetId).filter((id): id is string => Boolean(id));
  const live = await db.mediaVerification.findMany({ where: { ...(dsIds.length ? { datasetId: { in: dsIds } } : {}), status: { in: [...NON_TERMINAL] } }, select: { id: true, currentJobId: true } });
  for (const row of live) assert.ok(row.currentJobId, `verification ${row.id} has no Job`);
  const jobs = await db.job.findMany({ where: { id: { in: live.map((row) => row.currentJobId!) }, type: "VERIFY_UPLOADED_MEDIA" }, select: { id: true } });
  assert.equal(jobs.length, live.length, "every live verification references an existing VERIFY_UPLOADED_MEDIA Job");
  const verificationJobs = await db.job.count({ where: { type: "VERIFY_UPLOADED_MEDIA", ...(dsIds.length ? { datasetId: { in: dsIds } } : {}), status: "QUEUED" } });
  assert.equal(verificationJobs, await db.mediaVerification.count({ where: { ...(dsIds.length ? { datasetId: { in: dsIds } } : {}), currentJob: { status: "QUEUED" } } }), "no Job exists without its verification (refused requests created none)");
}

const tally = (outcomes: Outcome[]) => outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o]: (acc[o] ?? 0) + 1 }), {});

test(`G-CAP actor+Dataset scope: ${N} distinct concurrent requests from ONE actor into ONE Dataset never over-admit; the surplus is refused (429) or 503; a refusal creates no row or Job; sequential settle reaches exactly ${LIMIT}`, { skip, timeout: 300_000 }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const where = [{ datasetId }, { requestedById: actor.id }];
  const run = await sampleWhile(Promise.all(Array.from({ length: N }, () => admit(actor.id, datasetId, { staged: staged() }))), where);
  const outcomes = run.value.map(outcomeOf);
  const t = tally(outcomes);
  console.log(`# G-CAP scope=actor+dataset tally=${JSON.stringify(t)} samples=${run.samples()} maxObserved=${run.max()}`);
  assert.ok(run.samples() > 5, "the sampler observed the run");
  assert.ok(run.max() <= LIMIT, `observed ${run.max()} > ${LIMIT} at a sampled instant`);
  assert.ok((t.ADMITTED ?? 0) <= LIMIT && (t.ADMITTED ?? 0) + (t.LIMIT_ACTOR ?? 0) + (t.LIMIT_DATASET ?? 0) + (t.BUSY ?? 0) === N, "every request ends admitted, limited or busy");
  const committed = await db.mediaVerification.count({ where: { datasetId, status: { in: [...NON_TERMINAL] } } });
  assert.equal(committed, t.ADMITTED ?? 0, "committed rows equal the admitted answers (nothing admitted without a row, nothing created for a refusal)");
  assert.equal(await db.job.count({ where: { datasetId, type: "VERIFY_UPLOADED_MEDIA" } }), committed, "a refusal creates no Job");
  await invariants(where);
  // settle the BUSY ones sequentially: capacity is reached exactly, and the surplus is a 429
  let guard = 0;
  while ((await db.mediaVerification.count({ where: { datasetId, status: { in: [...NON_TERMINAL] } } })) < LIMIT && guard++ < 200) await admit(actor.id, datasetId, { staged: staged() });
  assert.equal(await db.mediaVerification.count({ where: { datasetId, status: { in: [...NON_TERMINAL] } } }), LIMIT);
  const surplus = await admit(actor.id, datasetId, { staged: staged() });
  assert.ok(!surplus.ok && surplus.status === 429);
  // (6) terminalization releases capacity
  const victim = await db.mediaVerification.findFirstOrThrow({ where: { datasetId, status: "PENDING" }, select: { id: true } });
  await terminalize(victim.id);
  const reopened = await admit(actor.id, datasetId, { staged: staged() });
  assert.ok(reopened.ok && !reopened.replayed);
  assert.equal(await db.mediaVerification.count({ where: { datasetId, status: { in: [...NON_TERMINAL] } } }), LIMIT);
});

test(`G-CAP Dataset scope: ${N} requests from ${N} DISTINCT actors into ONE Dataset never exceed ${LIMIT} committed non-terminal rows (the Dataset limit binds across actors)`, { skip, timeout: 300_000 }, async () => {
  const { datasetId } = await actorWithDataset();
  const actorIds: string[] = [];
  const stamp = randomUUID().slice(0, 8);
  await db.user.createMany({ data: Array.from({ length: N }, (_, i) => ({ email: `cap-d-${stamp}-${i}@test.invalid`, name: `cap-${i}`, role: "MANAGER" as const })) });
  for (const user of await db.user.findMany({ where: { email: { startsWith: `cap-d-${stamp}-` } }, select: { id: true } })) { actorIds.push(user.id); users.push(user.id); }
  const where = [{ datasetId }];
  const run = await sampleWhile(Promise.all(actorIds.map((id) => admit(id, datasetId, { staged: staged() }))), where);
  const t = tally(run.value.map(outcomeOf));
  console.log(`# G-CAP scope=dataset tally=${JSON.stringify(t)} samples=${run.samples()} maxObserved=${run.max()}`);
  assert.ok(run.max() <= LIMIT, `observed ${run.max()} > ${LIMIT}`);
  assert.ok((t.ADMITTED ?? 0) <= LIMIT && (t.ADMITTED ?? 0) + (t.LIMIT_DATASET ?? 0) + (t.LIMIT_ACTOR ?? 0) + (t.BUSY ?? 0) === N);
  assert.equal(await db.mediaVerification.count({ where: { datasetId, status: { in: [...NON_TERMINAL] } } }), t.ADMITTED ?? 0);
  assert.equal(t.LIMIT_ACTOR ?? 0, 0, "no single actor is anywhere near its own limit here");
  await invariants(where);
});

test(`G-CAP actor scope: ${N} requests from ONE actor spread over several Datasets never exceed ${LIMIT} committed non-terminal rows for that actor (the actor limit binds across Datasets)`, { skip, timeout: 300_000 }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const targets = [datasetId];
  for (let i = 0; i < 5; i += 1) { const dataset = await createWorkspaceDataset(actor.id, Modality.VIDEO); datasets.push(dataset.id); targets.push(dataset.id); }
  const where = [{ requestedById: actor.id }, ...targets.map((id) => ({ datasetId: id }))];
  const run = await sampleWhile(Promise.all(Array.from({ length: N }, (_, i) => admit(actor.id, targets[i % targets.length]!, { staged: staged() }))), where);
  const t = tally(run.value.map(outcomeOf));
  console.log(`# G-CAP scope=actor tally=${JSON.stringify(t)} samples=${run.samples()} maxObserved=${run.max()}`);
  assert.ok(run.max() <= LIMIT, `observed ${run.max()} > ${LIMIT}`);
  assert.ok((t.ADMITTED ?? 0) <= LIMIT && (t.ADMITTED ?? 0) + (t.LIMIT_ACTOR ?? 0) + (t.LIMIT_DATASET ?? 0) + (t.BUSY ?? 0) === N);
  assert.equal(await db.mediaVerification.count({ where: { requestedById: actor.id, status: { in: [...NON_TERMINAL] } } }), t.ADMITTED ?? 0);
  for (const id of targets) assert.ok(await db.mediaVerification.count({ where: { datasetId: id, status: { in: [...NON_TERMINAL] } } }) <= LIMIT);
  await invariants(targets.map((id) => ({ datasetId: id })));
});

/**
 * G-CAP boundary crossing (contract section 8: "enough distinct concurrent requests to CROSS the limit"). The three bursts above can settle below 50 because the Serializable
 * retries are bounded, so they alone do not prove the limit holds while concurrent requests straddle it. Each scope here is first filled to 40 committed rows, a burst of
 * N distinct requests then has only 10 free slots, and finally a second burst hits a SATURATED scope. Committed non-terminal rows never exceed 50 at any sampled instant;
 * the saturated burst admits nothing and leaves the count at exactly 50.
 */
async function boundaryRun(label: string, scope: Array<{ datasetId?: string; requestedById?: string }>, countWhere: { datasetId?: string; requestedById?: string }, fire: (n: number) => Array<Promise<Awaited<ReturnType<typeof admit>>>>, one: () => Promise<Awaited<ReturnType<typeof admit>>>) {
  const live = () => db.mediaVerification.count({ where: { ...countWhere, status: { in: [...NON_TERMINAL] } } });
  while ((await live()) < 40) assert.ok((await one()).ok, "seeding below the limit is admitted");
  assert.equal(await live(), 40);
  const crossing = await sampleWhile(Promise.all(fire(N)), scope);
  const t = tally(crossing.value.map(outcomeOf));
  const afterCrossing = await live();
  console.log(`# G-CAP boundary ${label} crossing tally=${JSON.stringify(t)} samples=${crossing.samples()} maxObserved=${crossing.max()} committed=${afterCrossing}`);
  assert.ok(crossing.max() <= LIMIT, `observed ${crossing.max()} > ${LIMIT} while the burst straddled the limit`);
  assert.ok(afterCrossing <= LIMIT && afterCrossing === 40 + (t.ADMITTED ?? 0), "committed rows equal the seed plus the admitted answers, and never exceed the limit");
  assert.ok((t.ADMITTED ?? 0) <= LIMIT - 40, "no more than the 10 free slots were admitted");
  let guard = 0;
  while ((await live()) < LIMIT && guard++ < 200) await one();
  assert.equal(await live(), LIMIT, "capacity is reached exactly");
  const saturated = await sampleWhile(Promise.all(fire(N)), scope);
  const s = tally(saturated.value.map(outcomeOf));
  console.log(`# G-CAP boundary ${label} saturated tally=${JSON.stringify(s)} samples=${saturated.samples()} maxObserved=${saturated.max()}`);
  assert.equal(s.ADMITTED ?? 0, 0, "a saturated scope admits nothing, however many concurrent requests arrive");
  assert.equal((s.LIMIT_ACTOR ?? 0) + (s.LIMIT_DATASET ?? 0) + (s.BUSY ?? 0), N, "every request is refused 429 or 503");
  assert.ok((s.LIMIT_ACTOR ?? 0) + (s.LIMIT_DATASET ?? 0) > 0, "at least one request reached the limit check and was refused 429");
  assert.equal(await live(), LIMIT);
  assert.ok(saturated.max() <= LIMIT);
  await invariants(scope);
}

test(`G-CAP boundary actor+Dataset: ${N} concurrent requests from ONE actor into ONE Dataset straddling the limit (40 seeded, 10 free) then saturated`, { skip, timeout: 600_000 }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  await boundaryRun("actor+dataset", [{ datasetId }, { requestedById: actor.id }], { datasetId }, (n) => Array.from({ length: n }, () => admit(actor.id, datasetId, { staged: staged() })), () => admit(actor.id, datasetId, { staged: staged() }));
});

test(`G-CAP boundary Dataset: ${N} concurrent requests from distinct actors into ONE Dataset straddling the limit then saturated`, { skip, timeout: 600_000 }, async () => {
  const { datasetId } = await actorWithDataset();
  const stamp = randomUUID().slice(0, 8);
  await db.user.createMany({ data: Array.from({ length: N + 60 }, (_, i) => ({ email: `cap-b-${stamp}-${i}@test.invalid`, name: `capb-${i}`, role: "MANAGER" as const })) });
  const ids = (await db.user.findMany({ where: { email: { startsWith: `cap-b-${stamp}-` } }, select: { id: true } })).map((u) => u.id);
  users.push(...ids);
  let next = 0;
  const actor = () => ids[next++ % ids.length]!;
  // seeding (60 sequential requests) uses actors 0..59; the bursts reuse actors but each request carries a distinct staged object, so no actor approaches its own limit of 50
  await boundaryRun("dataset", [{ datasetId }], { datasetId }, (n) => Array.from({ length: n }, () => admit(actor(), datasetId, { staged: staged() })), () => admit(actor(), datasetId, { staged: staged() }));
});

test(`G-CAP boundary actor: ${N} concurrent requests from ONE actor across several Datasets straddling the actor limit then saturated`, { skip, timeout: 600_000 }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const targets = [datasetId];
  for (let i = 0; i < 5; i += 1) { const dataset = await createWorkspaceDataset(actor.id, Modality.VIDEO); datasets.push(dataset.id); targets.push(dataset.id); }
  let turn = 0;
  const pick = () => targets[turn++ % targets.length]!;
  await boundaryRun("actor", [{ requestedById: actor.id }, ...targets.map((id) => ({ datasetId: id }))], { requestedById: actor.id }, (n) => Array.from({ length: n }, () => admit(actor.id, pick(), { staged: staged() })), () => admit(actor.id, pick(), { staged: staged() }));
});
