import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database is opened).
import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { processImportDataset } from "../../src/jobs/import-dataset.js";
import { reconcileMirroredRepositoryAsset } from "../../src/jobs/repository-asset-upsert.js";
import { classifyDefinitiveHeader, classifyProbeOutput } from "../../src/jobs/repository-media-classification.js";
import { detectRepositoryFile, parseRepositoryImportInput, type RepositoryCandidate } from "../../src/jobs/repository-import-source.js";
import { buildRepositoryJobInput } from "./helpers.js";

// T021 (worker side), offline: no database, network, object store or ffprobe. The byte classifier, the ffprobe-output interpreter, the source-identity
// reconciliation and the queued-job entry guard are exercised as the exact production functions; the database is a recording fake where one is needed.
// The DB-backed behavior of the same boundary is proven separately (`worker:test:ingestion-replay-reuse`, `verify:ingestion-replay-summary`).

const png = (width = 2, height = 2) => { const b = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b; };
const riff = (kind: string) => { const b = Buffer.alloc(32); b.write("RIFF", 0, "ascii"); b.write(kind, 8, "ascii"); return b; };
const iso = (brand: string) => { const b = Buffer.alloc(32); b.writeUInt32BE(24, 0); b.write("ftyp", 4, "ascii"); b.write(brand, 8, "ascii"); return b; };

test("spoofed extension or MIME: classification is decided by bytes only and never by the discovery hint", () => {
  // The listing hint comes from the extension; the classifier does not even receive it.
  assert.equal(detectRepositoryFile("a/cat.png", 10, "main", "blob", "http://x/f")?.modality, "IMAGE");
  assert.equal(classifyDefinitiveHeader(Buffer.from("this is plain text, not a picture\n")), "TEXT", "text bytes named .png classify as TEXT (the import then rejects them against an IMAGE Dataset)");
  assert.equal(classifyDefinitiveHeader(png()), "IMAGE", "PNG bytes named .txt/.wav classify as IMAGE");
  assert.equal(classifyDefinitiveHeader(riff("WAVE")), "AUDIO");
  assert.equal(classifyDefinitiveHeader(riff("WEBP")), "IMAGE");
  assert.equal(classifyDefinitiveHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "IMAGE");
  assert.equal(classifyDefinitiveHeader(png(0, 5)), null, "a PNG with a zero dimension is not definitive");
  assert.equal(classifyDefinitiveHeader(Buffer.concat([png().subarray(0, 12)])), null, "a truncated PNG header is not definitive and never throws");
  assert.equal(classifyDefinitiveHeader(Buffer.alloc(0)), null);
  assert.equal(classifyDefinitiveHeader(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xfd])), null, "binary garbage declared as text is not text");
  assert.equal(classifyDefinitiveHeader(Buffer.from("ok\u0000hidden")), null, "a NUL byte disqualifies text");
});

test("ambiguous containers are never classified from the header: they go to bounded ffprobe and fail closed on anything unclear", () => {
  for (const [label, bytes] of [["ISO BMFF mp4", iso("isom")], ["ISO BMFF heic", iso("heic")], ["ISO BMFF avif", iso("avif")], ["Ogg", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(28, 1)])], ["Matroska/WebM", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28, 1)])], ["ZIP", Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(28, 1)])], ["PDF", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(20, 0)])], ["RIFF AVI", riff("AVI ")]] as const) {
    assert.equal(classifyDefinitiveHeader(bytes), null, `${label} must not be decided by its header`);
  }
  // ffprobe output interpretation
  assert.equal(classifyProbeOutput(JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] })), "VIDEO", "audio+video container is VIDEO");
  assert.equal(classifyProbeOutput(JSON.stringify({ streams: [{ codec_type: "audio" }] })), "AUDIO");
  for (const [label, output, code] of [
    ["data-only container", JSON.stringify({ streams: [{ codec_type: "data" }] }), "SOURCE_CONTENT_UNSUPPORTED"],
    ["subtitle-only container", JSON.stringify({ streams: [{ codec_type: "subtitle" }] }), "SOURCE_CONTENT_UNSUPPORTED"],
    ["no streams", JSON.stringify({ streams: [] }), "SOURCE_CONTENT_UNSUPPORTED"],
    ["streams missing", JSON.stringify({}), "SOURCE_CONTENT_UNSUPPORTED"],
    ["malformed stream entries", JSON.stringify({ streams: [null, 3, { codec_type: 5 }] }), "SOURCE_CONTENT_UNSUPPORTED"],
    ["unparseable output", "not json", "SOURCE_CONTENT_UNVERIFIED"],
    ["empty output", "", "SOURCE_CONTENT_UNVERIFIED"],
  ] as const) assert.throws(() => classifyProbeOutput(output), { message: code }, label);
});

const candidate: RepositoryCandidate = { path: "images/cat.png", filename: "cat.png", mimeType: "image/png", modality: "IMAGE", sizeBytes: 100, revision: "rev-1", providerFileIdentity: "blob-1", downloadUrl: "http://x/f" };
const row = (over: Record<string, unknown> = {}) => ({ id: "asset-1", modality: "IMAGE", storageBucket: "bucket", storageKey: "key", sourceRevision: "rev-1", sourceFileSha: "blob-1", sizeBytes: BigInt(100), imageAsset: { id: "child" }, videoAsset: null, audioAsset: null, textAsset: null, ...over });
const reconcileDb = (dataset: { modality: string | null } | null, asset: ReturnType<typeof row> | null) => ({
  dataset: { findFirst: async () => dataset }, asset: { findUnique: async () => asset },
}) as unknown as PrismaClient;
const reconcile = (db: PrismaClient, over: Partial<RepositoryCandidate> = {}, key = "key") => reconcileMirroredRepositoryAsset({ db, datasetId: "d", sourceFingerprint: "fp", candidate: { ...candidate, ...over }, bucket: "bucket", objectKey: key });

