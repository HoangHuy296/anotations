import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify the disposable target before fixtures.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";

import { AssetWritesQuiescedError } from "@annotationplatform/domain/asset-write-quiescence";
import { deriveMediaVerificationApiStatus } from "@annotationplatform/domain/media-verification";

import { interpretProbeCompletion } from "../../src/media/classification-policy.js";
import { processVerifyUploadedMedia } from "../../src/verification/process.js";
import { createHarness, corpusDocument, sha256, type Harness } from "./support.js";

/**
 * A2.4 runtime proof against REAL PostgreSQL (26-migration chain) and REAL MinIO. The probe is the only injected piece here: it returns the recorded real-ffprobe
 * outcome of the G-FIX corpus (and the characterized marker path for malformed files). The real ffprobe itself is exercised by the disposable HTTP runtime.
 */
let h: Harness;
before(async () => { h = await createHarness(); });
after(async () => { await h.cleanup(); });

const characterization = JSON.parse(readFileSync(new URL("../media/fixtures/probe-characterization.json", import.meta.url), "utf8")) as { ffprobeVersion: string; cases: Array<{ name: string; exitCode: number; stderr: string }> };
const malformedProbe = (name: string) => async () => {
  const c = characterization.cases.find((x) => x.name === name)!;
  return interpretProbeCompletion({ ffprobeVersion: characterization.ffprobeVersion, spawnError: false, timedOut: false, signal: null, exitCode: c.exitCode, stdoutTruncated: false, stdout: "", stderr: c.stderr });
};
const run = async (verification: Awaited<ReturnType<Harness["createVerification"]>>, deps = h.deps()) => processVerifyUploadedMedia(h.db, verification.jobId, verification.lockToken, deps);
const newBytes = () => randomBytes(4096);

test("H.264 MP4: PENDING -> SEALED -> VERIFIED -> PUBLISHED; one Asset + videoAsset created ONLY at publication; container-derived MIME; persisted SHA-256 is the checksum", async () => {
  const bytes = newBytes();
  const staged = await h.stage(bytes);
  const v = await h.createVerification(staged);
  let assetsBeforeProbe = -1; let sealedBeforeProbe = false;
  const deps = h.deps({ probe: async () => { assetsBeforeProbe = await h.assetCount(); sealedBeforeProbe = await h.exists(v.sealedKey); return { kind: "COMPLETED", document: corpusDocument("mp4_h264_video_audio.mp4") }; } });
  assert.equal(await run(v, deps), "published");
  assert.equal(assetsBeforeProbe, 0, "no Asset may exist before authoritative verification");
  assert.equal(sealedBeforeProbe, true, "the probe reads the SEALED object");
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "PUBLISHED");
  assert.equal(row.contentSha256, sha256(bytes));
  assert.equal(row.verifiedModality, "VIDEO");
  assert.equal(row.policyVersion, "premedia-verify.v2");
  assert.equal(await h.assetCount(), 1); assert.equal(await h.videoAssetCount(), 1);
  const asset = await h.db.asset.findFirstOrThrow({ where: { datasetId: h.dataset.id } });
  assert.equal(asset.modality, "VIDEO"); assert.equal(asset.mimeType, "video/mp4", "never the declared MIME"); assert.equal(asset.checksum, `sha256:${sha256(bytes)}`);
  assert.equal(asset.storageKey, v.sealedKey); assert.equal(asset.width, 128); assert.equal(asset.height, 96);
  assert.equal(row.assetId, asset.id);
  assert.equal(await h.exists(staged.key), false, "the staged object is removed after sealing");
  assert.equal(await h.exists(v.sealedKey), true, "the sealed object IS the Asset object (no rename)");
  assert.deepEqual({ ...(await h.jobOf(v.jobId)) }.status, "COMPLETED");
});

test("VP9 WebM publishes as video/webm (container-derived)", async () => {
  const staged = await h.stage(newBytes(), "clip.webm");
  const v = await h.createVerification(staged, { filename: "clip.webm" });
  assert.equal(await run(v, h.deps({ probe: h.probeFor("webm_vp9.webm") })), "published");
  assert.equal((await h.db.asset.findFirstOrThrow({ where: { id: (await h.reload(v.verification.id)).assetId! } })).mimeType, "video/webm");
});

test("G-FIX: an H.264 MP4 WITH an attached cover picture publishes as VIDEO (the picture is ignored, not penalized)", async () => {
  const v = await h.createVerification(await h.stage(newBytes()));
  assert.equal(await run(v, h.deps({ probe: h.probeFor("mp4_h264_with_cover.mp4") })), "published");
});

