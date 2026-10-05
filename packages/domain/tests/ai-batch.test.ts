import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_BATCH_VERIFIED_MAX_ASSETS,
  AI_PROVIDER_REASON_CODES,
  AiSourceIdentityUnavailableError,
  aiBatchJobInputV1Schema,
  classifyAiProviderStatus,
  computeAiSourceIdentityDigest,
  effectiveAiBatchLimit,
  isAiProviderReasonCode,
  isDefinitelyNotSubmitted,
  reconcileAiOutcomes,
  selectAiSourceObject,
  safeAiProviderMessage,
  sanitizeAiProviderFailure,
  type AiBatchTarget,
} from "../src/ai-batch.js";

const digest = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
const target = (i: number): AiBatchTarget => ({ assetId: `a${i}`, inputIndex: i, sourceIdentityDigest: digest(i) });
const base = { schemaVersion: 1 as const, targetMode: "EXPLICIT" as const, datasetId: "d1", modality: "IMAGE" as const, modelId: "m1", modelKey: "k1", confidence_threshold: 0.5, iou_threshold: 0.5, effectiveLimit: 3 };

test("effective limit is the lower of the platform ceiling and the provider-verified size, never 200 by default", () => {
  assert.equal(AI_BATCH_VERIFIED_MAX_ASSETS, 3);
  assert.equal(effectiveAiBatchLimit(), 3);
  assert.equal(effectiveAiBatchLimit(200, 500), 200);
  assert.equal(effectiveAiBatchLimit(2, 3), 2);
});

test("accepted input requires bounded, unique, ordered targets and finite thresholds", () => {
  assert.equal(aiBatchJobInputV1Schema.safeParse({ ...base, targets: [target(0), target(1)] }).success, true);
  assert.equal(aiBatchJobInputV1Schema.safeParse({ ...base, targets: [] }).success, false, "empty");
  assert.equal(aiBatchJobInputV1Schema.safeParse({ ...base, targets: [target(0), target(1), target(2), target(3)] }).success, false, "over the effective limit");
  assert.equal(aiBatchJobInputV1Schema.safeParse({ ...base, targets: [target(0), { ...target(1), assetId: "a0" }] }).success, false, "duplicate asset");
  assert.equal(aiBatchJobInputV1Schema.safeParse({ ...base, targets: [target(1), target(0)] }).success, false, "index must equal position");
  assert.equal(aiBatchJobInputV1Schema.safeParse({ ...base, confidence_threshold: 1.5, targets: [target(0)] }).success, false);
  assert.equal(aiBatchJobInputV1Schema.safeParse({ ...base, confidence_threshold: Number.NaN, targets: [target(0)] }).success, false);
  assert.equal(aiBatchJobInputV1Schema.safeParse({ ...base, targets: [{ ...target(0), url: "https://x" }] }).success, false, "no raw locator or url field");
});

test("source identity digest needs fingerprint, size and locator but not a checksum; it changes with the source and never embeds the locator", () => {
  const parts = { sourceFingerprint: "fp", currentVersionId: null, sourceRevision: null, sizeBytes: 10n, checksum: null, cacheChecksum: null, objectLocator: { bucket: "b", key: "secret/key.jpg" } };
  const a = computeAiSourceIdentityDigest(parts);
  assert.match(a, /^sha256:[a-f0-9]{64}$/);
  assert.equal(computeAiSourceIdentityDigest({ ...parts }), a, "deterministic");
  assert.notEqual(computeAiSourceIdentityDigest({ ...parts, sizeBytes: 11n }), a);
  assert.notEqual(computeAiSourceIdentityDigest({ ...parts, checksum: "c" }), a);
  assert.notEqual(computeAiSourceIdentityDigest({ ...parts, objectLocator: { bucket: "b", key: "other.jpg" } }), a);
  assert.ok(!a.includes("secret"));
  for (const [override, reason] of [[{ sourceFingerprint: "" }, "FINGERPRINT_MISSING"], [{ sizeBytes: null }, "SIZE_MISSING"], [{ objectLocator: null }, "LOCATOR_MISSING"]] as const) {
    assert.throws(() => computeAiSourceIdentityDigest({ ...parts, ...override }), (error) => error instanceof AiSourceIdentityUnavailableError && error.reason === reason);
  }
});

test("outcomes reconcile exactly to the accepted targets; explicit zero success differs from a missing result (D-I2)", () => {
  const targets = [target(0), target(1), target(2)];
  const ok = (i: number, count: number) => ({ assetId: `a${i}`, inputIndex: i, outcome: "SUCCEEDED" as const, predictionCount: count });
  assert.deepEqual(reconcileAiOutcomes(targets, [ok(0, 2), ok(1, 0), ok(2, 1)]), { total: 3, processed: 3, succeeded: 3, failed: 0, skipped: 0, canceled: 0, missing: 0, aggregate: "COMPLETED" });
  const withMissing = reconcileAiOutcomes(targets, [ok(0, 1), ok(1, 0), { assetId: "a2", inputIndex: 2, outcome: "MISSING_RESULT", predictionCount: 0 }]);
  assert.equal(withMissing.aggregate, "FAILED");
  assert.equal(withMissing.succeeded, 2);
  assert.equal(reconcileAiOutcomes(targets, [ok(0, 1), { assetId: "a1", inputIndex: 1, outcome: "SKIPPED", predictionCount: 0, reason: "WORKFLOW_FROZEN" }, ok(2, 1)]).aggregate, "FAILED", "a skipped target makes the operation FAILED, also for one Asset");
  assert.equal(reconcileAiOutcomes([target(0)], [{ assetId: "a0", inputIndex: 0, outcome: "SKIPPED", predictionCount: 0, reason: "WORKFLOW_FROZEN" }]).aggregate, "FAILED");
  assert.equal(reconcileAiOutcomes(targets, [ok(0, 1)]).aggregate, "PENDING", "never terminal with unaccounted targets");
  assert.throws(() => reconcileAiOutcomes(targets, [ok(0, 1), ok(0, 1)]), /DUPLICATE/);
  assert.throws(() => reconcileAiOutcomes(targets, [{ ...ok(9, 1), assetId: "zz" }]), /UNKNOWN/);
  assert.equal(reconcileAiOutcomes(targets, [ok(0, 1), { assetId: "a1", inputIndex: 1, outcome: "CANCELED", predictionCount: 0 }, { assetId: "a2", inputIndex: 2, outcome: "CANCELED", predictionCount: 0 }]).aggregate, "CANCELED");
});

