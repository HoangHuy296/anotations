import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { db } from "@/lib/db";
import { resolveEmptyDataset } from "@/lib/datasets/modality";
import { applyBackfillManifest, buildBackfillManifest, type BackfillTestPoint } from "@/lib/datasets/modality-backfill";
import { backfillSubject, canonicalJson, sealManifest, type BackfillManifest, type ObjectObservation, type RunResult, type StatObject } from "@/lib/datasets/modality-backfill-evidence";

/**
 * T029/T031 rehearsal on the canonical 25-migration chain (disposable PostgreSQL only). The datasets were seeded unresolved on the 23-migration
 * baseline by `backfill-baseline.test.ts`. Storage is an in-memory metadata map behind the injected `statObject`; no network, no object bytes.
 */
const BUCKET = "bf-bucket";
const overrides = new Map<string, ObjectObservation | null | "THROW">();
const statCalls: string[] = [];
const stat: StatObject = async (bucket, key) => {
  statCalls.push(`${bucket}/${key}`);
  const forced = overrides.get(`${bucket}/${key}`);
  if (forced === "THROW") throw new Error("storage unavailable");
  if (forced !== undefined) return forced;
  const asset = await db.asset.findFirstOrThrow({ where: { storageBucket: bucket, storageKey: key }, select: { sizeBytes: true, sourceEtag: true } });
  return { size: asset.sizeBytes as bigint, etag: asset.sourceEtag };
};

const MAIN = ["bf-audio", "bf-image", "bf-image-etag", "bf-primary-agree", "bf-primary-conflict", "bf-text", "bf-video"];
const SCENARIOS = ["sc-abort-1", "sc-abort-2", "sc-atomic-assign", "sc-atomic-claim", "sc-changed-evidence", "sc-conc-1", "sc-conc-2", "sc-conc-3", "sc-int-1", "sc-int-2", "sc-int-3", "sc-object-changed", "sc-race", "sc-stale-fence"];
const EXPECTED_REJECTED: Record<string, string> = {
  "bf-empty": "EMPTY_DATASET", "bf-empty-primary": "EMPTY_DATASET", "bf-empty-resolved": "DATASET_ALREADY_RESOLVED", "bf-mixed": "MIXED_MODALITY", "bf-mixed-primary": "MIXED_MODALITY",
  "bf-no-subtype": "ASSET_SUBTYPE_MISSING", "bf-subtype-mismatch": "ASSET_SUBTYPE_MISMATCH", "bf-no-storage": "STORAGE_REFERENCE_UNSUPPORTED", "bf-external": "STORAGE_REFERENCE_UNSUPPORTED",
  "bf-size-unrecorded": "SIZE_UNRECORDED", "bf-size-mismatch": "SIZE_MISMATCH", "bf-object-missing": "OBJECT_MISSING", "bf-etag-mismatch": "ETAG_MISMATCH", "bf-bucket-foreign": "BUCKET_NOT_APPROVED",
  "bf-soft-deleted": "SOFT_DELETED_ASSET_PRESENT", "bf-inflight": "INFLIGHT_WORK_PRESENT", "bf-archived": "DATASET_NOT_LIVE", "bf-deleted": "DATASET_NOT_LIVE",
};
const OWNER = { id: "bf-owner", role: "MANAGER" as const, email: "", name: "" };

after(async () => { await db.$disconnect(); });