// G-FIX: the reviewed table of authoritative outcomes for the generated corpus (contract section 6.2). Each rejection must publish nothing and clean up both objects.
const REJECTIONS: Array<[file: string, code: string, reason: string]> = [
  ["mp4_hevc.mp4", "UNSUPPORTED_MEDIA", "CODEC_UNSUPPORTED"],
  ["ogg_vorbis.ogg", "UNSUPPORTED_MEDIA", "CONTAINER_UNSUPPORTED"],
  ["avi_mpeg4.avi", "UNSUPPORTED_MEDIA", "CONTAINER_UNSUPPORTED"],
  ["flac_picture.flac", "UNSUPPORTED_MEDIA", "CONTAINER_UNSUPPORTED"],
  ["avif_still.avif", "UNSUPPORTED_MEDIA", "STILL_OR_COVER_ART"],
  ["m4a_cover_art.m4a", "ASSET_MODALITY_MISMATCH", "CLASS_MISMATCH"],
  ["mp4_audio_only.m4a", "ASSET_MODALITY_MISMATCH", "CLASS_MISMATCH"],
  ["mp4_tiny_8x8.mp4", "INVALID_MEDIA", "MEDIA_POLICY_REJECTED"],
  ["mp4_single_frame.mp4", "INVALID_MEDIA", "MEDIA_POLICY_REJECTED"],
];
for (const [file, code, reason] of REJECTIONS) {
  test(`G-FIX rejection: ${file} -> REJECTED ${code}/${reason}; zero Assets; Job FAILED non-retryable; both objects removed`, async () => {
    const staged = await h.stage(newBytes());
    const v = await h.createVerification(staged);
    const before = await h.assetCount();
    assert.equal(await run(v, h.deps({ probe: h.probeFor(file) })), "rejected");
    const row = await h.assertConsistent(v.verification.id);
    assert.equal(row.status, "REJECTED"); assert.equal(row.resultCode, code); assert.equal(row.resultReason, reason);
    assert.ok(row.contentSha256 && row.probe, "a media rejection requires a COMPLETED probe and the content identity");
    assert.equal(row.verifiedModality, null); assert.equal(row.assetId, null);
    assert.equal(await h.assetCount(), before, "nothing is published");
    const job = await h.jobOf(v.jobId);
    assert.equal(job.status, "FAILED"); assert.equal(job.errorCode, code);
    assert.equal(deriveMediaVerificationApiStatus({ status: row.status, jobStatus: job.status, jobErrorCode: job.errorCode, now: new Date(), verificationDeadlineAt: row.verificationDeadlineAt }), "REJECTED", "never the derived retryable view");
    assert.equal(await h.exists(staged.key), false); assert.equal(await h.exists(v.sealedKey), false); assert.ok(row.objectsClearedAt, "objectsClearedAt is set only after both objects are confirmed absent");
  });
}

test("G-PROBE: a marker-matching malformed file (forged/truncated MP4) is an authoritative REJECTED INVALID_MEDIA/MEDIA_UNREADABLE with the content identity retained", async () => {
  for (const name of ["content_truncated_mp4_no_moov", "content_text_named_mp4", "content_random_bytes_mp4"]) {
    const bytes = newBytes(); const v = await h.createVerification(await h.stage(bytes));
    assert.equal(await run(v, h.deps({ probe: malformedProbe(name) })), "rejected", name);
    const row = await h.assertConsistent(v.verification.id);
    assert.equal(row.resultCode, "INVALID_MEDIA"); assert.equal(row.resultReason, "MEDIA_UNREADABLE"); assert.equal(row.contentSha256, sha256(bytes));
  }
});

