import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { deriveTextSourceReadiness } from "../../src/lib/annotations/text-source-readiness.js";

const noJob = null;
const objectOnlyAsset = { storageBucket: "bucket", storageKey: "key" };
const noObjectAsset = { storageBucket: null, storageKey: null };

test("prepared TextAsset with no live reverification is READY", () => {
  assert.equal(
    deriveTextSourceReadiness({ asset: objectOnlyAsset, textAsset: { sourceIdentity: "sha256:a", content: null }, latestPrepareJob: noJob }),
    "READY",
  );
});

test("a live reverification mismatch overrides an otherwise-prepared asset", () => {
  const base = { asset: objectOnlyAsset, textAsset: { sourceIdentity: "sha256:a", content: null }, latestPrepareJob: noJob };
  assert.equal(deriveTextSourceReadiness({ ...base, reverification: { kind: "mismatch" } }), "SOURCE_MISMATCH");
  assert.equal(deriveTextSourceReadiness({ ...base, reverification: { kind: "unavailable" } }), "UNAVAILABLE");
  assert.equal(deriveTextSourceReadiness({ ...base, reverification: { kind: "invalid_encoding" } }), "INVALID_ENCODING");
  assert.equal(deriveTextSourceReadiness({ ...base, reverification: { kind: "oversized" } }), "UNSUPPORTED_SIZE");
  assert.equal(deriveTextSourceReadiness({ ...base, reverification: { kind: "matched" } }), "READY");
});

test("an unprepared object-only asset with a running Job is PREPARING", () => {
  for (const status of ["QUEUED", "RUNNING", "RETRYING", "CANCELING"] as const) {
    assert.equal(
      deriveTextSourceReadiness({ asset: objectOnlyAsset, textAsset: null, latestPrepareJob: { status, errorCode: null } }),
      "PREPARING",
    );
  }
});

test("a failed prepare Job maps its allowlisted error code to the matching readiness state", () => {
  const withError = (errorCode: string) => deriveTextSourceReadiness({ asset: objectOnlyAsset, textAsset: null, latestPrepareJob: { status: "FAILED" as const, errorCode } });
  assert.equal(withError("TEXT_SOURCE_INVALID_ENCODING"), "INVALID_ENCODING");
  assert.equal(withError("TEXT_SOURCE_OVERSIZED_BYTES"), "UNSUPPORTED_SIZE");
  assert.equal(withError("TEXT_SOURCE_OVERSIZED_CODE_UNITS"), "UNSUPPORTED_SIZE");
  assert.equal(withError("TEXT_SOURCE_STALE"), "SOURCE_MISMATCH");
});

test("a failed prepare Job with TEXT_SOURCE_MISSING or an unrecognized code falls through to object/legacy classification instead of guessing", () => {
  assert.equal(
    deriveTextSourceReadiness({ asset: objectOnlyAsset, textAsset: null, latestPrepareJob: { status: "FAILED", errorCode: "TEXT_SOURCE_MISSING" } }),
    "UNPREPARED",
  );
  assert.equal(
    deriveTextSourceReadiness({ asset: objectOnlyAsset, textAsset: null, latestPrepareJob: { status: "FAILED", errorCode: "SOME_UNKNOWN_CODE" } }),
    "UNPREPARED",
  );
});

test("no object and no legacy content is UNAVAILABLE; no object with legacy content requires explicit reconciliation", () => {
  assert.equal(deriveTextSourceReadiness({ asset: noObjectAsset, textAsset: null, latestPrepareJob: noJob }), "UNAVAILABLE");
  assert.equal(
    deriveTextSourceReadiness({ asset: noObjectAsset, textAsset: { sourceIdentity: null, content: "legacy text" }, latestPrepareJob: noJob }),
    "LEGACY_RECONCILIATION_REQUIRED",
  );
});

test("an object with no prior Job and not yet prepared is UNPREPARED, never silently READY", () => {
  assert.equal(deriveTextSourceReadiness({ asset: objectOnlyAsset, textAsset: null, latestPrepareJob: noJob }), "UNPREPARED");
  assert.equal(
    deriveTextSourceReadiness({ asset: objectOnlyAsset, textAsset: { sourceIdentity: null, content: null }, latestPrepareJob: noJob }),
    "UNPREPARED",
  );
});