const datasetRow = (id: string) => db.dataset.findUniqueOrThrow({ where: { id }, select: { id: true, modality: true, modalityContentRevision: true, modalityResolvedAt: true, modalityResolverSubject: true, primaryModality: true, deletedAt: true, archivedAt: true, updatedAt: true } });
const snapshot = async (ids?: string[]) => canonicalJson(await db.dataset.findMany({ where: ids ? { id: { in: ids } } : {}, orderBy: { id: "asc" }, select: { id: true, name: true, modality: true, modalityContentRevision: true, modalityResolvedAt: true, modalityResolverSubject: true, primaryModality: true, deletedAt: true, archivedAt: true, updatedAt: true, metadata: true } }));
const assetSnapshot = async () => canonicalJson(await db.asset.findMany({ orderBy: { id: "asc" } }));
const sideTables = async () => canonicalJson({ jobs: await db.job.count(), imports: await db.preparedImport.count(), assets: await db.asset.count(), datasets: await db.dataset.count(), labels: await db.label.count() });
const sub = (full: BackfillManifest, ids: string[]) => sealManifest({ generatedAt: full.generatedAt, policy: full.policy, candidates: full.candidates.filter(candidate => ids.includes(candidate.datasetId)), rejected: [] });
const run = (manifest: unknown, token: string, extra: { signal?: AbortSignal; testPoint?: (point: BackfillTestPoint, id: string) => Promise<void> } = {}): Promise<RunResult> => applyBackfillManifest({ manifest, runToken: token, statObject: stat, ...extra });
const statuses = (result: RunResult) => result.outcomes.map(outcome => `${outcome.datasetId}:${outcome.status}${outcome.status === "STOPPED" ? `:${outcome.code}` : ""}`);

let full: BackfillManifest;
let untouchedIds: string[] = [];
let primaryBefore = "";

test("setup: an EMPTY dataset is resolved by its owner (human path) and the dry-run inputs are recorded", async () => {
  assert.equal((await resolveEmptyDataset(OWNER, "bf-empty-resolved", "IMAGE")).ok, true);
  untouchedIds = Object.keys(EXPECTED_REJECTED);
  primaryBefore = canonicalJson(await db.dataset.findMany({ orderBy: { id: "asc" }, select: { id: true, primaryModality: true } }));
  overrides.set(`${BUCKET}/bf/bf-size-mismatch-a1`, { size: BigInt(99), etag: null });
  overrides.set(`${BUCKET}/bf/bf-object-missing-a1`, null);
  overrides.set(`${BUCKET}/bf/bf-etag-mismatch-a1`, { size: BigInt(11), etag: "etag-other" });
  const rows = await db.dataset.findMany({ where: { id: { startsWith: "bf-" } }, select: { id: true, modality: true, modalityContentRevision: true } });
  assert.ok(rows.every(row => row.modalityContentRevision === BigInt(0) || row.id === "bf-empty-resolved") && rows.filter(row => row.modality === null).length === rows.length - 1, "every historical dataset starts unresolved at revision 0");
});

test("T029: select-only manifest — exactly the eligible datasets, every other dataset rejected with its specific code", async () => {
  const before = { datasets: await snapshot(), assets: await assetSnapshot(), side: await sideTables() };
  statCalls.length = 0;
  full = await buildBackfillManifest({ statObject: stat, expectedBucket: BUCKET, now: () => new Date("2026-10-06T00:00:00Z") });
  assert.deepEqual({ datasets: await snapshot(), assets: await assetSnapshot(), side: await sideTables() }, before, "T029 changed nothing");
  assert.deepEqual(full.candidates.map(candidate => candidate.datasetId), [...MAIN, ...SCENARIOS].sort());
  const rejected = Object.fromEntries(full.rejected.filter(entry => entry.datasetId.startsWith("bf-") || entry.datasetId.startsWith("sc-")).map(entry => [entry.datasetId, entry.code]));
  assert.deepEqual(rejected, EXPECTED_REJECTED);
  const byId = Object.fromEntries(full.candidates.map(candidate => [candidate.datasetId, candidate]));
  assert.deepEqual({ image: byId["bf-image"].modality, video: byId["bf-video"].modality, audio: byId["bf-audio"].modality, text: byId["bf-text"].modality, conflict: byId["bf-primary-conflict"].modality, agree: byId["bf-primary-agree"].modality },
    { image: "IMAGE", video: "VIDEO", audio: "AUDIO", text: "TEXT", conflict: "AUDIO", agree: "VIDEO" }, "SINGLE modality comes from the Assets only; the conflicting legacy value is ignored");
  assert.ok(full.candidates.every(candidate => candidate.datasetRevision === "0" && /^[0-9a-f]{64}$/.test(candidate.assetEvidenceDigest) && candidate.objects.length === candidate.assetCount));
  assert.equal(byId["bf-image"].assetCount, 2);
  assert.ok(statCalls.length > 0 && statCalls.every(call => call.startsWith(`${BUCKET}/bf/`)), "metadata reads of approved-bucket objects only");
  assert.ok(!statCalls.some(call => call.startsWith("foreign-bucket/")), "a non-approved bucket is rejected before any storage read");
  const again = await buildBackfillManifest({ statObject: stat, expectedBucket: BUCKET, now: () => new Date("2026-10-06T00:00:00Z") });
  assert.equal(again.manifestSha256, full.manifestSha256, "the manifest is deterministic for unchanged evidence");
});

