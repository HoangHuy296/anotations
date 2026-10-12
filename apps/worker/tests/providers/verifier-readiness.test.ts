import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: constructing a MinIO client does not connect).
import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderConfig } from "@annotationplatform/domain/provider-config";

import { assertVerifierReadinessWhenEnabled } from "../../src/providers/verifier-readiness.js";

const config = { MINIO_ENDPOINT: "http://127.0.0.1:9", MINIO_ACCESS_KEY: "general-access", MINIO_SECRET_KEY: "general-secret-1", MINIO_BUCKET: "bucket" } as ProviderConfig;
const env = (extra: Record<string, string>) => ({ ...extra }) as NodeJS.ProcessEnv;

test("verifier readiness is not required while media verification is disabled (the default), whatever the verifier variables say", () => {
  assert.equal(assertVerifierReadinessWhenEnabled(config, env({})), "NOT_REQUIRED");
  assert.equal(assertVerifierReadinessWhenEnabled(config, env({ MEDIA_VERIFICATION_ENABLED: "0" })), "NOT_REQUIRED");
  assert.equal(assertVerifierReadinessWhenEnabled(config, env({ MINIO_VERIFIER_ACCESS_KEY: "x" })), "NOT_REQUIRED");
});

test("when enabled, a missing, partial or non-distinct verifier identity fails closed and never falls back to the general identity", () => {
  assert.throws(() => assertVerifierReadinessWhenEnabled(config, env({ MEDIA_VERIFICATION_ENABLED: "1" })), { message: "SEALED_OWNER_UNAVAILABLE" });
  assert.throws(() => assertVerifierReadinessWhenEnabled(config, env({ MEDIA_VERIFICATION_ENABLED: "1", MINIO_VERIFIER_ACCESS_KEY: "ver-access" })), { message: "SEALED_OWNER_CREDENTIALS_PARTIAL" });
  assert.throws(() => assertVerifierReadinessWhenEnabled(config, env({ MEDIA_VERIFICATION_ENABLED: "1", MINIO_VERIFIER_ACCESS_KEY: "general-access", MINIO_VERIFIER_SECRET_KEY: "another-secret-9" })), { message: "SEALED_OWNER_NOT_DISTINCT" });
  assert.equal(assertVerifierReadinessWhenEnabled(config, env({ MEDIA_VERIFICATION_ENABLED: "1", MINIO_VERIFIER_ACCESS_KEY: "ver-access", MINIO_VERIFIER_SECRET_KEY: "ver-secret-123" })), "READY");
});