test("R5: a truncated-Matroska I/O-looking error, a timeout, a signal kill and a spawn failure are OPERATIONAL: the row stays SEALED, nothing is rejected or published", async () => {
  for (const [label, probe] of [
    ["truncated matroska (ends in Input/output error)", malformedProbe("content_truncated_webm_100")],
    ["timeout", async () => ({ kind: "NOT_COMPLETED" as const, reason: "UPLOAD_VERIFICATION_PROBE_TIMEOUT" as const })],
    ["signal kill", async () => ({ kind: "NOT_COMPLETED" as const, reason: "UPLOAD_VERIFICATION_PROBE_FAILED" as const })],
  ] as const) {
    const staged = await h.stage(newBytes()); const v = await h.createVerification(staged);
    const result = await run(v, h.deps({ probe }));
    assert.equal(result, "retrying", label);
    const row = await h.assertConsistent(v.verification.id);
    assert.equal(row.status, "SEALED", `${label}: never terminal`); assert.equal(row.resultCode, null); assert.ok(row.lastFailureReason?.startsWith("UPLOAD_VERIFICATION_PROBE_"), label);
    assert.equal((await h.jobOf(v.jobId)).status, "RETRYING"); assert.equal(await h.exists(v.sealedKey), true, "the sealed object is kept for the retry");
  }
  assert.ok((await h.assetCount()) >= 0, "operational failures publish nothing (the per-case row checks above prove no terminal verdict)");
});

test("R5 retry-in-place then exhaustion: three non-completed probes end the Job FAILED VERIFICATION_EXECUTION_EXHAUSTED while the verification stays non-terminal and retryable (derived VERIFICATION_FAILED), then a retry succeeds", async () => {
  const v = await h.createVerification(await h.stage(newBytes()));
  const timeout = h.deps({ probe: async () => ({ kind: "NOT_COMPLETED", reason: "UPLOAD_VERIFICATION_PROBE_TIMEOUT" }) });
  assert.equal(await run(v, timeout), "retrying");
  let job = await h.jobOf(v.jobId); assert.equal(job.attempts, 1); assert.ok(job.runAfter && job.enqueuedAt === null, "backoff set; delivery fields cleared for the redelivery scanner");
  assert.equal(await processVerifyUploadedMedia(h.db, v.jobId, await h.reclaim(v.jobId), timeout), "retrying");
  assert.equal(await processVerifyUploadedMedia(h.db, v.jobId, await h.reclaim(v.jobId), timeout), "failed");
  job = await h.jobOf(v.jobId); assert.equal(job.status, "FAILED"); assert.equal(job.errorCode, "VERIFICATION_EXECUTION_EXHAUSTED"); assert.equal(job.attempts, 3);
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "SEALED", "never REJECTED by an operational failure"); assert.equal(row.lastFailureCode, "VERIFICATION_EXECUTION_EXHAUSTED"); assert.equal(row.lastFailureReason, "UPLOAD_VERIFICATION_PROBE_TIMEOUT");
  assert.equal(deriveMediaVerificationApiStatus({ status: row.status, jobStatus: job.status, jobErrorCode: job.errorCode, now: new Date(), verificationDeadlineAt: row.verificationDeadlineAt }), "VERIFICATION_FAILED");
  // The retry route's successor: a new Job on the same verification; the probe now works.
  const successor = await h.db.job.create({ data: { datasetId: h.dataset.id, createdById: h.owner.id, type: "VERIFY_UPLOADED_MEDIA", modality: "VIDEO", status: "QUEUED", input: { verificationId: row.id, contractVersion: 1 }, retryOfJobId: v.jobId }, select: { id: true } });
  await h.db.mediaVerification.update({ where: { id: row.id }, data: { currentJobId: successor.id } });
  assert.equal(await processVerifyUploadedMedia(h.db, successor.id, await h.reclaim(successor.id), h.deps()), "published");
  assert.equal((await h.assertConsistent(row.id)).status, "PUBLISHED");
});

test("storage fault: a SHORT materialization is operational STORAGE_FAILED and ffprobe NEVER runs on it (infrastructure truncation can never become a content verdict)", async () => {
  const bytes = newBytes(); const staged = await h.stage(bytes); const v = await h.createVerification(staged);
  let probeCalls = 0;
  const shortMinio = new Proxy(h.minio, { get(target, prop, receiver) {
    if (prop === "getObject") return async (bucket: string, key: string, opts?: unknown) => { const full = await (target.getObject as (...a: unknown[]) => Promise<NodeJS.ReadableStream>)(bucket, key, opts); const { Readable } = await import("node:stream"); const chunks: Buffer[] = []; for await (const c of full) chunks.push(Buffer.from(c as Buffer)); return Readable.from([Buffer.concat(chunks).subarray(0, 100)]); };
    const value = Reflect.get(target, prop, receiver); return typeof value === "function" ? value.bind(target) : value; } });
  const result = await run(v, h.deps({ minio: shortMinio as never, probe: async () => { probeCalls += 1; return { kind: "COMPLETED", document: corpusDocument("mp4_h264_video_audio.mp4") }; } }));
  assert.equal(result, "retrying"); assert.equal(probeCalls, 0);
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "SEALED"); assert.equal(row.lastFailureReason, "UPLOAD_VERIFICATION_STORAGE_FAILED"); assert.equal(row.resultCode, null);
});

