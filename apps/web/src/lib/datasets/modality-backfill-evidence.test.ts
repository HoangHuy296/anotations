import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assetEvidenceDigest, backfillSubject, canonicalJson, classifyDatasetEvidence, observeObjects, sealManifest, summarizeRun, verifyManifest, verifyObjectObservation,
  type AssetEvidenceRow, type DatasetEvidence, type StatObject,
} from "@/lib/datasets/modality-backfill-evidence";

// Offline: pure rules only (no database, no storage). The DB-backed behavior is rehearsed by `release:phase029-backfill`.
const BUCKET = "assets";
const asset = (id: string, over: Partial<AssetEvidenceRow> = {}): AssetEvidenceRow => ({
  id, datasetId: "d1", modality: "IMAGE", sourceMode: "UPLOAD", storageProvider: "MINIO", storageBucket: BUCKET, storageKey: `k/${id}`, checksum: null, externalRepositoryId: null,
  sourceProvider: null, sourceRef: null, sourceRevision: null, sourcePath: null, relativePath: null, sourceFileSha: null, sourceBlobSha: null, sourceLfsOid: null,
  sourceEtag: null, sourceUrl: null, sourceFingerprint: `fp:${id}`, currentVersionId: null, mimeType: "image/png", sizeBytes: BigInt(10), width: null, height: null, durationMs: null, textLength: null,
  deletedAt: null, imageAsset: { assetId: id }, videoAsset: null, audioAsset: null, textAsset: null, ...over,
} as AssetEvidenceRow);
const dataset = (over: Partial<DatasetEvidence> = {}): DatasetEvidence => ({ id: "d1", live: true, modality: null, revision: BigInt(0), inflight: false, assets: [asset("a1"), asset("a2")], ...over });
const policy = { expectedBucket: BUCKET };
const code = (d: DatasetEvidence) => { const r = classifyDatasetEvidence(d, policy); return r.ok ? `OK:${r.modality}` : r.code; };

