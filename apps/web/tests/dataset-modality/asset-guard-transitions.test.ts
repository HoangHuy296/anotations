import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

// T033 / G-SQL evidence (sequential, single-connection; races are T034): the M24 Asset guard on UPDATE/reparent/restore/delete and the Dataset immutability
// guard with ZERO Assets. Fixture-independent: every Dataset created here is resolved at creation.
const enabled = Boolean(process.env.DATABASE_URL);
const users: string[] = [];
const datasets: string[] = [];
after(async () => { if (users.length || datasets.length) await cleanupWorkspaceFixture(users, datasets); await db.$disconnect(); });
const MIME = { IMAGE: "image/png", VIDEO: "video/mp4", AUDIO: "audio/wav", TEXT: "text/plain" } as const;
async function setup() {
  const owner = await createWorkspaceUser(UserRole.MANAGER); users.push(owner.id);
  const make = async (modality: Modality) => { const d = await createWorkspaceDataset(owner.id, modality); datasets.push(d.id); return d.id; };
  return { owner, make };
}
const revision = async (id: string) => (await db.dataset.findUniqueOrThrow({ where: { id }, select: { modalityContentRevision: true } })).modalityContentRevision;
const newAsset = (datasetId: string, modality: Modality) => db.asset.create({ data: { datasetId, modality, filename: `${modality}.bin`, mimeType: MIME[modality], sourceFingerprint: `t033:${randomUUID()}`, sizeBytes: BigInt(10) }, select: { id: true } });

test("T033 null rejected: a Dataset cannot be inserted without a modality (phase029_guard_dataset_insert, DATASET_MODALITY_REQUIRED)", { skip: !enabled }, async () => {
  const { owner } = await setup();
  await assert.rejects(db.dataset.create({ data: { ownerId: owner.id, name: "no modality" } }), /DATASET_MODALITY_REQUIRED|dataset_modality/i);
});

test("T033 non-null immutable even with zero Assets: modality, resolution time and resolver subject cannot change or be cleared (phase029_guard_dataset_assignment)", { skip: !enabled }, async () => {
  const { owner, make } = await setup();
  const id = await make(Modality.IMAGE);
  assert.equal(await db.asset.count({ where: { datasetId: id } }), 0, "zero Assets");
  for (const data of [{ modality: Modality.TEXT }, { modality: null, modalityResolverSubject: null, modalityResolvedAt: null }, { modalityResolverSubject: "forged" }, { modalityResolvedAt: new Date(0) }, { modality: Modality.IMAGE, modalityResolverSubject: `${owner.id}-x` }]) {
    await assert.rejects(db.dataset.update({ where: { id }, data }), /DATASET_MODALITY_IMMUTABLE|dataset_modality_resolution_shape|violates check/i, JSON.stringify(data));
  }
  const before = await revision(id);
  await assert.rejects(db.dataset.update({ where: { id }, data: { modalityContentRevision: before - BigInt(1) > BigInt(-1) ? before - BigInt(1) : BigInt(-1) } }), /DATASET_MODALITY_FENCE_REWIND|dataset_modality_revision/i, "the fence counter cannot rewind");
  await db.dataset.update({ where: { id }, data: { name: "renamed" } }); // same-value modality fields: a normal metadata update is not blocked
  assert.equal((await db.dataset.findUniqueOrThrow({ where: { id }, select: { modality: true } })).modality, "IMAGE");
});

test("T033 all-Asset equality on INSERT and UPDATE: a mismatched insert, a modality change and a datasetId change to another modality are rejected and leave Dataset fences and the Asset untouched", { skip: !enabled }, async () => {
  const { make } = await setup();
  const image = await make(Modality.IMAGE), text = await make(Modality.TEXT);
  await assert.rejects(newAsset(image, Modality.TEXT), /ASSET_MODALITY_MISMATCH/);
  const asset = await newAsset(image, Modality.IMAGE);
  const fenceBefore = [await revision(image), await revision(text)];
  await assert.rejects(db.asset.update({ where: { id: asset.id }, data: { modality: Modality.TEXT } }), /ASSET_MODALITY_MISMATCH/, "modality change under a resolved parent");
  await assert.rejects(db.asset.update({ where: { id: asset.id }, data: { datasetId: text } }), /ASSET_MODALITY_MISMATCH/, "reparent into a Dataset of another modality");
  assert.deepEqual([await revision(image), await revision(text)], fenceBefore, "rejected writes roll back the fence increments");
  assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { datasetId: true } })).datasetId, image);
});

test("T033 reparent both ways between same-modality Datasets, fence membership vs display writes, soft-delete/restore and delete (phase029_guard_asset_write)", { skip: !enabled }, async () => {
  const { make } = await setup();
  const a = await make(Modality.AUDIO), b = await make(Modality.AUDIO);
  const asset = await newAsset(a, Modality.AUDIO);
  const [ra, rb] = [await revision(a), await revision(b)];
  await db.asset.update({ where: { id: asset.id }, data: { filename: "display-only.wav" } });
  assert.equal(await revision(a), ra, "display-only writes do not take the fence");
  await db.asset.update({ where: { id: asset.id }, data: { sizeBytes: BigInt(11) } });
  assert.equal(await revision(a), ra + BigInt(1), "source-identity writes bump the parent fence once");
  await db.asset.update({ where: { id: asset.id }, data: { datasetId: b } });
  assert.equal(await revision(a), ra + BigInt(2), "reparent fences the OLD parent");
  assert.equal(await revision(b), rb + BigInt(1), "reparent fences the NEW parent");
  await db.asset.update({ where: { id: asset.id }, data: { datasetId: a } });
  assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { datasetId: true } })).datasetId, a, "reparent back");
  // soft delete then restore: equality still holds and nothing is rejected
  await db.asset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
  await db.asset.update({ where: { id: asset.id }, data: { deletedAt: null } });
  assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { deletedAt: true } })).deletedAt, null, "restore");
  const beforeDelete = await revision(a);
  await db.asset.delete({ where: { id: asset.id } });
  assert.equal(await revision(a), beforeDelete + BigInt(1), "delete fences the parent");
});

test("T033 deleted children count: a soft-deleted Asset of another modality prevents a later modality assignment and a Dataset cascade delete still works", { skip: !enabled }, async () => {
  const { make } = await setup();
  const id = await make(Modality.VIDEO);
  const asset = await newAsset(id, Modality.VIDEO);
  await db.asset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
  await assert.rejects(db.asset.update({ where: { id: asset.id }, data: { modality: Modality.IMAGE } }), /ASSET_MODALITY_MISMATCH/, "deleted rows are still equality-checked");
  await db.dataset.delete({ where: { id } }); // legitimate cascade
  datasets.splice(datasets.indexOf(id), 1);
  assert.equal(await db.asset.count({ where: { id: asset.id } }), 0);
});