test("provider status allowlist: failed_system is degraded (not terminal, not success); unknown fails closed (D-FS)", () => {
  assert.deepEqual(["create", "pending", "inprocess", "success", "failed", "failed_system", "weird", undefined, 5].map(classifyAiProviderStatus),
    ["PENDING", "PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "DEGRADED", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
});

test("failure sanitizer maps structural facts to allowlisted codes and never accepts error text (D-SAN)", () => {
  assert.equal(sanitizeAiProviderFailure({ httpStatus: 422 }), "AI_PROVIDER_REJECTED");
  assert.equal(sanitizeAiProviderFailure({ httpStatus: 503 }), "AI_PROVIDER_UNAVAILABLE");
  assert.equal(sanitizeAiProviderFailure({ timedOut: true }), "AI_PROVIDER_UNAVAILABLE");
  assert.equal(sanitizeAiProviderFailure({ providerStatus: "failed" }), "AI_PROVIDER_FAILED");
  assert.equal(sanitizeAiProviderFailure({ providerStatus: "failed_system" }), "AI_PROVIDER_FAILED_SYSTEM");
  assert.equal(sanitizeAiProviderFailure({ providerStatus: "???" }), "AI_PROVIDER_STATUS_UNKNOWN");
  // A provider error string containing a signed URL (recorded evidence shape) has no path into the output.
  const leak = "Failed to access URL http://10.0.0.1:9000/b/k.jpg?X-Amz-Signature=abc: 404";
  for (const code of AI_PROVIDER_REASON_CODES) {
    assert.ok(isAiProviderReasonCode(code));
    assert.ok(!/X-Amz|https?:\/\/|10\.0\.0/.test(safeAiProviderMessage(code)));
  }
  assert.equal(isAiProviderReasonCode(leak), false);
  assert.ok(!JSON.stringify(sanitizeAiProviderFailure({ providerStatus: "failed" })).includes("Amz"));
});

test("source object selection prefers the stored MinIO object and only uses an unexpired CACHED object otherwise", () => {
  const none = { storageProvider: null, storageBucket: null, storageKey: null, cacheProvider: null, cacheBucket: null, cacheKey: null, cacheStatus: null, cacheExpiresAt: null };
  const now = new Date("2026-01-01T00:00:00Z");
  assert.deepEqual(selectAiSourceObject({ ...none, storageProvider: "MINIO", storageBucket: "b", storageKey: "k" }, now), { bucket: "b", key: "k" });
  const cache = { ...none, cacheProvider: "MINIO", cacheBucket: "cb", cacheKey: "ck", cacheStatus: "CACHED" };
  assert.deepEqual(selectAiSourceObject(cache, now), { bucket: "cb", key: "ck" });
  assert.equal(selectAiSourceObject({ ...cache, cacheExpiresAt: new Date("2025-12-31T00:00:00Z") }, now), null, "expired cache");
  assert.equal(selectAiSourceObject({ ...cache, cacheStatus: "NOT_CACHED" }, now), null);
  assert.equal(selectAiSourceObject(none, now), null);
  assert.deepEqual(selectAiSourceObject({ ...cache, storageProvider: "MINIO", storageBucket: "b", storageKey: "k" }, now), { bucket: "b", key: "k" }, "stored wins");
});

test("only definitely-unsubmitted operations are retry candidates; ambiguous or externally-recorded ones are not (D-NI)", () => {
  const reserved = { aiozSubmission: { version: 1 } };
  assert.equal(isDefinitelyNotSubmitted({ externalTaskId: null, summary: {}, errorCode: "AIOZ_SOURCE_CHANGED" }), true, "dispatch-time failure, no reservation");
  assert.equal(isDefinitelyNotSubmitted({ externalTaskId: null, summary: reserved, errorCode: "AIOZ_HTTP_4XX" }), true, "definite provider refusal");
  for (const errorCode of ["AIOZ_HTTP_5XX", "AIOZ_TIMEOUT", "AIOZ_NETWORK_ERROR", "AIOZ_INVALID_RESPONSE", null]) {
    assert.equal(isDefinitelyNotSubmitted({ externalTaskId: null, summary: reserved, errorCode }), false, `ambiguous: ${errorCode}`);
  }
  assert.equal(isDefinitelyNotSubmitted({ externalTaskId: "ext", summary: {}, errorCode: "AI_TASK_TIMEOUT" }), false, "an external task exists");
  assert.equal(isDefinitelyNotSubmitted({ externalTaskId: null, summary: null, errorCode: null }), true);
});
