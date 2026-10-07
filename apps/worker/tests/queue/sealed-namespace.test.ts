import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database or object store is opened).
import assert from "node:assert/strict";
import test from "node:test";

import type { Client as MinioClient } from "minio";

import { BucketNotProvisionedError, ensureBucket, legacyAppAdminAllowed, probeMinioProvisioning } from "../../src/providers/minio.js";
import {
  SEALED_PREFIX, SealedNamespaceError, assertNoSealedWriteAuthority, assertSealedOwnerReady, classifyStorageKey, createSealedOwnerMinio, readSealedOwnerCredentials, routeSealedDeletes,
} from "../../src/providers/sealed-namespace.js";

// A2 / R9-M1 (S0): offline proofs of the application-side storage boundary. The real-MinIO proofs (IAM denials, routing through the scanner) are in
// scripts/db-safety/minio-authority-s0.mjs. Fakes record calls; no secret value appears in any assertion message.

const config = { MINIO_ENDPOINT: "http://127.0.0.1:9", MINIO_ACCESS_KEY: "general-key", MINIO_SECRET_KEY: "general-secret-value", MINIO_BUCKET: "b" } as never;
function fake(name: string, calls: string[], overrides: Record<string, unknown> = {}) {
  return {
    removeObject: async (_bucket: string, key: string) => { calls.push(`${name}.removeObject:${key}`); },
    removeObjects: async (_bucket: string, keys: Array<string | { name: string }>) => { calls.push(`${name}.removeObjects:${keys.map((k) => (typeof k === "string" ? k : k.name)).join(",")}`); },
    statObject: async () => ({ size: 1 }),
    ...overrides,
  } as unknown as MinioClient;
}

test("key classification is literal and conservative: only the exact sealed prefix is SEALED; look-alikes and malformed keys are INVALID, never GENERAL-by-accident", () => {
  assert.equal(classifyStorageKey(`${SEALED_PREFIX}ds/v/source`), "SEALED");
  assert.equal(classifyStorageKey("verified-uploads/"), "SEALED");
  for (const key of ["direct-uploads/a", "prepared-imports/a/b", "exports/x.json", "verified-uploadsX/a", "xverified-uploads/a", "a/verified-uploads/b", "visualization/a/b.png"]) assert.equal(classifyStorageKey(key), "GENERAL", key);
  for (const key of ["Verified-Uploads/a", "VERIFIED-UPLOADS/a", "/verified-uploads/a", "verified-uploads//a", "verified-uploads/../direct-uploads/a", "direct-uploads/../verified-uploads/a", "./verified-uploads/a", "verified-uploads/./a", "a\\b", "a\u0000b", "a\nb", "", " ".repeat(2000)]) assert.equal(classifyStorageKey(key), "INVALID", JSON.stringify(key).slice(0, 40));
  for (const key of [undefined, null, 5, {}, ["verified-uploads/a"]]) assert.equal(classifyStorageKey(key), "INVALID");
});

test("delete routing is decided by the key alone: sealed ⇒ owner, other ⇒ general, invalid ⇒ refused before any deletion, no owner ⇒ refused (no fallback)", async () => {
  const calls: string[] = [];
  const routed = routeSealedDeletes(fake("general", calls), fake("owner", calls));
  await routed.removeObject("b", "exports/a");
  await routed.removeObject("b", `${SEALED_PREFIX}x/y`);
  await routed.removeObjects("b", ["exports/a", `${SEALED_PREFIX}1`, { name: `${SEALED_PREFIX}2` }, "direct-uploads/z"] as never);
  assert.deepEqual(calls, ["general.removeObject:exports/a", `owner.removeObject:${SEALED_PREFIX}x/y`, "general.removeObjects:exports/a,direct-uploads/z", `owner.removeObjects:${SEALED_PREFIX}1,${SEALED_PREFIX}2`]);
  // an INVALID key anywhere in a batch refuses the whole batch before anything is deleted
  calls.length = 0;
  await assert.rejects(routed.removeObjects("b", ["exports/a", "Verified-Uploads/x"] as never), { code: "STORAGE_KEY_INVALID" });
  assert.deepEqual(calls, []);
  // no owner configured: sealed keys are refused, general keys still work
  const noOwner = routeSealedDeletes(fake("general", calls), null);
  await assert.rejects(noOwner.removeObject("b", `${SEALED_PREFIX}x`), { code: "SEALED_OWNER_UNAVAILABLE" });
  await assert.rejects(noOwner.removeObjects("b", [`${SEALED_PREFIX}x`] as never), { code: "SEALED_OWNER_UNAVAILABLE" });
  await noOwner.removeObject("b", "exports/ok");
  assert.deepEqual(calls, ["general.removeObject:exports/ok"]);
  // every other method is delegated to the general client untouched
  assert.deepEqual(await routed.statObject("b", "k"), { size: 1 });
});

test("the privilege cannot be selected by the caller: the routed client exposes no selector and extra arguments never change the target client", async () => {
  const calls: string[] = [];
  const routed = routeSealedDeletes(fake("general", calls), fake("owner", calls));
  await (routed.removeObject as unknown as (...args: unknown[]) => Promise<void>)("b", "exports/a", { client: "owner", asOwner: true, privileged: true });
  await (routed.removeObject as unknown as (...args: unknown[]) => Promise<void>)("b", `${SEALED_PREFIX}a`, { client: "general" });
  assert.deepEqual(calls, ["general.removeObject:exports/a", `owner.removeObject:${SEALED_PREFIX}a`]);
  assert.equal(routeSealedDeletes.length, 2, "(general, sealedOwner) only");
});