test("T031 refuses a tampered manifest and a malformed run token before any database write", async () => {
  const before = await snapshot();
  const forged = JSON.parse(JSON.stringify(full));
  forged.candidates[0].modality = forged.candidates[0].modality === "IMAGE" ? "VIDEO" : "IMAGE";
  await assert.rejects(run(forged, "run-tamper-0001"), /MANIFEST_INVALID/);
  await assert.rejects(run({ not: "a manifest" }, "run-tamper-0001"), /MANIFEST_INVALID/);
  await assert.rejects(run(full, "cmuvg0zar000010uwqzkhidz1:user"), /RUN_TOKEN_INVALID/);
  assert.equal(await snapshot(), before);
});

test("T031 happy path: assigns each SINGLE modality with an opaque receipt, +1 fence, immutable afterwards, nothing else changes", async () => {
  const main = sub(full, MAIN);
  const subject = backfillSubject("run-main-0001");
  const untouchedBefore = await snapshot(untouchedIds);
  const beforeRows = Object.fromEntries(await Promise.all(MAIN.map(async id => [id, await datasetRow(id)])));
  const result = await run(main, "run-main-0001");
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.counts, { candidates: 7, committed: 7, replayed: 0, stopped: 0, notAttempted: 0 });
  assert.equal(result.manifestSha256, main.manifestSha256);
  for (const candidate of main.candidates) {
    const row = await datasetRow(candidate.datasetId);
    assert.equal(row.modality, candidate.modality);
    assert.equal(row.modalityResolverSubject, subject);
    assert.ok(row.modalityResolvedAt);
    assert.equal(row.modalityContentRevision, beforeRows[candidate.datasetId].modalityContentRevision + BigInt(1), "exactly one fence increment (the claim), no other arithmetic");
    assert.equal(row.primaryModality, beforeRows[candidate.datasetId].primaryModality, "the legacy field is not modified");
    const outcome = result.outcomes.find(entry => entry.datasetId === candidate.datasetId);
    assert.ok(outcome && outcome.status === "COMMITTED" && outcome.revisionBefore === "0" && outcome.revisionAfter === "1" && outcome.subject === subject);
  }
  assert.equal((await datasetRow("bf-primary-conflict")).primaryModality, "IMAGE");
  assert.equal((await datasetRow("bf-primary-conflict")).modality, "AUDIO");
  assert.equal(await snapshot(untouchedIds), untouchedBefore, "datasets that were not approved are unchanged");
  // Receipt immutability (database trigger)
  await assert.rejects(db.dataset.update({ where: { id: "bf-image" }, data: { modality: "VIDEO" } }), /DATASET_MODALITY_IMMUTABLE/);
  await assert.rejects(db.dataset.update({ where: { id: "bf-image" }, data: { modalityResolverSubject: "system:phase029-backfill:forged-token" } }), /DATASET_MODALITY_IMMUTABLE/);
  await assert.rejects(db.dataset.update({ where: { id: "bf-image" }, data: { modalityContentRevision: { decrement: 1 } } }), /DATASET_MODALITY_FENCE_REWIND/);
  await assert.rejects(db.asset.create({ data: { datasetId: "bf-image", filename: "x", mimeType: "audio/wav", modality: "AUDIO", sourceFingerprint: "x", audioAsset: { create: { metadata: {} } } } }), /ASSET_MODALITY_MISMATCH/);
});

