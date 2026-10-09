import assert from "node:assert/strict";
import test from "node:test";

import {
  MEDIA_REASONS, MEDIA_VERIFICATION_ALLOWANCE_MS, MEDIA_VERIFICATION_MAX_NON_TERMINAL, MEDIA_VERIFICATION_STATUSES, MEDIA_VERIFICATION_TRANSITIONS, MediaVerificationNotEnabledError,
  NON_TERMINAL_STATUSES, PATH_REASONS, TERMINAL_STATUSES, assertMediaVerificationJobCreationAllowed, assertMediaVerificationTransition, canTransitionMediaVerification,
  deriveMediaVerificationApiStatus, isMediaVerificationEnabled, isMediaVerificationRetryEligible, mediaVerificationJobInputSchema, validateMediaVerificationRow,
  type MediaVerificationRowFacts, type MediaVerificationStatus,
} from "../src/media-verification.js";
import { ProviderConfigError, readVerifierMinioConfig } from "../src/provider-config.js";
import { logJobEvent } from "../src/log.js";

const id = "4f1a2c9e-8b7d-4e21-9a0f-6c3d5e7b9a10";
const now = new Date("2026-10-07T10:00:00Z");
const later = new Date(now.getTime() + 10 * 60_000);
const base: MediaVerificationRowFacts = { status: "PENDING", boundDatasetModality: "VIDEO", verificationDeadlineAt: later, stagedBucket: "b", stagedKey: "direct-uploads/x", stagedEtag: "e", stagedSizeBytes: 1n, stagedLastModified: now };
const sealed = { sealedKey: "verified-uploads/d/v/source", sealedEtag: "e2", sealedSizeBytes: 1n, sealedLastModified: now, sealedAt: now };
const verified = { ...sealed, contentSha256: "a".repeat(64), probe: { formatName: "mov,mp4,m4a,3gp,3g2,mj2" }, verifiedModality: "VIDEO", policyVersion: "premedia-verify.v2", processorVersion: "img+ffprobe", verifiedAt: now };

