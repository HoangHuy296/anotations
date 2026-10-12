import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import test, { after } from "node:test";
import { JobStatus, JobType, Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { publishUploadedAsset, UploadPublicationFailure } from "@/lib/asset-upload";
import { createPreparedImportUploadCapability } from "@/lib/upload-capability";
import { createWorkspaceUser } from "../workspace/helpers.js";

/**
 * T019 (replay paths 1 and 2): outer upload replay and in-transaction duplicate against the real publisher.
 * Assertions are on row counts (Asset and every subtype table), never only on a status/code.
 * Mismatch guards on already-published state are unreachable through real rows once the Dataset triggers exist, so they
 * are covered by the trigger assertions below; prepared-replay and repository-reuse are covered elsewhere.
 */
const MODALITIES = [
  { modality: Modality.IMAGE, ext: "png", mime: "image/png", child: "imageAsset" },
  { modality: Modality.VIDEO, ext: "mp4", mime: "video/mp4", child: "videoAsset" },
  { modality: Modality.TEXT, ext: "txt", mime: "text/plain", child: "textAsset" },
  { modality: Modality.AUDIO, ext: "wav", mime: "audio/wav", child: "audioAsset" },
] as const;
const BUCKET = "t019-fixture";
const created = { users: [] as string[], datasets: [] as string[] };

async function counts(datasetId: string) {
  const where = { asset: { datasetId } };
  return {
    assets: await db.asset.count({ where: { datasetId } }),
    imageAsset: await db.imageAsset.count({ where }),
    videoAsset: await db.videoAsset.count({ where }),
    textAsset: await db.textAsset.count({ where }),
    audioAsset: await db.audioAsset.count({ where }),
  };
}

async function fixture(modality: Modality) {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await db.dataset.create({
    data: { ownerId: owner.id, name: `t019-${modality}-${randomUUID()}`, modality, primaryModality: modality, modalityResolverSubject: owner.id },
    select: { id: true },
  });
  created.users.push(owner.id); created.datasets.push(dataset.id);
  return { owner, dataset };
}

function inputs(spec: (typeof MODALITIES)[number], ownerId: string, datasetId: string, tag: string) {
  const capability = { purpose: "upload" as const, actorId: ownerId, datasetId, objectKey: `direct-uploads/${datasetId}/${tag}.${spec.ext}`, filename: `${tag}.${spec.ext}`, candidateContentType: spec.mime, sizeBytes: 16, nonce: tag, expiresAt: Math.floor(Date.now() / 1000) + 300 };
  const verified = { modality: spec.modality, mimeType: spec.mime, sizeBytes: BigInt(16), sourceFingerprint: `t019:${tag}`, ...(spec.modality === Modality.IMAGE ? { width: 2, height: 2 } : {}) };
  return { capability, verified, bucket: BUCKET };
}

after(async () => {
  try {
    await db.asset.deleteMany({ where: { datasetId: { in: created.datasets } } });
    await db.dataset.deleteMany({ where: { id: { in: created.datasets } } });
    await db.user.deleteMany({ where: { id: { in: created.users } } });
  } catch { /* leave rows to the disposable teardown */ }
});

for (const spec of MODALITIES) {
  test(`outer upload replay (${spec.modality}): second publish returns the same Asset and creates no duplicate Asset or subtype`, async () => {
    const { owner, dataset } = await fixture(spec.modality);
    const input = inputs(spec, owner.id, dataset.id, randomUUID());
    const first = await publishUploadedAsset(input);
    const replay = await publishUploadedAsset(input);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.asset.id, first.asset.id);
    const c = await counts(dataset.id);
    assert.equal(c.assets, 1);
    for (const child of ["imageAsset", "videoAsset", "textAsset", "audioAsset"] as const) {
      assert.equal(c[child], child === spec.child ? 1 : 0, `${child} rows`);
    }
  });

  test(`in-transaction duplicate (${spec.modality}): concurrent publishes of one object yield exactly one Asset and one subtype`, async () => {
    const { owner, dataset } = await fixture(spec.modality);
    const input = inputs(spec, owner.id, dataset.id, randomUUID());
    const results = await Promise.allSettled([publishUploadedAsset(input), publishUploadedAsset(input), publishUploadedAsset(input)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.ok(ok.length >= 1, "at least one publish succeeds");
    for (const r of results) {
      if (r.status === "rejected") assert.ok(r.reason instanceof UploadPublicationFailure && r.reason.code === "UPLOAD_CONFLICT", "a losing racer may only fail with UPLOAD_CONFLICT");
    }
    const c = await counts(dataset.id);
    assert.equal(c.assets, 1);
    assert.equal(c.imageAsset + c.videoAsset + c.textAsset + c.audioAsset, 1);
    assert.equal(c[spec.child], 1);
  });
}

test("mismatched publish (AUDIO into IMAGE dataset) is rejected with no Asset or subtype row; trigger also rejects a direct mismatched insert", async () => {
  const { owner, dataset } = await fixture(Modality.IMAGE);
  const audio = MODALITIES[3];
  await assert.rejects(
    publishUploadedAsset(inputs(audio, owner.id, dataset.id, randomUUID())),
    (error) => error instanceof UploadPublicationFailure && error.code === "ASSET_MODALITY_MISMATCH",
  );
  assert.deepEqual(await counts(dataset.id), { assets: 0, imageAsset: 0, videoAsset: 0, textAsset: 0, audioAsset: 0 });
  await assert.rejects(
    db.asset.create({ data: { datasetId: dataset.id, uploadedById: owner.id, modality: Modality.AUDIO, filename: "x.wav", relativePath: "x.wav", sourceFingerprint: "t019:direct", originalFilename: "x.wav", mimeType: "audio/wav", sizeBytes: BigInt(1), sourceMode: "UPLOAD", storageProvider: "MINIO", storageBucket: BUCKET, storageKey: `direct-uploads/${dataset.id}/direct.wav`, status: "READY" } }),
    /ASSET_MODALITY_MISMATCH/,
  );
  assert.equal((await counts(dataset.id)).assets, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// T019 path 3 (prepared completed-item replay) and T020 (mixed-batch commit summary).
//
// Dependencies, stated exactly (no provider-env allowlist change is needed or made):
//  * Postgres only (the receipt-owned disposable database). No MinIO, Redis or network.
//  * `@/lib/providers` is replaced ONLY while complete-local-folder-item loads. The replacement returns a test-local
//    random UPLOAD_CAPABILITY_SECRET (generated in-process, never read from or written to the environment) and an
//    in-memory object store implementing exactly statObject / getPartialObject / removeObject. The REAL
//    upload-capability signing/verification, REAL verifyUploadedObject byte inspection, REAL publishUploadedAsset and
//    REAL completeLocalFolderItem / commitLocalFolderImport run unmodified.
//  * Fault injection (parent Dataset.modality null / changed) is a Proxy over `db.dataset.findFirst` that rewrites ONLY
//    the `modality` of queries selecting it, ONLY inside complete-local-folder-item's own db handle. The DB itself is
//    never altered: with the M24 triggers installed such a parent state is unreachable by real rows, which is exactly
//    why the guard branch needs injection. These two assertions therefore prove the application guard, not the trigger.
//  * Requires M24 only for the earlier trigger assertion; the replay/summary tests below do not depend on it.
// ---------------------------------------------------------------------------------------------------------------
const nodeRequire = createRequire(import.meta.url);
const NodeModule = nodeRequire("node:module") as {
  _load: (id: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (id: string, parent: unknown, isMain: boolean) => string;
};
const providersPath = nodeRequire.resolve("@/lib/providers");
const dbPath = nodeRequire.resolve("@/lib/db");
const TEST_SECRET = randomBytes(48).toString("base64url");
const objects = new Map<string, Buffer>();
const fakeMinio = {
  async statObject(_bucket: string, key: string) { const o = objects.get(key); if (!o) throw new Error("NoSuchKey"); return { size: o.length, etag: createHash("md5").update(o).digest("hex") }; },
  async getPartialObject(_bucket: string, key: string, offset: number, length: number) { const o = objects.get(key); if (!o) throw new Error("NoSuchKey"); return Readable.from([o.subarray(offset, offset + length)]); },
  async removeObject(_bucket: string, key: string) { objects.delete(key); },
};
const providerStub = { getDirectUploadProviders: () => ({ config: { UPLOAD_CAPABILITY_SECRET: TEST_SECRET, MINIO_BUCKET: BUCKET }, minio: fakeMinio }) };
const fault: { parentModality: Modality | null | undefined } = { parentModality: undefined };
const faultedDb = new Proxy(db, {
  get(target, prop) {
    if (prop !== "dataset") { const value = Reflect.get(target, prop, target); return typeof value === "function" ? value.bind(target) : value; }
    return new Proxy(target.dataset, {
      get(model, method) {
        if (method !== "findFirst") { const value = Reflect.get(model, method, model); return typeof value === "function" ? value.bind(model) : value; }
        return async (args: { select?: { modality?: boolean } }) => {
          const row = await model.findFirst(args as never);
          return row && fault.parentModality !== undefined && args.select?.modality ? { ...row, modality: fault.parentModality } : row;
        };
      },
    });
  },
});
const originalLoad = NodeModule._load;
let completeLocalFolderItem: typeof import("@/lib/imports/complete-local-folder-item")["completeLocalFolderItem"];
let commitLocalFolderImport: typeof import("@/lib/imports/commit-local-folder-import")["commitLocalFolderImport"];
NodeModule._load = function (id, parent, isMain) {
  const resolved = NodeModule._resolveFilename(id, parent, isMain);
  if (resolved === providersPath) return providerStub;
  if (resolved === dbPath) return { db: faultedDb };
  return originalLoad.call(this, id, parent, isMain);
};
try {
  ({ completeLocalFolderItem } = nodeRequire("@/lib/imports/complete-local-folder-item"));
  ({ commitLocalFolderImport } = nodeRequire("@/lib/imports/commit-local-folder-import"));
} finally { NodeModule._load = originalLoad; }

const PNG = () => { const b = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(2, 16); b.writeUInt32BE(2, 20); b[31] = randomBytes(1)[0]!; return b; };
const WAV = () => { const b = Buffer.alloc(32); b.write("RIFF", 0, "ascii"); b.write("WAVE", 8, "ascii"); b[31] = randomBytes(1)[0]!; return b; };
type Bytes = "png" | "wav" | "absent";

async function preparedFixture(kinds: Bytes[]) {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `t020-${randomUUID()}`, modality: Modality.IMAGE, primaryModality: Modality.IMAGE, modalityResolverSubject: owner.id }, select: { id: true } });
  const job = await db.job.create({ data: { datasetId: dataset.id, createdById: owner.id, type: JobType.IMPORT_DATASET, status: JobStatus.RUNNING, totalItems: kinds.length, input: {} }, select: { id: true } });
  const prepared = await db.preparedImport.create({ data: { datasetId: dataset.id, jobId: job.id, createdById: owner.id, expectedItemCount: kinds.length, deadlineAt: new Date(Date.now() + 3_600_000), idempotencyKey: randomUUID() }, select: { id: true } });
  created.users.push(owner.id); created.datasets.push(dataset.id);
  const actor = { id: owner.id, role: owner.role, email: owner.email, name: owner.name };
  const items: { id: string; token: string; storageKey: string; kind: Bytes }[] = [];
  for (const [position, kind] of kinds.entries()) {
    const bytes = kind === "wav" ? WAV() : PNG();
    const filename = `item-${position}.png`;
    const storageKey = `folder-import/${prepared.id}/${position}-${randomUUID()}`;
    const item = await db.preparedImportItem.create({ data: { preparedImportId: prepared.id, position, logicalPath: filename, normalizedPath: filename, filename, mimeType: "image/png", sizeBytes: BigInt(bytes.length), modality: Modality.IMAGE, fingerprint: createHash("sha256").update(storageKey).digest("hex"), storageKey }, select: { id: true } });
    if (kind !== "absent") objects.set(storageKey, bytes);
    const { token } = createPreparedImportUploadCapability({ UPLOAD_CAPABILITY_SECRET: TEST_SECRET }, { actorId: owner.id, datasetId: dataset.id, filename, candidateContentType: "image/png", sizeBytes: bytes.length, objectKey: storageKey, preparedImportId: prepared.id, preparedImportItemId: item.id });
    items.push({ id: item.id, token, storageKey, kind });
  }
  return { actor, dataset, job, prepared, items };
}
const jobRow = async (jobId: string) => JSON.stringify(await db.job.findUniqueOrThrow({ where: { id: jobId } }), (_k, v) => (typeof v === "bigint" ? v.toString() : v));

test("prepared completed-item replay: unchanged replay creates no duplicate Asset/subtype; unresolved or changed parent is refused with no state change", async () => {
  const f = await preparedFixture(["png"]);
  const it = f.items[0]!;
  const first = await completeLocalFolderItem(f.actor, f.prepared.id, it.id, it.token);
  assert.equal(first.ok, true); assert.equal(first.status, 201);
  const assetId = (first as { assetId: string }).assetId;
  const base = await counts(f.dataset.id);
  assert.deepEqual(base, { assets: 1, imageAsset: 1, videoAsset: 0, textAsset: 0, audioAsset: 0 });

  const replay = await completeLocalFolderItem(f.actor, f.prepared.id, it.id, it.token);
  assert.equal(replay.ok, true); assert.equal(replay.status, 200);
  assert.equal((replay as { assetId: string }).assetId, assetId);
  assert.deepEqual(await counts(f.dataset.id), base);

  const jobBefore = await jobRow(f.job.id);
  for (const [parent, code] of [[null, "DATASET_MODALITY_UNRESOLVED"], [Modality.AUDIO, "ASSET_MODALITY_MISMATCH"]] as const) {
    fault.parentModality = parent;
    try {
      const refused = await completeLocalFolderItem(f.actor, f.prepared.id, it.id, it.token);
      assert.equal(refused.ok, false); assert.equal(refused.status, 409);
      assert.equal((refused as { code?: string }).code, code);
    } finally { fault.parentModality = undefined; }
    assert.deepEqual(await counts(f.dataset.id), base, `${code}: no Asset or subtype may be created or removed`);
    assert.equal((await db.preparedImportItem.findUniqueOrThrow({ where: { id: it.id }, select: { assetId: true } })).assetId, assetId, `${code}: item link unchanged`);
    assert.equal(await jobRow(f.job.id), jobBefore, `${code}: Job row (summary/counters) unchanged`);
  }
  const control = await completeLocalFolderItem(f.actor, f.prepared.id, it.id, it.token);
  assert.equal(control.status, 200, "with the injection removed the replay succeeds again");
});

test("T020 mixed batch: 2 accepted, 1 rejected (wrong bytes), 1 unprocessed -> commit is 409 IMPORT_INCOMPLETE with exact counts, published Assets preserved, replay stable, rejected item cannot complete without verified bytes", async () => {
  const f = await preparedFixture(["png", "png", "wav", "absent"]);
  const [a, b, c] = f.items as [typeof f.items[0], typeof f.items[0], typeof f.items[0], typeof f.items[0]];
  assert.equal((await completeLocalFolderItem(f.actor, f.prepared.id, a.id, a.token)).status, 201);
  assert.equal((await completeLocalFolderItem(f.actor, f.prepared.id, b.id, b.token)).status, 201);
  const rejected = await completeLocalFolderItem(f.actor, f.prepared.id, c.id, c.token);
  assert.equal(rejected.ok, false);
  assert.equal((rejected as { code?: string }).code, "ASSET_MODALITY_MISMATCH");
  assert.deepEqual({ accepted: (rejected as never as Record<string, number>).accepted, rejected: (rejected as never as Record<string, number>).rejected, unprocessed: (rejected as never as Record<string, number>).unprocessed }, { accepted: 2, rejected: 1, unprocessed: 1 });
  const published = await counts(f.dataset.id);
  assert.deepEqual(published, { assets: 2, imageAsset: 2, videoAsset: 0, textAsset: 0, audioAsset: 0 });

  const expected = { accepted: 2, unchanged: 0, rejected: 1, retryable: 0, unprocessed: 1 };
  const commit = await commitLocalFolderImport(f.actor, f.job.id);
  assert.equal(commit.ok, false); assert.equal(commit.status, 409);
  assert.equal((commit as { code?: string }).code, "IMPORT_INCOMPLETE");
  assert.deepEqual({ accepted: (commit as never as Record<string, number>).accepted, unchanged: (commit as never as Record<string, number>).unchanged, rejected: (commit as never as Record<string, number>).rejected, retryable: (commit as never as Record<string, number>).retryable, unprocessed: (commit as never as Record<string, number>).unprocessed }, expected);
  const job = await db.job.findUniqueOrThrow({ where: { id: f.job.id }, select: { status: true, errorCode: true, summary: true, successItems: true, failedItems: true, skippedItems: true } });
  assert.equal(job.status, JobStatus.FAILED); assert.equal(job.errorCode, "IMPORT_INCOMPLETE");
  assert.deepEqual(job.summary, { outcome: "incomplete", ...expected });
  assert.deepEqual([job.successItems, job.failedItems, job.skippedItems], [2, 1, 1]);
  assert.deepEqual(await counts(f.dataset.id), published, "published Assets are preserved, not rolled back or duplicated");
  assert.equal((await db.preparedImport.findUniqueOrThrow({ where: { id: f.prepared.id }, select: { status: true } })).status, "PREPARING", "an incomplete import is never marked COMMITTED");
  assert.equal((await db.preparedImportItem.findUniqueOrThrow({ where: { id: c.id }, select: { assetId: true } })).assetId, null);
  assert.equal(await db.asset.count({ where: { storageKey: c.storageKey } }), 0);

  // Retry of the rejected item: object was cleaned up -> not ready; even if wrong bytes are re-uploaded it is rejected again, never published.
  const notReady = await completeLocalFolderItem(f.actor, f.prepared.id, c.id, c.token);
  assert.equal(notReady.ok, false);
  objects.set(c.storageKey, WAV());
  const again = await completeLocalFolderItem(f.actor, f.prepared.id, c.id, c.token);
  assert.equal(again.ok, false); assert.equal((again as { code?: string }).code, "ASSET_MODALITY_MISMATCH");
  assert.equal(await db.jobEvent.count({ where: { id: `phase029_rejected_${c.id}` } }), 1, "stable event id: the rejection is recorded once");
  assert.equal(await db.asset.count({ where: { storageKey: c.storageKey } }), 0);
  assert.deepEqual(await counts(f.dataset.id), published);

  const replay = await commitLocalFolderImport(f.actor, f.job.id);
  assert.equal(replay.status, 409); assert.equal((replay as { code?: string }).code, "IMPORT_INCOMPLETE");
  assert.equal((replay as never as Record<string, number>).accepted, 2);
  assert.equal((replay as never as Record<string, number>).rejected, 1);
  assert.equal((replay as never as Record<string, number>).unprocessed, 1);
  assert.deepEqual(await counts(f.dataset.id), published);
});

test("T020 control: a fully completed batch commits COMPLETED with unprocessed 0, replay is stable and creates nothing", async () => {
  const f = await preparedFixture(["png", "png"]);
  for (const item of f.items) assert.equal((await completeLocalFolderItem(f.actor, f.prepared.id, item.id, item.token)).status, 201);
  const before = await counts(f.dataset.id);
  const commit = await commitLocalFolderImport(f.actor, f.job.id);
  assert.equal(commit.ok, true); assert.equal(commit.status, 200);
  const job = await db.job.findUniqueOrThrow({ where: { id: f.job.id }, select: { status: true, summary: true } });
  assert.equal(job.status, JobStatus.COMPLETED);
  assert.deepEqual(job.summary, { outcome: "completed", accepted: 2, unchanged: 0, rejected: 0, retryable: 0, unprocessed: 0, resultCount: 2 });
  const replay = await commitLocalFolderImport(f.actor, f.job.id);
  assert.equal(replay.ok, true); assert.equal((replay as { replayed?: boolean }).replayed, true);
  assert.deepEqual(await counts(f.dataset.id), before);
  assert.deepEqual(before, { assets: 2, imageAsset: 2, videoAsset: 0, textAsset: 0, audioAsset: 0 });
});