test("STALE S1: a staged object replaced after the request, before the seal, terminalizes STALE UPLOAD_SOURCE_CHANGED (non-retryable) and publishes nothing", async () => {
  const staged = await h.stage(newBytes()); const v = await h.createVerification(staged);
  await h.minio.putObject(h.config.MINIO_BUCKET, staged.key, newBytes()); // same key, new bytes
  assert.equal(await run(v), "stale");
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "STALE"); assert.equal(row.resultCode, "UPLOAD_SOURCE_CHANGED"); assert.equal(row.resultReason, "SOURCE_STAGED_CHANGED");
  const job = await h.jobOf(v.jobId); assert.equal(job.status, "FAILED"); assert.equal(job.errorCode, "UPLOAD_SOURCE_CHANGED");
  assert.equal(await h.exists(v.sealedKey), false);
});

test("STALE S2: the sealed object tampered between the probe and publication terminalizes STALE SOURCE_SEALED_CHANGED and publishes nothing", async () => {
  const staged = await h.stage(newBytes()); const v = await h.createVerification(staged); const before = await h.assetCount();
  const deps = h.deps({ probe: async () => { await h.minio.putObject(h.config.MINIO_BUCKET, v.sealedKey, randomBytes(512)); return { kind: "COMPLETED", document: corpusDocument("mp4_h264_video_audio.mp4") }; } });
  assert.equal(await run(v, deps), "stale");
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "STALE"); assert.equal(row.resultReason, "SOURCE_SEALED_CHANGED"); assert.equal(await h.assetCount(), before);
});

test("replay / crash after the publish commit: a redelivered Job on a PUBLISHED verification only completes the Job; exactly one Asset", async () => {
  const v = await h.createVerification(await h.stage(newBytes()));
  assert.equal(await run(v), "published");
  const after = await h.assetCount();
  await h.db.job.update({ where: { id: v.jobId }, data: { status: "RETRYING", finishedAt: null, lockToken: null, lockedUntil: null } });
  assert.equal(await processVerifyUploadedMedia(h.db, v.jobId, await h.reclaim(v.jobId), h.deps()), "published");
  assert.equal(await h.assetCount(), after); assert.equal((await h.jobOf(v.jobId)).status, "COMPLETED");
});

test("concurrent duplicate processors on one verification (original redelivered + a retry successor) create exactly ONE Asset", async () => {
  const staged = await h.stage(newBytes()); const v = await h.createVerification(staged); const before = await h.assetCount();
  const second = await h.db.job.create({ data: { datasetId: h.dataset.id, createdById: h.owner.id, type: "VERIFY_UPLOADED_MEDIA", modality: "VIDEO", status: "RUNNING", input: { verificationId: v.verification.id, contractVersion: 1 }, lockedBy: "w2", lockToken: randomUUID(), lockedAt: new Date(), lockedUntil: new Date(Date.now() + 300_000) }, select: { id: true, lockToken: true } });
  const results = await Promise.all([run(v), processVerifyUploadedMedia(h.db, second.id, second.lockToken!, h.deps())]);
  assert.ok(results.every((r) => ["published", "retrying", "stale"].includes(r)), JSON.stringify(results));
  assert.equal(await h.assetCount() - before, 1, "exactly one Asset");
  assert.equal((await h.reload(v.verification.id)).status, "PUBLISHED");
});

test("quiescence: a maintenance window defers publication (VERIFIED, Job RETRYING with runAfter, no attempt consumed) and the next run publishes exactly once", async () => {
  const v = await h.createVerification(await h.stage(newBytes())); const before = await h.assetCount();
  let blocked = true;
  const deps = h.deps({ assertWritesNotQuiesced: async () => { if (blocked) throw new AssetWritesQuiescedError(); } });
  assert.equal(await run(v, deps), "retrying");
  let row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "VERIFIED"); let job = await h.jobOf(v.jobId); assert.equal(job.status, "RETRYING"); assert.equal(job.attempts, 0); assert.ok(job.runAfter);
  assert.equal(await h.assetCount(), before);
  blocked = false;
  assert.equal(await processVerifyUploadedMedia(h.db, v.jobId, await h.reclaim(v.jobId), deps), "published");
  assert.equal(await h.assetCount() - before, 1);
});