test("worker-only verifier credentials: absent ⇒ null, partial ⇒ error, identical to the general identity ⇒ error, A2 readiness without them fails closed, errors never contain a secret", () => {
  assert.equal(readSealedOwnerCredentials({}), null);
  assert.equal(readSealedOwnerCredentials({ MINIO_VERIFIER_ACCESS_KEY: " ", MINIO_VERIFIER_SECRET_KEY: "" }), null);
  assert.throws(() => readSealedOwnerCredentials({ MINIO_VERIFIER_ACCESS_KEY: "k" }), { code: "SEALED_OWNER_CREDENTIALS_PARTIAL" });
  assert.throws(() => readSealedOwnerCredentials({ MINIO_VERIFIER_SECRET_KEY: "s" }), { code: "SEALED_OWNER_CREDENTIALS_PARTIAL" });
  assert.deepEqual(readSealedOwnerCredentials({ MINIO_VERIFIER_ACCESS_KEY: "k", MINIO_VERIFIER_SECRET_KEY: "s" }), { accessKey: "k", secretKey: "s" });
  // NO fallback: the ordinary MINIO_* variables are never consulted
  assert.equal(readSealedOwnerCredentials({ MINIO_ACCESS_KEY: "general-key", MINIO_SECRET_KEY: "general-secret-value" }), null);
  assert.equal(createSealedOwnerMinio(config, { MINIO_ACCESS_KEY: "x", MINIO_SECRET_KEY: "y" }), null);
  assert.throws(() => createSealedOwnerMinio(config, { MINIO_VERIFIER_ACCESS_KEY: "general-key", MINIO_VERIFIER_SECRET_KEY: "another-secret-value" }), { code: "SEALED_OWNER_NOT_DISTINCT" });
  assert.throws(() => assertSealedOwnerReady(config, {}), { code: "SEALED_OWNER_UNAVAILABLE" });
  assert.ok(assertSealedOwnerReady(config, { MINIO_VERIFIER_ACCESS_KEY: "verifier-key", MINIO_VERIFIER_SECRET_KEY: "verifier-secret-value" }));
  for (const attempt of [() => readSealedOwnerCredentials({ MINIO_VERIFIER_ACCESS_KEY: "k", MINIO_VERIFIER_SECRET_KEY: "" }), () => createSealedOwnerMinio(config, { MINIO_VERIFIER_ACCESS_KEY: "general-key", MINIO_VERIFIER_SECRET_KEY: "another-secret-value" }), () => assertSealedOwnerReady(config, {})]) {
    try { attempt(); } catch (error) { assert.ok(error instanceof SealedNamespaceError); assert.doesNotMatch(String((error as Error).message) + String((error as Error).stack), /another-secret-value|general-secret-value|verifier-secret-value/); }
  }
});

test("sealed-write readiness probe: AccessDenied passes, a successful write fails closed, any other error is inconclusive and rethrown", async () => {
  const denied = { putObject: async () => { throw Object.assign(new Error("denied"), { code: "AccessDenied" }); } } as unknown as MinioClient;
  await assertNoSealedWriteAuthority(denied, "b");
  const writable = { putObject: async () => ({ etag: "x" }) } as unknown as MinioClient;
  await assert.rejects(assertNoSealedWriteAuthority(writable, "b"), { code: "SEALED_NAMESPACE_WRITABLE" });
  const broken = { putObject: async () => { throw Object.assign(new Error("net"), { code: "ECONNRESET" }); } } as unknown as MinioClient;
  await assert.rejects(assertNoSealedWriteAuthority(broken, "b"), { code: "ECONNRESET" });
});

test("startup administration is off by default (R11): a missing bucket fails closed and is never created; legacy bootstrap is explicit and still needs real authority", async () => {
  const calls: string[] = [];
  const missing = { bucketExists: async () => false, makeBucket: async () => { calls.push("makeBucket"); }, setBucketLifecycle: async () => { calls.push("setBucketLifecycle"); } } as unknown as MinioClient;
  assert.equal(legacyAppAdminAllowed({}), false);
  assert.equal(legacyAppAdminAllowed({ MINIO_LEGACY_APP_ADMIN: "0" }), false);
  assert.equal(legacyAppAdminAllowed({ MINIO_LEGACY_APP_ADMIN: "1" }), true);
  await assert.rejects(ensureBucket(missing, "b", { legacyAdmin: false }), BucketNotProvisionedError);
  await assert.rejects(probeMinioProvisioning(missing, "b", 7, {}), { code: "MINIO_BUCKET_NOT_PROVISIONED" });
  assert.deepEqual(calls, [], "no administrative call is made without the explicit legacy switch");
  await probeMinioProvisioning(missing, "b", 7, { MINIO_LEGACY_APP_ADMIN: "1" });
  assert.deepEqual(calls, ["makeBucket", "setBucketLifecycle"]);
  const present = { bucketExists: async () => true, makeBucket: async () => { calls.push("unexpected-make"); }, setBucketLifecycle: async () => { calls.push("unexpected-lifecycle"); } } as unknown as MinioClient;
  calls.length = 0;
  await probeMinioProvisioning(present, "b", 7, {});
  assert.deepEqual(calls, [], "a provisioned bucket needs no administrative authority at startup");
});