test("T031 replay: the same run token is idempotent; a different token stops at the first already-resolved dataset", async () => {
  const main = sub(full, MAIN);
  const before = await snapshot(MAIN);
  const replay = await run(main, "run-main-0001");
  assert.equal(replay.status, "COMPLETED");
  assert.deepEqual(replay.counts, { candidates: 7, committed: 0, replayed: 7, stopped: 0, notAttempted: 0 });
  assert.equal(await snapshot(MAIN), before);
  const other = await run(main, "run-other-0002");
  assert.deepEqual(statuses(other), [`bf-audio:STOPPED:DATASET_ALREADY_RESOLVED`, ...MAIN.slice(1).map(id => `${id}:NOT_ATTEMPTED`)]);
  assert.equal(other.status, "STOPPED"); assert.deepEqual(other.counts, { candidates: 7, committed: 0, replayed: 0, stopped: 1, notAttempted: 6 });
  assert.equal(await snapshot(MAIN), before, "a refused run changes nothing");
  assert.equal((await run(sub(full, ["bf-image"]), "run-other-0002")).outcomes[0].status, "STOPPED");
  const second = await buildBackfillManifest({ statObject: stat, expectedBucket: BUCKET });
  assert.ok(MAIN.every(id => second.rejected.some(entry => entry.datasetId === id && entry.code === "DATASET_ALREADY_RESOLVED")) && second.candidates.every(candidate => !MAIN.includes(candidate.datasetId)), "resolved datasets are no longer candidates");
});

test("stale Dataset fence: an evidence change that is reverted still moves the fence, so the approval is stale", async () => {
  const manifest = sub(full, ["sc-stale-fence"]);
  const start = await datasetRow("sc-stale-fence");
  await db.asset.update({ where: { id: "sc-stale-fence-a1" }, data: { width: 5 } });
  await db.asset.update({ where: { id: "sc-stale-fence-a1" }, data: { width: null } });
  const moved = await datasetRow("sc-stale-fence");
  assert.equal(moved.modalityContentRevision, start.modalityContentRevision + BigInt(2), "two evidence writes, two fence increments");
  const result = await run(manifest, "run-stale-0001");
  assert.deepEqual(statuses(result), ["sc-stale-fence:STOPPED:STALE_DATASET_FENCE"]);
  const after = await datasetRow("sc-stale-fence");
  assert.equal(after.modality, null); assert.equal(after.modalityContentRevision, moved.modalityContentRevision, "the failed claim was rolled back");
});

test("changed Asset evidence without a fence move is detected inside the transaction and rolled back", async () => {
  const manifest = sub(full, ["sc-changed-evidence"]);
  const start = await datasetRow("sc-changed-evidence");
  await db.imageAsset.delete({ where: { assetId: "sc-changed-evidence-a1" } }); // not an Asset write: the trigger does not move the fence
  assert.equal((await datasetRow("sc-changed-evidence")).modalityContentRevision, start.modalityContentRevision);
  const result = await run(manifest, "run-changed-0001");
  assert.deepEqual(statuses(result), ["sc-changed-evidence:STOPPED:ASSET_EVIDENCE_CHANGED"]);
  const after = await datasetRow("sc-changed-evidence");
  assert.equal(after.modality, null); assert.equal(after.modalityContentRevision, start.modalityContentRevision, "the claim was rolled back with the stop");
});

test("changed object metadata after approval stops before any write", async () => {
  const manifest = sub(full, ["sc-object-changed"]);
  const start = await datasetRow("sc-object-changed");
  const asset = await db.asset.findUniqueOrThrow({ where: { id: "sc-object-changed-a1" }, select: { storageBucket: true, storageKey: true } });
  overrides.set(`${asset.storageBucket}/${asset.storageKey}`, { size: BigInt(77), etag: null });
  assert.deepEqual(statuses(await run(manifest, "run-object-0001")), ["sc-object-changed:STOPPED:SIZE_MISMATCH"]);
  overrides.set(`${asset.storageBucket}/${asset.storageKey}`, null);
  assert.deepEqual(statuses(await run(manifest, "run-object-0001")), ["sc-object-changed:STOPPED:OBJECT_MISSING"]);
  const after = await datasetRow("sc-object-changed");
  assert.equal(after.modality, null); assert.equal(after.modalityContentRevision, start.modalityContentRevision);
  overrides.delete(`${asset.storageBucket}/${asset.storageKey}`);
});