test("SINGLE modality is derived from Asset evidence for every modality", () => {
  assert.equal(code(dataset()), "OK:IMAGE");
  assert.equal(code(dataset({ assets: [asset("v", { modality: "VIDEO", imageAsset: null, videoAsset: { assetId: "v" } })] })), "OK:VIDEO");
  assert.equal(code(dataset({ assets: [asset("u", { modality: "AUDIO", imageAsset: null, audioAsset: { assetId: "u" } })] })), "OK:AUDIO");
  assert.equal(code(dataset({ assets: [asset("t", { modality: "TEXT", imageAsset: null, textAsset: { assetId: "t" } })] })), "OK:TEXT");
});
test("classification rejects every non-eligible state with a specific code", () => {
  assert.equal(code(dataset({ live: false })), "DATASET_NOT_LIVE");
  assert.equal(code(dataset({ modality: "IMAGE" })), "DATASET_ALREADY_RESOLVED");
  assert.equal(code(dataset({ assets: [] })), "EMPTY_DATASET");
  assert.equal(code(dataset({ assets: [asset("a1"), asset("a2", { modality: "AUDIO", imageAsset: null, audioAsset: { assetId: "a2" } })] })), "MIXED_MODALITY");
  assert.equal(code(dataset({ inflight: true })), "INFLIGHT_WORK_PRESENT");
  assert.equal(code(dataset({ assets: [asset("a1", { deletedAt: new Date() })] })), "SOFT_DELETED_ASSET_PRESENT");
  assert.equal(code(dataset({ assets: [asset("a1", { imageAsset: null })] })), "ASSET_SUBTYPE_MISSING");
  assert.equal(code(dataset({ assets: [asset("a1", { imageAsset: null, videoAsset: { assetId: "a1" } })] })), "ASSET_SUBTYPE_MISMATCH");
  assert.equal(code(dataset({ assets: [asset("a1", { videoAsset: { assetId: "a1" } })] })), "ASSET_SUBTYPE_MISMATCH");
  assert.equal(code(dataset({ assets: [asset("a1", { storageKey: null })] })), "STORAGE_REFERENCE_UNSUPPORTED");
  assert.equal(code(dataset({ assets: [asset("a1", { storageProvider: "EXTERNAL" })] })), "STORAGE_REFERENCE_UNSUPPORTED");
  assert.equal(code(dataset({ assets: [asset("a1", { storageBucket: "other" })] })), "BUCKET_NOT_APPROVED");
  assert.equal(code(dataset({ assets: [asset("a1", { sizeBytes: null })] })), "SIZE_UNRECORDED");
});
test("the legacy primaryModality is not part of any evidence type and never read", () => {
  for (const file of ["modality-backfill-evidence.ts", "modality-backfill.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.equal(/primaryModality/.test(source.replace(/primaryModality is never[^\n]*|`primaryModality`[^\n]*|legacy `primaryModality`[^\n]*/g, "")), false, file);
  }
  const noise = dataset({ ...({ primaryModality: "AUDIO" } as object) });
  assert.equal(code(noise), "OK:IMAGE");
});

test("object metadata rule: existence, size, and the recorded ETag only when recorded", () => {
  const plain = asset("a1");
  assert.equal(verifyObjectObservation(plain, null), "OBJECT_MISSING");
  assert.equal(verifyObjectObservation(plain, { size: BigInt(11), etag: null }), "SIZE_MISMATCH");
  assert.equal(verifyObjectObservation(plain, { size: BigInt(10), etag: null }), null, "no recorded ETag: none is required or invented");
  assert.equal(verifyObjectObservation(plain, { size: BigInt(10), etag: "\"whatever\"" }), null, "an observed ETag is ignored when none is recorded");
  const recorded = asset("a1", { sourceEtag: "ABC123" });
  assert.equal(verifyObjectObservation(recorded, { size: BigInt(10), etag: "\"abc123\"" }), null, "quotes and case are normalized");
  assert.equal(verifyObjectObservation(recorded, { size: BigInt(10), etag: "W/\"abc123\"" }), null);
  assert.equal(verifyObjectObservation(recorded, { size: BigInt(10), etag: "other" }), "ETAG_MISMATCH");
  assert.equal(verifyObjectObservation(recorded, { size: BigInt(10), etag: null }), "ETAG_MISMATCH");
});
test("observeObjects stops at the first failing asset, never reads bytes, and maps a throwing stat to OBJECT_CHECK_FAILED", async () => {
  const calls: string[] = [];
  const stat: StatObject = async (_bucket, key) => { calls.push(key); return key.endsWith("a2") ? null : { size: BigInt(10), etag: "e" }; };
  const result = await observeObjects([asset("a2"), asset("a1"), asset("a3")], stat);
  assert.deepEqual(result, { ok: false, code: "OBJECT_MISSING" });
  assert.deepEqual(calls, ["k/a1", "k/a2"], "sorted by asset id, stopped at the first failure");
  assert.deepEqual(await observeObjects([asset("a1")], async () => { throw new Error("network"); }), { ok: false, code: "OBJECT_CHECK_FAILED" });
  const good = await observeObjects([asset("b"), asset("a")], async () => ({ size: BigInt(10), etag: null }));
  assert.ok(good.ok && good.objects.map(o => o.assetId).join() === "a,b" && good.objects[0].size === "10");
});

test("the Asset evidence digest is order independent and changes with every evidence field, subtype presence and soft-deletion", () => {
  const base = [asset("a1"), asset("a2")];
  const digest = assetEvidenceDigest(base);
  assert.equal(assetEvidenceDigest([base[1], base[0]]), digest);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const mutations: Partial<AssetEvidenceRow>[] = [
    { sizeBytes: BigInt(11) }, { storageKey: "other" }, { storageBucket: "b2" }, { sourceEtag: "e" }, { checksum: "c" }, { width: 5 }, { height: 5 }, { durationMs: 5 }, { textLength: 5 },
    { relativePath: "r" }, { sourceFingerprint: "x" }, { mimeType: "image/jpeg" }, { currentVersionId: "v" }, { sourceUrl: "u" }, { deletedAt: new Date(0) },
    { imageAsset: null }, { videoAsset: { assetId: "a1" } }, { modality: "VIDEO" }, { sourceMode: "MIRROR_TO_MINIO" },
  ];
  for (const change of mutations) assert.notEqual(assetEvidenceDigest([asset("a1", change), base[1]]), digest, JSON.stringify(change, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.notEqual(assetEvidenceDigest([base[0]]), digest, "a missing asset");
  assert.notEqual(assetEvidenceDigest([...base, asset("a3")]), digest, "an added asset");
  assert.equal(canonicalJson({ b: 1, a: [BigInt(2), new Date(0)] }), canonicalJson({ a: [BigInt(2), new Date(0)], b: 1 }));
});

const candidate = (id: string, modality: "IMAGE" | "VIDEO" = "IMAGE") => ({ datasetId: id, modality, datasetRevision: "0", assetCount: 1, assetEvidenceDigest: "a".repeat(64), objects: [{ assetId: `${id}-a`, size: "10", etag: null }] });
const sealed = () => sealManifest({ generatedAt: "2026-10-06T00:00:00.000Z", policy, candidates: [candidate("d2"), candidate("d1")], rejected: [{ datasetId: "d3", code: "EMPTY_DATASET" }] });

test("manifest: sealed deterministically, sorted, and any tampering fails closed", () => {
  const manifest = sealed();
  assert.deepEqual(manifest.candidates.map(c => c.datasetId), ["d1", "d2"]);
  assert.equal(sealed().manifestSha256, manifest.manifestSha256);
  assert.equal(verifyManifest(JSON.parse(JSON.stringify(manifest))).manifestSha256, manifest.manifestSha256);
  const clone = () => JSON.parse(JSON.stringify(manifest));
  type Mutable = { [key: string]: unknown; candidates: Array<Record<string, unknown>>; policy: Record<string, unknown> };
  const tampers: Record<string, (m: Mutable) => void> = {
    "modality changed": m => { m.candidates[0].modality = "VIDEO"; },
    "revision changed": m => { m.candidates[0].datasetRevision = "1"; },
    "digest changed": m => { m.candidates[0].assetEvidenceDigest = "b".repeat(64); },
    "candidate added": m => { m.candidates.push(candidate("d9")); },
    "candidate removed": m => { m.candidates.pop(); },
    "bucket changed": m => { m.policy.expectedBucket = "other"; },
    "hash replaced": m => { m.manifestSha256 = "c".repeat(64); },
    "ids digest replaced": m => { m.approvedIdsDigest = "c".repeat(64); },
    "unknown key": m => { m.extra = true; },
    "unsorted": m => { m.candidates.reverse(); },
    "duplicate": m => { m.candidates[1].datasetId = "d1"; },
    "asset count mismatch": m => { m.candidates[0].assetCount = 2; },
    "kind": m => { m.kind = "x"; },
    "version": m => { m.schemaVersion = 2; },
  };
  for (const [label, tamper] of Object.entries(tampers)) { const m = clone(); tamper(m); assert.throws(() => verifyManifest(m), /MANIFEST_INVALID/, label); }
  assert.throws(() => verifyManifest(null), /MANIFEST_INVALID/);
  assert.equal(clone().rejected[0].code, "EMPTY_DATASET");
  // The rejected list is informational: editing it does not change the approved set or the sealed hash.
  const withRejectedEdit = clone(); withRejectedEdit.rejected = []; assert.doesNotThrow(() => verifyManifest(withRejectedEdit));
});

test("receipt subject: opaque, prefixed, bounded; actor ids and malformed tokens are refused", () => {
  assert.equal(backfillSubject("20261006-abcdef12"), "system:phase029-backfill:20261006-abcdef12");
  assert.ok(backfillSubject("a".repeat(64)).length <= 128);
  for (const bad of ["", "short", "UPPERCASE-TOKEN", "has space token", "../etc", "a".repeat(65), "cmuvg0zar000010uwqzkhidz1:user", "-leading-dash"]) assert.throws(() => backfillSubject(bad), /RUN_TOKEN_INVALID/, bad);
});

test("run accounting: deterministic, adds up, at most one stop, COMPLETED only when everything committed", () => {
  const manifest = sealed();
  const committed = (id: string) => ({ datasetId: id, status: "COMMITTED" as const, modality: "IMAGE" as const, resolvedAt: "2026-10-06T00:00:00.000Z", subject: "s", revisionBefore: "0", revisionAfter: "1" });
  const done = summarizeRun(manifest, "tok-12345678", [committed("d1"), { ...committed("d2"), status: "COMMITTED_REPLAY" }]);
  assert.deepEqual({ status: done.status, ...done.counts }, { status: "COMPLETED", candidates: 2, committed: 1, replayed: 1, stopped: 0, notAttempted: 0 });
  const stopped = summarizeRun(manifest, "tok-12345678", [committed("d1"), { datasetId: "d2", status: "STOPPED", code: "STALE_DATASET_FENCE" }]);
  assert.equal(stopped.status, "STOPPED");
  const interrupted = summarizeRun(manifest, "tok-12345678", [committed("d1"), { datasetId: "d2", status: "NOT_ATTEMPTED" }]);
  assert.deepEqual({ status: interrupted.status, ...interrupted.counts }, { status: "STOPPED", candidates: 2, committed: 1, replayed: 0, stopped: 0, notAttempted: 1 });
  assert.throws(() => summarizeRun(manifest, "tok-12345678", [committed("d1")]), /ACCOUNTING_INCONSISTENT/, "missing outcome");
  assert.throws(() => summarizeRun(manifest, "tok-12345678", [committed("d2"), committed("d1")]), /ACCOUNTING_INCONSISTENT/, "wrong order");
  assert.throws(() => summarizeRun(manifest, "tok-12345678", [{ datasetId: "d1", status: "STOPPED", code: "STALE_DATASET_FENCE" }, { datasetId: "d2", status: "STOPPED", code: "STALE_DATASET_FENCE" }]), /ACCOUNTING_INCONSISTENT/, "two stops");
});

test("T029 is select-only: the manifest builder contains no write call, and T031 writes only through the claim and the assignment", () => {
  const source = readFileSync(new URL("./modality-backfill.ts", import.meta.url), "utf8");
  const t029 = source.slice(source.indexOf("export async function buildBackfillManifest"), source.indexOf("// ============================================================ T031"));
  assert.equal(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction\([^)]*\{[^}]*(create|update|delete)/.test(t029), false);
  assert.match(t029, /RepeatableRead/);
  const t031 = source.slice(source.indexOf("async function processCandidate"));
  const writes = [...t031.matchAll(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map(match => match[1]);
  assert.deepEqual(writes, ["updateMany", "update"], "exactly the fence claim and the assignment");
  assert.doesNotMatch(source, /\$executeRaw|\$queryRaw|\$executeRawUnsafe/);
  assert.match(t031, /Serializable/); assert.match(t031, /modalityContentRevision: expectedRevision/);
  assert.doesNotMatch(source, /canResolveEmptyDataset|resolveEmptyDataset\(|requireDatasetPermission/, "no human authority is reused for the evidence backfill");
});

// ---------------------------------------------------------------- approval lifecycle (observed → approved → executed)
import { deriveApprovedManifest, selectApprovedCandidates, verifyApprovedManifest } from "@/lib/datasets/modality-backfill-evidence";
const observed3 = () => sealManifest({ generatedAt: "2026-10-06T00:00:00.000Z", policy, candidates: [candidate("d1"), candidate("d2"), candidate("d3", "VIDEO")], rejected: [{ datasetId: "d9", code: "EMPTY_DATASET" }] });
const approvedFor = (ids: string[], observed = observed3()) => deriveApprovedManifest({ observed, approvedIds: ids, approver: "release owner", approvedAt: "2026-10-06T01:00:00.000Z", statement: "approved for the maintenance window" });

test("approval: the approved manifest is a separate artifact bound to ONE observed manifest, and only its ids can be executed", () => {
  const observed = observed3();
  const approved = approvedFor(["d3", "d1"], observed);
  assert.deepEqual(approved.approvedIds, ["d1", "d3"]);
  assert.equal(approved.observedManifestSha256, observed.manifestSha256);
  const selected = selectApprovedCandidates(observed, approved);
  assert.deepEqual(selected.executed.candidates.map(c => c.datasetId), ["d1", "d3"], "d2 appeared in the observed manifest but was not approved, so it is not executable");
  assert.deepEqual(selected.executed.candidates, observed.candidates.filter(c => c.datasetId !== "d2"), "approved candidates keep their observed evidence exactly");
  assert.notEqual(selected.executed.manifestSha256, observed.manifestSha256);
  assert.equal(verifyApprovedManifest(JSON.parse(JSON.stringify(approved))).sha256, approved.sha256);
  assert.equal(approvedFor(["d1", "d3"], observed).sha256.length, 64);
});
test("approval fails closed: unknown ids, empty or duplicate lists, tampering, and an approval for a different observed manifest", () => {
  const observed = observed3();
  assert.throws(() => approvedFor(["d1", "d404"], observed), /APPROVED_ID_NOT_CANDIDATE/, "an id that is not an observed candidate");
  assert.throws(() => approvedFor(["d9"], observed), /APPROVED_ID_NOT_CANDIDATE/, "a rejected Dataset can never be approved");
  assert.throws(() => approvedFor([], observed), /APPROVED_MANIFEST_INVALID/);
  assert.throws(() => approvedFor(["d1", "d1"], observed), /APPROVED_MANIFEST_INVALID/);
  const approved = approvedFor(["d1"], observed);
  type Mutable = { [key: string]: unknown; approvedIds: string[] };
  const tampers: Record<string, (m: Mutable) => void> = {
    "id added": m => { m.approvedIds.push("d2"); }, "id swapped": m => { m.approvedIds[0] = "d2"; }, "approver changed": m => { m.approver = "someone else"; }, "statement changed": m => { m.statement = "x"; },
    "observed hash changed": m => { m.observedManifestSha256 = "d".repeat(64); }, "hash replaced": m => { m.sha256 = "c".repeat(64); }, "digest replaced": m => { m.approvedIdsDigest = "c".repeat(64); }, "unknown key": m => { m.extra = 1; }, "unsorted": m => { m.approvedIds = ["d3", "d1"]; },
    "empty approver": m => { m.approver = ""; }, "bad timestamp": m => { m.approvedAt = "yesterday"; },
  };
  for (const [label, tamper] of Object.entries(tampers)) { const m = JSON.parse(JSON.stringify(approved)); tamper(m); assert.throws(() => verifyApprovedManifest(m), /APPROVED_MANIFEST_INVALID/, label); }
  assert.throws(() => selectApprovedCandidates(observed, approvedFor(["d1"], sealManifest({ generatedAt: "2026-10-06T00:00:00.000Z", policy, candidates: [candidate("d1")], rejected: [] }))), /APPROVED_OBSERVED_MISMATCH/, "approval for another observed manifest");
  const forgedObserved = JSON.parse(JSON.stringify(observed)); forgedObserved.candidates[0].modality = "VIDEO";
  assert.throws(() => selectApprovedCandidates(forgedObserved, approved), /MANIFEST_INVALID/, "a tampered observed manifest");
  assert.throws(() => selectApprovedCandidates(observed, null), /APPROVED_MANIFEST_INVALID/);
});
