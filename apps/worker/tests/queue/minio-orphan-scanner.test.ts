import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { sweepSingleObject, sweepUnreferencedObjects } from "../../src/queue/minio-orphan-scanner.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

// Real MinIO writes/deletes — deliberately opt-in, matching the existing
// convention (see tests/repository-import/cleanup-compensation.test.ts's
// REPOSITORY_IMPORT_RUNTIME_TESTS gate) so this destructive test never runs
// without explicit, informed enablement.
const enabled = process.env.GARBAGE_COLLECTION_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const skip = enabled ? false : "explicit GARBAGE_COLLECTION_RUNTIME_TESTS=1 + DATABASE_URL required (real MinIO deletes)";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function harness() {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { email: `gc-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `gc-${suffix}` }, select: { id: true } });
  const prefix = `gc-scanner-test/${dataset.id}/`;
  const createdKeys: string[] = [];

  return {
    config, db, minio, prefix,
    async putObject(name: string, body = "x") {
      const key = `${prefix}${name}`;
      await minio.putObject(config.MINIO_BUCKET, key, Buffer.from(body));
      createdKeys.push(key);
      return key;
    },
    async publishAsset(key: string) {
      return db.asset.create({
        data: {
          datasetId: dataset.id, modality: "TEXT", filename: "referenced.txt", mimeType: "text/plain",
          sourceMode: "UPLOAD", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET,
          storageKey: key, sourceFingerprint: key, status: "READY", textAsset: { create: { tokenization: {}, metadata: {} } },
        },
        select: { id: true },
      });
    },
    async objectExists(key: string) {
      try { await minio.statObject(config.MINIO_BUCKET, key); return true; } catch { return false; }
    },
    async cleanup() {
      await Promise.all(createdKeys.map((key) => minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined)));
      await db.dataset.deleteMany({ where: { id: dataset.id } });
      await db.user.deleteMany({ where: { id: owner.id } });
      await db.$disconnect();
    },
  };
}

test("a referenced Asset object is never deleted, in dry-run or live mode", { skip }, async () => {
  const h = await harness();
  try {
    const key = await h.putObject("referenced");
    await h.publishAsset(key);
    await sleep(20);

    const dryRun = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: true, gracePeriodMs: 0 });
    assert.deepEqual(dryRun.orphans, []);
    assert.ok(await h.objectExists(key));

    const live = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: false, gracePeriodMs: 0 });
    assert.deepEqual(live.deleted, []);
    assert.ok(await h.objectExists(key), "a referenced object must survive a live sweep even with zero grace period");
  } finally { await h.cleanup(); }
});

test("an orphaned object younger than the grace period is reported but never deleted", { skip }, async () => {
  const h = await harness();
  try {
    const key = await h.putObject("young-orphan");
    const result = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: false, gracePeriodMs: 60_000 });
    assert.deepEqual(result.orphans, [key]);
    assert.deepEqual(result.tooYoung, [key]);
    assert.deepEqual(result.deleted, []);
    assert.ok(await h.objectExists(key));
  } finally { await h.cleanup(); }
});

test("an orphaned object older than the grace period is deleted only outside dry-run", { skip }, async () => {
  const h = await harness();
  try {
    const key = await h.putObject("old-orphan");
    await sleep(120);

    const dryRun = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: true, gracePeriodMs: 100 });
    assert.deepEqual(dryRun.orphans, [key]);
    assert.deepEqual(dryRun.deleted, [], "dry-run must never delete, even past the grace period");
    assert.ok(await h.objectExists(key));

    const live = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: false, gracePeriodMs: 100 });
    assert.deepEqual(live.deleted, [key]);
    assert.equal(await h.objectExists(key), false);
  } finally { await h.cleanup(); }
});

test("running the sweep twice in a row produces the same end state (idempotent)", { skip }, async () => {
  const h = await harness();
  try {
    const key = await h.putObject("idempotent-orphan");
    await sleep(60);
    const first = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: false, gracePeriodMs: 50 });
    assert.deepEqual(first.deleted, [key]);
    const second = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: false, gracePeriodMs: 50 });
    assert.deepEqual(second.orphans, [], "the object is gone, so the second pass never even sees it as a candidate");
    assert.deepEqual(second.deleted, []);
    assert.deepEqual(second.failed, []);
  } finally { await h.cleanup(); }
});

test("an object detected as an orphan in an earlier dry-run survives a later live sweep once it becomes referenced", { skip }, async () => {
  const h = await harness();
  try {
    const key = await h.putObject("becomes-referenced");
    await sleep(60);
    const dryRun = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: true, gracePeriodMs: 50 });
    assert.deepEqual(dryRun.orphans, [key], "confirmed detected as an orphan candidate");

    // Between the dry-run report and the live pass, the object becomes
    // referenced (e.g. its upload is published as a real Asset) — the live
    // pass must re-check, not act on the stale dry-run finding.
    await h.publishAsset(key);
    const live = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: false, gracePeriodMs: 50 });
    assert.deepEqual(live.orphans, [], "now referenced — must not even be reported as a candidate, let alone deleted");
    assert.ok(await h.objectExists(key));
  } finally { await h.cleanup(); }
});

test("two concurrent live sweeps over the same prefix never delete a referenced object and complete without an uncaught error", { skip }, async () => {
  const h = await harness();
  try {
    const referencedKey = await h.putObject("concurrent-referenced");
    await h.publishAsset(referencedKey);
    const orphanKey = await h.putObject("concurrent-orphan");
    await sleep(60);

    const sweep = () => sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: h.prefix, dryRun: false, gracePeriodMs: 50 });
    const [a, b] = await Promise.all([sweep(), sweep()]);

    assert.ok(await h.objectExists(referencedKey), "referenced object survives concurrent sweeps");
    assert.equal(await h.objectExists(orphanKey), false, "the orphan is gone — exactly one sweep's delete succeeded");
    // Whichever sweep's delete lost the race to the other observes the key
    // already gone and records a caught, non-crashing failure — never an
    // uncaught rejection, and never a false report that a referenced key
    // was orphaned.
    const combinedDeleted = [...a.deleted, ...b.deleted];
    const combinedFailed = [...a.failed, ...b.failed];
    assert.deepEqual(combinedDeleted.filter((k) => k === referencedKey), []);
    assert.ok(combinedDeleted.includes(orphanKey) || combinedFailed.some((f) => f.key === orphanKey));
  } finally { await h.cleanup(); }
});

test("sweepSingleObject applies the same reference check and grace period as the prefix sweep", { skip }, async () => {
  const h = await harness();
  try {
    const key = await h.putObject("single-object");
    const tooYoung = await sweepSingleObject({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, key, dryRun: false, gracePeriodMs: 60_000 });
    assert.deepEqual(tooYoung.tooYoung, [key]);
    assert.ok(await h.objectExists(key));

    await sleep(60);
    const deleted = await sweepSingleObject({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, key, dryRun: false, gracePeriodMs: 50 });
    assert.deepEqual(deleted.deleted, [key]);
    assert.equal(await h.objectExists(key), false);

    // Idempotent: the object is already gone, statObject throws, and the
    // function treats that as a safe no-op rather than a failure.
    const again = await sweepSingleObject({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, key, dryRun: false, gracePeriodMs: 50 });
    assert.deepEqual(again, { scanned: 1, orphans: [key], deleted: [], tooYoung: [], failed: [] });
  } finally { await h.cleanup(); }
});