test("atomicity: a failure after the claim, or just before the assignment, leaves the Dataset exactly as it was; a later run still succeeds", async () => {
  for (const [id, point] of [["sc-atomic-claim", "AFTER_CLAIM"], ["sc-atomic-assign", "BEFORE_ASSIGN"]] as const) {
    const manifest = sub(full, [id]);
    const start = await datasetRow(id);
    const failed = await run(manifest, "run-atomic-0001", { testPoint: async current => { if (current === point) throw new Error("injected failure"); } });
    assert.deepEqual(statuses(failed), [`${id}:STOPPED:DATABASE_REJECTED`]);
    const after = await datasetRow(id);
    assert.equal(after.modality, null); assert.equal(after.modalityResolverSubject, null); assert.equal(after.modalityContentRevision, start.modalityContentRevision, `${point}: the claim was rolled back`);
    const retried = await run(manifest, "run-atomic-0001");
    assert.equal(retried.status, "COMPLETED");
    assert.equal((await datasetRow(id)).modalityContentRevision, start.modalityContentRevision + BigInt(1));
  }
});

test("interruption: a storage failure stops the run deterministically; a re-run with the same token completes it idempotently", async () => {
  const ids = ["sc-int-1", "sc-int-2", "sc-int-3"];
  const manifest = sub(full, ids);
  overrides.set(`${BUCKET}/bf/sc-int-2-a1`, "THROW");
  const first = await run(manifest, "run-int-000001");
  assert.deepEqual(statuses(first), ["sc-int-1:COMMITTED", "sc-int-2:STOPPED:OBJECT_CHECK_FAILED", "sc-int-3:NOT_ATTEMPTED"]);
  assert.equal(first.status, "STOPPED"); assert.deepEqual(first.counts, { candidates: 3, committed: 1, replayed: 0, stopped: 1, notAttempted: 1 });
  assert.equal((await datasetRow("sc-int-1")).modality, "IMAGE"); assert.equal((await datasetRow("sc-int-2")).modality, null); assert.equal((await datasetRow("sc-int-3")).modality, null);
  overrides.delete(`${BUCKET}/bf/sc-int-2-a1`);
  const second = await run(manifest, "run-int-000001");
  assert.deepEqual(statuses(second), ["sc-int-1:COMMITTED_REPLAY", "sc-int-2:COMMITTED", "sc-int-3:COMMITTED"]);
  assert.equal(second.status, "COMPLETED");
  for (const id of ids) assert.equal((await datasetRow(id)).modalityContentRevision, BigInt(1), "no dataset was claimed twice");
});

test("interruption by abort between datasets: the first is committed, the rest are NOT_ATTEMPTED and stay unresolved", async () => {
  const manifest = sub(full, ["sc-abort-1", "sc-abort-2"]);
  const controller = new AbortController();
  const first = await run(manifest, "run-abort-00001", { signal: controller.signal, testPoint: async (point, id) => { if (point === "BEFORE_ASSIGN" && id === "sc-abort-1") controller.abort(); } });
  assert.deepEqual(statuses(first), ["sc-abort-1:COMMITTED", "sc-abort-2:NOT_ATTEMPTED"]);
  assert.equal(first.status, "STOPPED"); assert.equal((await datasetRow("sc-abort-2")).modality, null);
  assert.deepEqual(statuses(await run(manifest, "run-abort-00001")), ["sc-abort-1:COMMITTED_REPLAY", "sc-abort-2:COMMITTED"]);
});