test("source identity change: a retry reuses only the exact immutable blob; every difference is a conflict, a wrong or unresolved parent is refused", async () => {
  assert.deepEqual(await reconcile(reconcileDb({ modality: "IMAGE" }, null)), { kind: "absent" });
  assert.deepEqual(await reconcile(reconcileDb({ modality: "IMAGE" }, row())), { kind: "reusable", assetId: "asset-1", storageKey: "key" });
  const base = reconcileDb({ modality: "IMAGE" }, row());
  for (const [label, over, key] of [
    ["changed blob identity (same path, new content)", { providerFileIdentity: "blob-2" }, "key"],
    ["changed revision", { revision: "rev-2" }, "key"],
    ["changed size", { sizeBytes: 101 }, "key"],
    ["changed object location", {}, "other-key"],
  ] as const) assert.deepEqual(await reconcile(base, over, key), { kind: "conflict" }, label);
  assert.deepEqual(await reconcile(reconcileDb({ modality: "IMAGE" }, row({ storageBucket: "other" }))), { kind: "conflict" }, "changed bucket");
  assert.deepEqual(await reconcile(reconcileDb({ modality: "IMAGE" }, row({ imageAsset: null }))), { kind: "conflict" }, "missing subtype row");
  assert.deepEqual(await reconcile(reconcileDb({ modality: "IMAGE" }, row({ imageAsset: null, videoAsset: { id: "x" } }))), { kind: "conflict" }, "wrong subtype row");
  await assert.rejects(reconcile(reconcileDb({ modality: null }, row())), { message: "DATASET_MODALITY_UNRESOLVED" });
  await assert.rejects(reconcile(reconcileDb({ modality: "VIDEO" }, row())), { message: "ASSET_MODALITY_MISMATCH" }, "an existing Asset of another modality than its parent is never reused");
  await assert.rejects(reconcile(reconcileDb(null, null)), { message: "DATASET_UNAVAILABLE" });
});

// ---- queued old jobs ---------------------------------------------------------------------------------------------------------------------------------
type Call = { model: string; op: string; args: unknown };
function recordingDb(job: unknown) {
  const calls: Call[] = [];
  const db = new Proxy({}, { get: (_t, model: string) => new Proxy({}, { get: (_u, op: string) => async (args: unknown) => {
    calls.push({ model, op, args });
    if (model === "preparedImport" && op === "findUnique") return null;
    if (model === "job" && op === "findUnique") return job;
    if (op === "updateMany") return { count: 1 };
    return { id: "event" };
  } }) }) as unknown as PrismaClient;
  return { db, calls };
}
const queuedJob = (modality: string | null, input: unknown = buildRepositoryJobInput()) => ({ id: "job-1", datasetId: "dataset-1", createdById: "user-1", input, sourceConnectionId: null, dataset: { sourceMode: "MIRROR_TO_MINIO", modality, sourceRootPath: null } });

test("queued old jobs: input never carries or overrides a modality; an unresolved Dataset fails the job before any provider, storage or Asset work", async () => {
  // Legacy/queued inputs have no modality key and are still accepted; any modality-like or extra key (stale, forged) is rejected by the strict schema.
  assert.ok(parseRepositoryImportInput(buildRepositoryJobInput()));
  const withKey = (key: string) => { const input = buildRepositoryJobInput() as { source: Record<string, unknown> }; return { ...input, source: { ...input.source, [key]: "VIDEO" } }; };
  for (const key of ["modality", "primaryModality", "verifiedModality", "confirmedClasses"]) assert.equal(parseRepositoryImportInput(withKey(key)), null, `${key} at source level`);
  const topLevel = { ...(buildRepositoryJobInput() as object), modality: "VIDEO" };
  assert.equal(parseRepositoryImportInput(topLevel), null, "top-level modality");

  const { db, calls } = recordingDb(queuedJob(null));
  const result = await processImportDataset(db, "job-1", "lock-1");
  assert.deepEqual(result, { kind: "repository-refused" });
  const writes = calls.filter((call) => ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"].includes(call.op));
  assert.ok(writes.every((call) => call.model === "job" || call.model === "jobEvent"), `only Job/JobEvent rows are written: ${writes.map((w) => w.model)}`);
  assert.ok(!calls.some((call) => call.model === "asset" || call.model === "imageAsset" || call.model === "videoAsset" || call.model === "audioAsset" || call.model === "textAsset"), "no Asset or subtype table is touched");
  const codeWrite = calls.find((call) => call.model === "job" && call.op === "updateMany" && JSON.stringify(call.args).includes("DATASET_MODALITY_UNRESOLVED"));
  assert.ok(codeWrite, "the safe failure code DATASET_MODALITY_UNRESOLVED is recorded");
  assert.ok(calls.some((call) => call.model === "job" && call.op === "updateMany" && JSON.stringify(call.args).includes("FAILED")), "the job is terminally failed");

  // A queued job whose input is old/invalid never reaches any worker action at all.
  const invalid = recordingDb(queuedJob("IMAGE", { source: { repository: { provider: "GITEA" } } }));
  assert.deepEqual(await processImportDataset(invalid.db, "job-1", "lock-1"), { kind: "not-applicable" });
  assert.ok(!invalid.calls.some((call) => ["create", "createMany", "update", "updateMany", "upsert"].includes(call.op)), "an unparseable queued input writes nothing");
});