test("Job input is strictly { verificationId (uuid), contractVersion: 1 } and nothing else (never keys, URLs or credentials)", () => {
  assert.equal(mediaVerificationJobInputSchema.safeParse({ verificationId: id, contractVersion: 1 }).success, true);
  for (const bad of [{ verificationId: id }, { verificationId: id, contractVersion: 2 }, { verificationId: "not-a-uuid", contractVersion: 1 }, { verificationId: id, contractVersion: 1, key: "k" }, { verificationId: id, contractVersion: 1, url: "https://x" }, {}]) {
    assert.equal(mediaVerificationJobInputSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("the state machine has exactly the frozen eight statuses and only the frozen edges; terminal rows never change", () => {
  assert.deepEqual([...MEDIA_VERIFICATION_STATUSES].sort(), ["CANCELED", "EXPIRED", "PENDING", "PUBLISHED", "REJECTED", "SEALED", "STALE", "VERIFIED"]);
  assert.deepEqual([...NON_TERMINAL_STATUSES], ["PENDING", "SEALED", "VERIFIED"]);
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ["CANCELED", "EXPIRED", "PUBLISHED", "REJECTED", "STALE"]);
  assert.deepEqual(MEDIA_VERIFICATION_TRANSITIONS.PENDING, ["SEALED", "STALE", "CANCELED", "EXPIRED"]);
  assert.deepEqual(MEDIA_VERIFICATION_TRANSITIONS.SEALED, ["VERIFIED", "REJECTED", "STALE", "CANCELED", "EXPIRED"]);
  assert.deepEqual(MEDIA_VERIFICATION_TRANSITIONS.VERIFIED, ["PUBLISHED", "REJECTED", "STALE", "CANCELED", "EXPIRED"]);
  const allowed = new Set(Object.entries(MEDIA_VERIFICATION_TRANSITIONS).flatMap(([from, tos]) => tos.map(to => `${from}>${to}`)));
  for (const from of MEDIA_VERIFICATION_STATUSES) for (const to of MEDIA_VERIFICATION_STATUSES) assert.equal(canTransitionMediaVerification(from, to), allowed.has(`${from}>${to}`), `${from}>${to}`);
  for (const terminal of TERMINAL_STATUSES) for (const to of MEDIA_VERIFICATION_STATUSES) assert.equal(canTransitionMediaVerification(terminal, to), false);
  assert.equal(canTransitionMediaVerification("PENDING", "VERIFIED"), false, "no skipping the seal");
  assert.equal(canTransitionMediaVerification("PENDING", "PUBLISHED"), false, "nothing publishes without a verified decision");
  assert.equal(canTransitionMediaVerification("PENDING", "REJECTED"), false, "a rejection needs a completed probe, so it cannot leave PENDING");
  assert.throws(() => assertMediaVerificationTransition("PUBLISHED", "SEALED"), { message: "MEDIA_VERIFICATION_TRANSITION_REFUSED" });
});

test("limits are the frozen constants", () => {
  assert.equal(MEDIA_VERIFICATION_ALLOWANCE_MS, 30 * 60_000);
  assert.equal(MEDIA_VERIFICATION_MAX_NON_TERMINAL, 50);
});

test("field/state consistency follows the section 4 table for every status", () => {
  assert.deepEqual(validateMediaVerificationRow(base), { ok: true });
  assert.deepEqual(validateMediaVerificationRow({ ...base, status: "SEALED", ...sealed }), { ok: true });
  assert.deepEqual(validateMediaVerificationRow({ ...base, status: "VERIFIED", ...verified }), { ok: true });
  assert.deepEqual(validateMediaVerificationRow({ ...base, status: "PUBLISHED", ...verified, assetId: "a1", publishedAt: now, finishedAt: now }), { ok: true });
  assert.deepEqual(validateMediaVerificationRow({ ...base, status: "REJECTED", ...sealed, contentSha256: "a".repeat(64), probe: {}, resultCode: "UNSUPPORTED_MEDIA", resultReason: "CONTAINER_UNSUPPORTED", finishedAt: now }), { ok: true });
  for (const status of ["STALE", "CANCELED", "EXPIRED"] as const) assert.deepEqual(validateMediaVerificationRow({ ...base, status, resultCode: "X", resultReason: "REQUESTED", finishedAt: now }), { ok: true }, status);
  const bad = (row: MediaVerificationRowFacts) => { const out = validateMediaVerificationRow(row); return out.ok ? [] : out.violations; };
  assert.ok(bad({ ...base, sealedKey: "k" }).includes("sealedKey:MUST_BE_NULL"), "PENDING has no sealed identity");
  assert.ok(bad({ ...base, status: "SEALED" }).includes("sealedKey:REQUIRED"));
  assert.ok(bad({ ...base, status: "VERIFIED", ...verified, verifiedModality: "AUDIO" }).includes("verifiedModality:MUST_EQUAL_boundDatasetModality"), "VERIFIED means positively verified AS the bound modality");
  assert.ok(bad({ ...base, status: "VERIFIED", ...verified, assetId: "a" }).includes("assetId:MUST_BE_NULL"));
  assert.ok(bad({ ...base, status: "PUBLISHED", ...verified }).includes("assetId:REQUIRED"));
  assert.ok(bad({ ...base, status: "STALE", resultCode: "UPLOAD_SOURCE_CHANGED", resultReason: "SOURCE_STAGED_CHANGED", finishedAt: now, assetId: "a" }).includes("assetId:MUST_BE_NULL"));
});

test("REJECTED has two distinct kinds that are never conflated; a media rejection requires a completed probe", () => {
  const media = { ...base, status: "REJECTED" as const, ...sealed, resultCode: "UNSUPPORTED_MEDIA", finishedAt: now };
  const out = (row: MediaVerificationRowFacts) => { const r = validateMediaVerificationRow(row); return r.ok ? [] : r.violations; };
  assert.ok(out({ ...media, resultReason: "CONTAINER_UNSUPPORTED" }).includes("probe:REQUIRED"), "no completed probe => not an authoritative rejection (R5)");
  assert.ok(out({ ...media, resultReason: "RELATIVE_PATH_INVALID", probe: {}, contentSha256: "a".repeat(64) }).includes("resultReason:MUST_BE_A_MEDIA_REASON"), "a path reason is not a media verdict");
  const path = { ...base, status: "REJECTED" as const, ...verified, resultCode: "INVALID_RELATIVE_PATH", resultReason: "RELATIVE_PATH_INVALID", finishedAt: now };
  assert.deepEqual(validateMediaVerificationRow(path), { ok: true }, "the path refusal retains the positive media evidence and verifiedModality");
  assert.ok(out({ ...path, resultReason: "CODEC_UNSUPPORTED" }).includes("resultReason:MUST_BE_A_PATH_REASON"));
  assert.ok(out({ ...path, verifiedModality: null }).includes("verifiedModality:REQUIRED"));
  assert.ok(!(MEDIA_REASONS as readonly string[]).includes("RELATIVE_PATH_INVALID") && (PATH_REASONS as readonly string[]).includes("RELATIVE_PATH_INVALID"));
});

test("operational failure never changes status: retry eligibility and the derived VERIFICATION_FAILED view follow section 9/10", () => {
  const args = (errorCode: string | null, status: MediaVerificationStatus = "SEALED", at = now) => ({ errorCode, verificationStatus: status, now: at, verificationDeadlineAt: later });
  for (const code of ["VERIFICATION_INFRASTRUCTURE_FAILED", "VERIFICATION_EXECUTION_EXHAUSTED", "RECOVERY_EXHAUSTED", "MAX_RUNTIME_EXCEEDED"]) assert.equal(isMediaVerificationRetryEligible(args(code)), true, code);
  for (const code of ["UNSUPPORTED_MEDIA", "UPLOAD_SOURCE_CHANGED", "UPLOAD_VERIFICATION_EXPIRED", "INVALID_RELATIVE_PATH", null]) assert.equal(isMediaVerificationRetryEligible(args(code)), false, String(code));
  assert.equal(isMediaVerificationRetryEligible(args("VERIFICATION_EXECUTION_EXHAUSTED", "REJECTED")), false, "terminal rows never retry");
  assert.equal(isMediaVerificationRetryEligible(args("VERIFICATION_EXECUTION_EXHAUSTED", "SEALED", later)), false, "at the deadline retry is over (the row expires)");
  const view = (status: MediaVerificationStatus, jobStatus: string | null, jobErrorCode: string | null, at = now) => deriveMediaVerificationApiStatus({ status, jobStatus, jobErrorCode, now: at, verificationDeadlineAt: later });
  assert.equal(view("PENDING", "QUEUED", null), "PENDING");
  assert.equal(view("SEALED", "RUNNING", null), "VERIFYING");
  assert.equal(view("VERIFIED", "RUNNING", null), "VERIFYING");
  assert.equal(view("SEALED", "FAILED", "VERIFICATION_EXECUTION_EXHAUSTED"), "VERIFICATION_FAILED");
  assert.equal(view("SEALED", "FAILED", "VERIFICATION_EXECUTION_EXHAUSTED", later), "VERIFYING", "after the deadline the derived failure view ends (the scanner expires the row)");
  assert.equal(view("REJECTED", "FAILED", "UNSUPPORTED_MEDIA"), "REJECTED", "a deterministic rejection is never shown as an operational failure");
  assert.equal(view("PUBLISHED", "COMPLETED", null), "PUBLISHED");
});

test("RELEASE GUARD: verification Job creation is refused unless explicitly enabled, and the guard is off by default", () => {
  assert.equal(isMediaVerificationEnabled({} as NodeJS.ProcessEnv), false);
  for (const value of [undefined, "", "0", "true", "yes", "enabled"]) assert.throws(() => assertMediaVerificationJobCreationAllowed({ MEDIA_VERIFICATION_ENABLED: value } as NodeJS.ProcessEnv), MediaVerificationNotEnabledError);
  assert.doesNotThrow(() => assertMediaVerificationJobCreationAllowed({ MEDIA_VERIFICATION_ENABLED: "1" } as NodeJS.ProcessEnv));
});

test("verifier MinIO configuration: absent => null; partial, short or equal-to-the-general-identity => a variable-name-only error; no value in any message", () => {
  assert.equal(readVerifierMinioConfig({} as NodeJS.ProcessEnv), null);
  assert.deepEqual(readVerifierMinioConfig({ MINIO_VERIFIER_ACCESS_KEY: "ver-key", MINIO_VERIFIER_SECRET_KEY: "ver-secret-123", MINIO_ACCESS_KEY: "worker", MINIO_SECRET_KEY: "worker-secret" } as NodeJS.ProcessEnv), { accessKey: "ver-key", secretKey: "ver-secret-123" });
  const secretValue = "super-secret-value-123";
  const cases: Array<[Record<string, string>, string[]]> = [
    [{ MINIO_VERIFIER_ACCESS_KEY: "ver-key" }, ["MINIO_VERIFIER_SECRET_KEY"]],
    [{ MINIO_VERIFIER_SECRET_KEY: secretValue }, ["MINIO_VERIFIER_ACCESS_KEY"]],
    [{ MINIO_VERIFIER_ACCESS_KEY: "ver-key", MINIO_VERIFIER_SECRET_KEY: "short" }, ["MINIO_VERIFIER_SECRET_KEY"]],
    [{ MINIO_VERIFIER_ACCESS_KEY: "worker", MINIO_VERIFIER_SECRET_KEY: secretValue, MINIO_ACCESS_KEY: "worker", MINIO_SECRET_KEY: "x-other-secret" }, ["MINIO_VERIFIER_ACCESS_KEY"]],
    [{ MINIO_VERIFIER_ACCESS_KEY: "ver-key", MINIO_VERIFIER_SECRET_KEY: secretValue, MINIO_ACCESS_KEY: "worker", MINIO_SECRET_KEY: secretValue }, ["MINIO_VERIFIER_SECRET_KEY"]],
  ];
  for (const [env, variables] of cases) {
    try { readVerifierMinioConfig(env as unknown as NodeJS.ProcessEnv); assert.fail("expected a ProviderConfigError"); } catch (error) {
      assert.ok(error instanceof ProviderConfigError);
      assert.deepEqual((error as ProviderConfigError).invalidVariables, variables);
      assert.equal(error.message.includes(secretValue) || error.message.includes("ver-key"), false, "no credential value in the message");
    }
  }
});

test("the logging sink refuses verifier credential field names outside production (redaction) and redacts them in production", () => {
  const original = process.env.NODE_ENV;
  const captured: string[] = []; const originalInfo = console.info; console.info = (line: string) => { captured.push(line); };
  try {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    assert.throws(() => logJobEvent("X", { jobId: "j", MINIO_VERIFIER_SECRET_KEY: "v" } as never), /disallowed key/);
    assert.throws(() => logJobEvent("X", { jobId: "j", MINIO_VERIFIER_ACCESS_KEY: "v" } as never), /disallowed key/);
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    logJobEvent("X", { jobId: "j", MINIO_VERIFIER_SECRET_KEY: "leakme" } as never);
    assert.equal(captured.some(line => line.includes("leakme")), false);
    assert.ok(captured.some(line => line.includes("[REDACTED]")));
  } finally { console.info = originalInfo; (process.env as Record<string, string | undefined>).NODE_ENV = original; }
});

import { MEDIA_VERIFICATION_RETRY_BACKOFF_MS, a2SourceFingerprintInput, buildSealedKey, containerMimeType, isMediaVerificationEligible, nextRetryDelayMs } from "../src/media-verification.js";

test("eligibility: only a VIDEO Dataset with a declared video/mp4 or video/webm is eligible; the declared type never decides the class", () => {
  assert.equal(isMediaVerificationEligible({ declaredContentType: "video/mp4", datasetModality: "VIDEO" }), true);
  assert.equal(isMediaVerificationEligible({ declaredContentType: "video/webm", datasetModality: "VIDEO" }), true);
  for (const declared of ["audio/ogg", "audio/mpeg", "audio/wav", "image/png", "text/plain", "application/octet-stream", "video/quicktime", "video/x-matroska"]) assert.equal(isMediaVerificationEligible({ declaredContentType: declared, datasetModality: "VIDEO" }), false, declared);
  for (const modality of ["IMAGE", "AUDIO", "TEXT", null]) assert.equal(isMediaVerificationEligible({ declaredContentType: "video/mp4", datasetModality: modality }), false, String(modality));
});

test("sealed key is deterministic, under the sealed prefix, and refuses path-shaped input", () => {
  assert.equal(buildSealedKey("ds1", id), `verified-uploads/ds1/${id}/source`);
  assert.equal(buildSealedKey("ds1", id), buildSealedKey("ds1", id));
  for (const bad of ["../x", "a/b", "", "a b", "x".repeat(65)]) assert.throws(() => buildSealedKey(bad, id), { message: "SEALED_KEY_INPUT_INVALID" });
  assert.throws(() => buildSealedKey("ds1", "a/../b"), { message: "SEALED_KEY_INPUT_INVALID" });
});

test("container MIME is derived from the probed container only", () => {
  assert.equal(containerMimeType("mov,mp4,m4a,3gp,3g2,mj2"), "video/mp4");
  assert.equal(containerMimeType("matroska,webm"), "video/webm");
  for (const other of ["ogg", "avi", "mpegts", "image2", "gif", "", null, undefined, "matroska", "webm", "mp4"]) assert.equal(containerMimeType(other as string | null), null, String(other));
});

test("source fingerprint input and retry backoff are stable and bounded", () => {
  assert.equal(a2SourceFingerprintInput("verified-uploads/d/v/source", "f".repeat(64)), `a2v1:verified-uploads/d/v/source:${"f".repeat(64)}`);
  assert.equal(nextRetryDelayMs(1), MEDIA_VERIFICATION_RETRY_BACKOFF_MS[0]);
  assert.equal(nextRetryDelayMs(2), MEDIA_VERIFICATION_RETRY_BACKOFF_MS[1]);
  assert.equal(nextRetryDelayMs(99), MEDIA_VERIFICATION_RETRY_BACKOFF_MS[1]);
  assert.equal(nextRetryDelayMs(0), MEDIA_VERIFICATION_RETRY_BACKOFF_MS[0]);
});

import { IMPORT_VERIFICATION_TAIL_CAP_MS, importVerificationTailEnd } from "../src/media-verification.js";

test("folder tail: no verification -> plain deadline governs; otherwise the latest allowance, hard-capped at deadlineAt + 30 minutes", () => {
  const deadlineAt = new Date("2026-10-07T10:00:00Z");
  assert.equal(importVerificationTailEnd({ deadlineAt, verificationDeadlines: [] }), null);
  const inside = new Date(deadlineAt.getTime() + 10 * 60_000);
  assert.deepEqual(importVerificationTailEnd({ deadlineAt, verificationDeadlines: [new Date(deadlineAt.getTime() - 5 * 60_000), inside] }), inside);
  assert.deepEqual(importVerificationTailEnd({ deadlineAt, verificationDeadlines: [new Date(deadlineAt.getTime() + 3 * 3_600_000)] }), new Date(deadlineAt.getTime() + IMPORT_VERIFICATION_TAIL_CAP_MS));
  assert.equal(IMPORT_VERIFICATION_TAIL_CAP_MS, MEDIA_VERIFICATION_ALLOWANCE_MS);
});