test("concurrency: two runs on the same manifest never double-assign; every dataset has exactly one receipt owner and one fence increment", async () => {
  const ids = ["sc-conc-1", "sc-conc-2", "sc-conc-3"];
  const manifest = sub(full, ids);
  const [a, b] = await Promise.all([run(manifest, "run-conc-a-0001"), run(manifest, "run-conc-b-0002")]);
  const subjects = { a: backfillSubject("run-conc-a-0001"), b: backfillSubject("run-conc-b-0002") };
  const committedBy = (result: RunResult) => result.outcomes.filter(outcome => outcome.status === "COMMITTED").map(outcome => outcome.datasetId);
  for (const id of ids) {
    const row = await datasetRow(id);
    assert.ok(row.modality !== null, `${id} resolved`);
    assert.ok([subjects.a, subjects.b].includes(row.modalityResolverSubject as string));
    assert.equal(row.modalityContentRevision, BigInt(1), `${id}: exactly one claim won`);
    const owners = [committedBy(a).includes(id) ? "a" : null, committedBy(b).includes(id) ? "b" : null].filter(Boolean);
    assert.equal(owners.length, 1, `${id} is reported committed by exactly one run`);
    assert.equal(subjects[owners[0] as "a" | "b"], row.modalityResolverSubject, `${id}: the reporting run owns the stored receipt`);
  }
  for (const result of [a, b]) {
    const codes = result.outcomes.filter(outcome => outcome.status === "STOPPED").map(outcome => (outcome as { code: string }).code);
    assert.ok(codes.every(code => code === "DATASET_ALREADY_RESOLVED" || code === "SERIALIZATION_EXHAUSTED"), JSON.stringify(codes));
    assert.equal(result.counts.committed + result.counts.replayed + result.counts.stopped + result.counts.notAttempted, 3);
  }
});

test("concurrency: an evidence writer racing the assignment waits for the Dataset row lock; invariants hold afterwards", async () => {
  const manifest = sub(full, ["sc-race"]);
  const start = await datasetRow("sc-race");
  let writer: Promise<unknown> | null = null;
  const result = await run(manifest, "run-race-000001", { testPoint: async (point) => { if (point === "AFTER_CLAIM") writer = db.asset.update({ where: { id: "sc-race-a1" }, data: { width: 9 } }).catch(error => error); } });
  const writerResult = await writer;
  assert.equal(result.status, "COMPLETED");
  const row = await datasetRow("sc-race");
  assert.equal(row.modality, "IMAGE");
  assert.ok(!((writerResult as unknown) instanceof Error), "the post-commit evidence write on the now-resolved dataset is accepted");
  assert.equal((await db.asset.findUniqueOrThrow({ where: { id: "sc-race-a1" } })).width, 9);
  assert.equal(row.modalityContentRevision, start.modalityContentRevision + BigInt(2), "claim + the writer's own fence increment, never lost");
  const assets = await db.asset.findMany({ where: { datasetId: "sc-race" }, select: { modality: true } });
  assert.ok(assets.every(asset => asset.modality === row.modality));
});

test("final accounting: every approved dataset is resolved once, nothing else moved, the legacy field is untouched", async () => {
  const unresolvedNow = (await db.dataset.findMany({ where: { id: { startsWith: "bf-" }, modality: null }, select: { id: true } })).map(row => row.id).sort();
  assert.deepEqual(unresolvedNow, Object.keys(EXPECTED_REJECTED).filter(id => id !== "bf-empty-resolved").sort(), "only non-approved datasets remain unresolved");
  const resolvedBackfill = await db.dataset.findMany({ where: { modalityResolverSubject: { startsWith: "system:phase029-backfill:" } }, select: { id: true } });
  assert.equal(resolvedBackfill.length, MAIN.length + SCENARIOS.filter(id => !["sc-stale-fence", "sc-changed-evidence", "sc-object-changed"].includes(id)).length);
  assert.equal(canonicalJson(await db.dataset.findMany({ orderBy: { id: "asc" }, select: { id: true, primaryModality: true } })), primaryBefore, "primaryModality never changed for any dataset");
  const stillUnresolvedScenarios = (await db.dataset.findMany({ where: { id: { in: ["sc-stale-fence", "sc-changed-evidence", "sc-object-changed"] } }, select: { id: true, modality: true } }));
  assert.ok(stillUnresolvedScenarios.every(row => row.modality === null), "stopped scenarios stay unresolved");
  const owner = await resolveEmptyDataset(OWNER, "bf-empty", "TEXT");
  assert.equal(owner.ok, true, "the EMPTY human path is unaffected and still works");
});