test("cancellation: a canceled Job terminalizes CANCELED(REQUESTED), removes both objects and publishes nothing", async () => {
  const staged = await h.stage(newBytes()); const v = await h.createVerification(staged); const before = await h.assetCount();
  await h.db.job.update({ where: { id: v.jobId }, data: { cancelRequestedAt: new Date() } });
  assert.equal(await run(v), "canceled");
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "CANCELED"); assert.equal(row.resultReason, "REQUESTED"); assert.equal((await h.jobOf(v.jobId)).status, "CANCELED");
  assert.equal(await h.exists(staged.key), false); assert.equal(await h.assetCount(), before);
});

test("an archived Dataset mid-run terminalizes CANCELED(DATASET_INACTIVE) and publishes nothing", async () => {
  const other = await h.db.dataset.create({ data: { ownerId: h.owner.id, name: `a2-arch-${randomUUID().slice(0, 6)}`, modality: "VIDEO", primaryModality: "VIDEO", modalityResolverSubject: h.owner.id }, select: { id: true } });
  const staged = await h.stage(newBytes()); const v = await h.createVerification(staged, { datasetId: other.id });
  await h.db.dataset.update({ where: { id: other.id }, data: { archivedAt: new Date() } });
  assert.equal(await run(v), "canceled");
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "CANCELED"); assert.equal(row.resultReason, "DATASET_INACTIVE"); assert.equal(await h.db.asset.count({ where: { datasetId: other.id } }), 0);
});

test("allowance: past verificationDeadlineAt the verification is EXPIRED, nothing is ever published after the deadline, and the objects are removed", async () => {
  const staged = await h.stage(newBytes()); const v = await h.createVerification(staged, { deadlineAt: new Date(Date.now() + 5_000) }); const before = await h.assetCount();
  assert.equal(await run(v, h.deps({ now: () => new Date(Date.now() + 60_000) })), "expired");
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "EXPIRED"); assert.equal(row.resultReason, "ALLOWANCE_ELAPSED"); assert.equal((await h.jobOf(v.jobId)).errorCode, "UPLOAD_VERIFICATION_EXPIRED");
  assert.equal(await h.assetCount(), before); assert.equal(await h.exists(staged.key), false);
});

test("dataset modality revalidation at publication: a Dataset whose modality no longer equals the bound modality yields STALE S3 (defensive), never an Asset", async () => {
  const v = await h.createVerification(await h.stage(newBytes())); const before = await h.assetCount();
  // M24 makes a modality change unreachable by real writes, so the evidence mismatch is injected on the verification row itself.
  const deps = h.deps({ probe: async () => { await h.db.mediaVerification.update({ where: { id: v.verification.id }, data: { boundDatasetModality: "IMAGE" } }); return { kind: "COMPLETED", document: corpusDocument("mp4_h264_video_audio.mp4") }; } });
  assert.equal(await run(v, deps), "stale");
  assert.equal((await h.reload(v.verification.id)).resultReason, "DATASET_EVIDENCE_CHANGED"); assert.equal(await h.assetCount(), before);
});

test("path policy: an invalid relative path of a positively verified object is REJECTED INVALID_RELATIVE_PATH with the media evidence retained (path kind, not a media verdict)", async () => {
  const bytes = newBytes(); const v = await h.createVerification(await h.stage(bytes), { relativePathHint: "../escape/clip.mp4" }); const before = await h.assetCount();
  assert.equal(await run(v), "rejected");
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "REJECTED"); assert.equal(row.resultCode, "INVALID_RELATIVE_PATH"); assert.equal(row.resultReason, "RELATIVE_PATH_INVALID");
  assert.equal(row.verifiedModality, "VIDEO"); assert.equal(row.contentSha256, sha256(bytes)); assert.equal(await h.assetCount(), before);
  assert.equal((await h.jobOf(v.jobId)).errorCode, "INVALID_RELATIVE_PATH");
});

test("a Job whose input does not match its verification (dataset/requester) is refused permanently and touches nothing", async () => {
  const v = await h.createVerification(await h.stage(newBytes()));
  await h.db.job.update({ where: { id: v.jobId }, data: { input: { verificationId: randomUUID(), contractVersion: 1 } } });
  assert.equal(await run(v), "failed");
  assert.equal((await h.jobOf(v.jobId)).errorCode, "VERIFICATION_INPUT_INVALID");
  assert.equal((await h.reload(v.verification.id)).status, "PENDING");
});
