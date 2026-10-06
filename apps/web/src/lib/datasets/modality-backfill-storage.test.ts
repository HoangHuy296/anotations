import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMinioStatObject, createStorageClient, describeStorage, type StatClient } from "@/lib/datasets/modality-backfill-storage";

// Offline: the adapter is exercised with a fake client. The real-MinIO behavior is proven by `release:phase029-backfill-maintenance`.
const client = (stat: StatClient["statObject"], exists: StatClient["bucketExists"] = async () => true): StatClient => ({ statObject: stat, bucketExists: exists });
const coded = (code: string) => Object.assign(new Error(code), { code });

test("stat adapter: found objects become size + ETag; NotFound/NoSuchKey are 'missing'; every other failure is thrown, never 'missing'", async () => {
  const stat = createMinioStatObject(client(async (_b, key) => {
    if (key === "present") return { size: 11, etag: "abc" };
    if (key === "no-etag") return { size: 0 };
    if (key === "gone") throw coded("NotFound");
    if (key === "gone2") throw coded("NoSuchKey");
    if (key === "denied") throw coded("AccessDenied");
    if (key === "bucket") throw coded("NoSuchBucket");
    if (key === "refused") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (key === "negative") return { size: -1 };
    throw new Error("unexpected");
  }));
  assert.deepEqual(await stat("b", "present"), { size: BigInt(11), etag: "abc" });
  assert.deepEqual(await stat("b", "no-etag"), { size: BigInt(0), etag: null });
  assert.equal(await stat("b", "gone"), null); assert.equal(await stat("b", "gone2"), null);
  for (const key of ["denied", "bucket", "refused", "negative"]) await assert.rejects(stat("b", key), key);
});
test("stat adapter: a hung store becomes a timeout failure, not a missing object", async () => {
  const stat = createMinioStatObject(client(() => new Promise(() => undefined)), 30);
  await assert.rejects(stat("b", "k"), /STORAGE_TIMEOUT/);
});
test("storage identity carries no secret: endpoint, bucket, answer and a fingerprint; the access key and secret never appear", async () => {
  const config = { endpoint: "http://127.0.0.1:55462", accessKey: "AKIAEXAMPLEKEY", secretKey: "very-secret-value" };
  const identity = await describeStorage(config, "bucket-a", client(async () => ({ size: 1 })));
  assert.deepEqual({ ...identity, configFingerprint: "x" }, { endpointHost: "127.0.0.1", endpointPort: 55462, useSSL: false, bucket: "bucket-a", bucketExists: true, configFingerprint: "x" });
  assert.match(identity.configFingerprint, /^[0-9a-f]{64}$/);
  const text = JSON.stringify(identity); assert.ok(!text.includes(config.accessKey) && !text.includes(config.secretKey));
  const other = await describeStorage({ ...config, accessKey: "AKIAOTHERKEY" }, "bucket-a", client(async () => ({ size: 1 })));
  const otherBucket = await describeStorage(config, "bucket-b", client(async () => ({ size: 1 })));
  assert.notEqual(other.configFingerprint, identity.configFingerprint); assert.notEqual(otherBucket.configFingerprint, identity.configFingerprint);
  assert.equal((await describeStorage(config, "bucket-a", client(async () => ({ size: 1 }), async () => false))).bucketExists, false);
  assert.equal((await describeStorage({ ...config, endpoint: "https://store.example" }, "b", client(async () => ({ size: 1 })))).endpointPort, 443);
});
test("storage client factory refuses an ambiguous endpoint (credentials, path, query) and the adapter performs no write or listing", () => {
  for (const endpoint of ["http://user:pw@127.0.0.1:9000", "http://127.0.0.1:9000/bucket", "http://127.0.0.1:9000?x=1", "ftp://127.0.0.1:9000", "not a url"]) assert.throws(() => createStorageClient({ endpoint, accessKey: "a", secretKey: "b" }), /./, endpoint);
  assert.doesNotThrow(() => createStorageClient({ endpoint: "http://127.0.0.1:9000", accessKey: "a", secretKey: "b" }));
  const source = readFileSync(new URL("./modality-backfill-storage.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /putObject|removeObject|listObjects|getObject|fPutObject|copyObject|makeBucket|removeBucket|presigned|process\.env/);
});
