import "../../../../scripts/db-safety/test-entry.cjs"; // G1: fixtures are allowed only on the receipt-pinned disposable DB.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { reconcileMirroredRepositoryAsset, upsertMirroredRepositoryAsset } from "../../src/jobs/repository-asset-upsert.js";
import { createWorkerDatabase } from "../../src/providers/db.js";

/**
 * T019 path 4 (repository reconciliation reuse). Dependencies: Postgres only (receipt-owned disposable DB); no MinIO,
 * Redis, provider or network. The real upsert/reconcile functions run with an injected `db` (their documented seam).
 * Unresolved/changed parent is fault-injected by a Proxy rewriting only `dataset.findFirst({select:{modality}})` on the
 * handle passed as `input.db`; the database is never altered (with M24 installed such parents are unreachable by rows).
 * Assertions are row counts of Asset and every subtype table, not only thrown codes.
 */
const db = createWorkerDatabase(getWorkerConfig());
const fault: { parent: string | null | undefined } = { parent: undefined };
const faultedDb = new Proxy(db, {
  get(target, prop) {
    if (prop !== "dataset") { const v = Reflect.get(target, prop, target); return typeof v === "function" ? v.bind(target) : v; }
    return new Proxy(target.dataset, {
      get(model, method) {
        if (method !== "findFirst") { const v = Reflect.get(model, method, model); return typeof v === "function" ? v.bind(model) : v; }
        return async (args: { select?: { modality?: boolean } }) => {
          const row = await model.findFirst(args as never);
          return row && fault.parent !== undefined && args.select?.modality ? { ...row, modality: fault.parent } : row;
        };
      },
    });
  },
}) as typeof db;

const SPECS = [
  { modality: "IMAGE", file: "a.png", mime: "image/png", child: "imageAsset", other: "AUDIO" },
  { modality: "VIDEO", file: "a.mp4", mime: "video/mp4", child: "videoAsset", other: "IMAGE" },
  { modality: "TEXT", file: "a.txt", mime: "text/plain", child: "textAsset", other: "IMAGE" },
  { modality: "AUDIO", file: "a.wav", mime: "audio/wav", child: "audioAsset", other: "IMAGE" },
] as const;
const created = { users: [] as string[], datasets: [] as string[] };

async function counts(datasetId: string) {
  const where = { asset: { datasetId } };
  return {
    assets: await db.asset.count({ where: { datasetId } }),
    imageAsset: await db.imageAsset.count({ where }), videoAsset: await db.videoAsset.count({ where }),
    textAsset: await db.textAsset.count({ where }), audioAsset: await db.audioAsset.count({ where }),
  };
}

after(async () => {
  try {
    await db.asset.deleteMany({ where: { datasetId: { in: created.datasets } } });
    await db.dataset.deleteMany({ where: { id: { in: created.datasets } } });
    await db.user.deleteMany({ where: { id: { in: created.users } } });
  } catch { /* leave rows to the disposable teardown */ }
  await db.$disconnect();
});

for (const spec of SPECS) {
  test(`repository reuse (${spec.modality}): replayed delivery and reconcile reuse one Asset/subtype; unresolved or changed parent is refused with no state change`, { skip: process.env.DATABASE_URL ? false : "database unavailable" }, async () => {
    const suffix = randomUUID();
    const owner = await db.user.create({ data: { email: `t019-${suffix}@test.invalid`, name: `t019-${suffix}`, role: "MANAGER", passwordHash: "t019-unused" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `t019-${suffix}`, sourceMode: "MIRROR_TO_MINIO", modality: spec.modality, primaryModality: spec.modality, modalityResolverSubject: owner.id }, select: { id: true } });
    created.users.push(owner.id); created.datasets.push(dataset.id);
    const candidate = { modality: spec.modality, filename: spec.file, mimeType: spec.mime, path: `t019/${spec.file}`, sizeBytes: 16, revision: "r1", providerFileIdentity: `blob-${suffix}`, downloadUrl: "http://fixture.invalid/ignored" } as const;
    const base = { db, datasetId: dataset.id, uploadedById: owner.id, provider: "GITEA" as const, candidate, verifiedModality: spec.modality, sourceFingerprint: `t019:${suffix}`, bucket: "t019-fixture", objectKey: `t019/${suffix}/obj`, sourceRootPath: null };

    const first = await upsertMirroredRepositoryAsset(base);
    const second = await upsertMirroredRepositoryAsset(base);
    assert.equal(second.id, first.id);
    const baseline = await counts(dataset.id);
    assert.equal(baseline.assets, 1);
    for (const child of ["imageAsset", "videoAsset", "textAsset", "audioAsset"] as const) assert.equal(baseline[child], child === spec.child ? 1 : 0, child);

    const reconcileInput = { db: faultedDb, datasetId: dataset.id, sourceFingerprint: base.sourceFingerprint, candidate, bucket: base.bucket, objectKey: base.objectKey };
    assert.deepEqual(await reconcileMirroredRepositoryAsset(reconcileInput), { kind: "reusable", assetId: first.id, storageKey: base.objectKey });

    for (const [parent, code] of [[null, "DATASET_MODALITY_UNRESOLVED"], [spec.other, "ASSET_MODALITY_MISMATCH"]] as const) {
      fault.parent = parent;
      try { await assert.rejects(reconcileMirroredRepositoryAsset(reconcileInput), new RegExp(code)); }
      finally { fault.parent = undefined; }
      assert.deepEqual(await counts(dataset.id), baseline, `${code}: no Asset/subtype created or removed`);
      assert.equal((await db.asset.findUniqueOrThrow({ where: { id: first.id }, select: { modality: true } })).modality, spec.modality);
    }

    // A different blob under the same fingerprint is a conflict, never an overwrite or a second Asset.
    assert.deepEqual(await reconcileMirroredRepositoryAsset({ ...reconcileInput, candidate: { ...candidate, revision: "r2" } }), { kind: "conflict" });
    await assert.rejects(upsertMirroredRepositoryAsset({ ...base, candidate: { ...candidate, revision: "r2" } }), /SOURCE_RECONCILIATION_CONFLICT/);
    assert.deepEqual(await counts(dataset.id), baseline);
  });
}
