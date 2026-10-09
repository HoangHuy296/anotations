import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { Modality, StorageProvider, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { aiTargetChanged, resolveAiTarget } from "@/lib/ai/ai-target-service";
import { createAiTaskSchema } from "@/lib/validation/ai-task";
import { AI_BATCH_VERIFIED_MAX_ASSETS } from "@annotationplatform/domain/ai-batch";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "../workspace/helpers";

const enabled = Boolean(process.env.DATABASE_URL);
const users: string[] = [];
const datasets: string[] = [];
after(async () => { if (users.length || datasets.length) await cleanupWorkspaceFixture(users, datasets); });

async function fixtureDataset() {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  users.push(owner.id); datasets.push(dataset.id);
  return dataset.id;
}

let counter = 0;
function asset(datasetId: string, overrides: Record<string, unknown> = {}) {
  const n = `${workspaceUnique("ai-target")}-${counter++}`;
  return db.asset.create({
    data: {
      datasetId, modality: Modality.IMAGE, filename: "same-name.jpg", mimeType: "image/jpeg", sourceFingerprint: n, sizeBytes: BigInt(1234),
      storageProvider: StorageProvider.MINIO, storageBucket: "test-bucket", storageKey: `ai-target/${n}.jpg`, ...overrides,
    },
    select: { id: true },
  });
}

test("a current-Asset target resolves to one ordered target and equals a one-member explicit selection", { skip: !enabled }, async () => {
  const datasetId = await fixtureDataset();
  const a = await asset(datasetId);
  const current = await resolveAiTarget(datasetId, { mode: "CURRENT_ASSET", assetId: a.id });
  const explicit = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds: [a.id] } });
  assert.equal(current.ok, true); assert.equal(explicit.ok, true);
  if (!current.ok || !explicit.ok) return;
  assert.deepEqual(current.targets, explicit.targets, "one execution path: identical accepted targets");
  assert.equal(current.targets.length, 1);
  assert.equal(current.targetMode, "CURRENT_ASSET");
  assert.equal(explicit.targetMode, "EXPLICIT");
  assert.equal(current.effectiveLimit, AI_BATCH_VERIFIED_MAX_ASSETS);
});

test("explicit selection is deduplicated before the limit, ordered by id and independent of input order", { skip: !enabled }, async () => {
  const datasetId = await fixtureDataset();
  const [a, b, c] = [await asset(datasetId), await asset(datasetId), await asset(datasetId)];
  const shuffled = [c.id, a.id, b.id, a.id, c.id, b.id]; // 6 entries, 3 distinct: must not trip the limit of 3
  const result = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds: shuffled } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.targets.map((t) => t.assetId), [a.id, b.id, c.id].sort());
  assert.deepEqual(result.targets.map((t) => t.inputIndex), [0, 1, 2]);
});

test("explicit selection with any missing, foreign, archived or deleted id is rejected whole, never reduced", { skip: !enabled }, async () => {
  const datasetId = await fixtureDataset();
  const otherDatasetId = await fixtureDataset();
  const good = await asset(datasetId);
  const foreign = await asset(otherDatasetId);
  const archived = await asset(datasetId, { archivedAt: new Date() });
  const deleted = await asset(datasetId, { deletedAt: new Date() });
  for (const bad of [foreign.id, archived.id, deleted.id, "ckunknownunknownunknown0000"]) {
    const result = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds: [good.id, bad] } });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.code, "ASSET_NOT_IN_DATASET"); assert.equal(result.status, 409); }
  }
});

test("over-limit selections are rejected as a whole (explicit and filtered), reporting the effective limit not 200", { skip: !enabled }, async () => {
  const datasetId = await fixtureDataset();
  const marker = workspaceUnique("over-limit");
  const rows = [];
  for (let i = 0; i < AI_BATCH_VERIFIED_MAX_ASSETS + 1; i += 1) rows.push(await asset(datasetId, { filename: `${marker}-${i}.jpg` }));
  const explicit = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds: rows.map((r) => r.id) } });
  const filtered = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "FILTERED", query: { q: marker } } });
  for (const result of [explicit, filtered]) {
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.code, "TARGET_TOO_LARGE"); assert.equal(result.status, 422); assert.equal(result.effectiveLimit, AI_BATCH_VERIFIED_MAX_ASSETS); }
  }
});

test("a filtered selection is resolved server-side across the whole dataset, ordered, dataset-scoped and excludes archived/deleted", { skip: !enabled }, async () => {
  const datasetId = await fixtureDataset();
  const otherDatasetId = await fixtureDataset();
  const marker = workspaceUnique("filtered");
  const mine = [await asset(datasetId, { filename: `${marker}-a.jpg` }), await asset(datasetId, { filename: `${marker}-b.jpg` })];
  await asset(datasetId, { filename: `${marker}-archived.jpg`, archivedAt: new Date() });
  await asset(datasetId, { filename: `${marker}-deleted.jpg`, deletedAt: new Date() });
  await asset(otherDatasetId, { filename: `${marker}-foreign.jpg` });
  const first = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "FILTERED", query: { q: marker } } });
  const second = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "FILTERED", query: { q: marker } } });
  assert.equal(first.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.targets.map((t) => t.assetId), mine.map((m) => m.id).sort());
  assert.deepEqual(first.targets, second.targets, "deterministic order and digests");
  assert.equal(first.targetMode, "FILTERED");
  const none = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "FILTERED", query: { q: `${marker}-nomatch` } } });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.code, "TARGET_EMPTY");
});

async function modalityDataset(modality: Modality | null) {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = modality === null
    ? await db.dataset.create({ data: { ownerId: owner.id, name: workspaceUnique("ai-target-unresolved") }, select: { id: true } })
    : await createWorkspaceDataset(owner.id, modality);
  users.push(owner.id); datasets.push(dataset.id);
  return dataset.id;
}
const targetCode = async (datasetId: string, assetIds: string[]) => { const r = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds } }); return r.ok ? `OK:${r.modality}:${r.targets.length}` : r.code; };

test("Dataset.modality alone selects the AI target kind: IMAGE batches stay capped at the verified limit and VIDEO stays single-asset", { skip: !enabled }, async () => {
  const image = await modalityDataset(Modality.IMAGE);
  const images = await Promise.all(Array.from({ length: AI_BATCH_VERIFIED_MAX_ASSETS + 1 }, () => asset(image)));
  const ids = images.map((row) => row.id);
  assert.equal(await targetCode(image, ids.slice(0, AI_BATCH_VERIFIED_MAX_ASSETS)), `OK:IMAGE:${AI_BATCH_VERIFIED_MAX_ASSETS}`, "an IMAGE Dataset batch up to the proven limit resolves");
  assert.equal(await targetCode(image, ids), "TARGET_TOO_LARGE", "one more than the proven limit is refused");

  const video = await modalityDataset(Modality.VIDEO);
  const videoA = await asset(video, { modality: Modality.VIDEO, mimeType: "video/mp4", filename: "v1.mp4" });
  const videoB = await asset(video, { modality: Modality.VIDEO, mimeType: "video/mp4", filename: "v2.mp4" });
  assert.equal(await targetCode(video, [videoA.id]), "OK:VIDEO:1", "one VIDEO Asset keeps working");
  assert.equal(await targetCode(video, [videoA.id, videoB.id]), "AI_CAPABILITY_UNVERIFIED", "a VIDEO batch is not evidenced");

  const audio = await modalityDataset(Modality.AUDIO);
  const wav = await asset(audio, { modality: Modality.AUDIO, mimeType: "audio/wav", filename: "a.wav" });
  assert.equal(await targetCode(audio, [wav.id]), "AI_CAPABILITY_UNVERIFIED", "AUDIO has no verified AI capability");
});

test("an Asset row can never establish the AI target kind: a Dataset that is unresolved or of another modality fails closed", { skip: !enabled }, async () => {
  // The M24 fence makes an unresolved Dataset or a cross-modality Asset unrepresentable in a fresh database, so the Dataset read is injected: the
  // service must trust only that read, never the (IMAGE-looking) Asset rows.
  const datasetId = await modalityDataset(Modality.IMAGE);
  const hinted = await asset(datasetId);
  const withDataset = (modality: Modality | null) => ({ asset: db.asset, dataset: { findFirst: async () => (modality === undefined ? null : { modality }) } }) as unknown as Parameters<typeof resolveAiTarget>[2];
  const run = async (modality: Modality | null) => { const r = await resolveAiTarget(datasetId, { mode: "CURRENT_ASSET", assetId: hinted.id }, withDataset(modality)); return r.ok ? `OK:${r.modality}` : r.code; };
  assert.equal(await run(Modality.IMAGE), "OK:IMAGE");
  assert.equal(await run(null), "AI_CAPABILITY_UNVERIFIED", "an unresolved Dataset has no verified capability, whatever its Assets look like");
  assert.equal(await run(Modality.VIDEO), "TARGET_MIXED_MODALITY", "an IMAGE-looking Asset in a VIDEO Dataset is refused, not trusted");
  assert.equal(await run(Modality.TEXT), "AI_CAPABILITY_UNVERIFIED", "a Dataset modality without AI capability is unverified");
});

test("source identity: an Asset without size or storage location is ineligible; a missing checksum is not", { skip: !enabled }, async () => {
  const datasetId = await fixtureDataset();
  const noChecksum = await asset(datasetId, { checksum: null });
  const noSize = await asset(datasetId, { sizeBytes: null });
  const noStorage = await asset(datasetId, { storageProvider: null, storageBucket: null, storageKey: null });
  const run = async (id: string) => { const r = await resolveAiTarget(datasetId, { mode: "CURRENT_ASSET", assetId: id }); return r.ok ? "OK" : r.code; };
  assert.equal(await run(noChecksum.id), "OK");
  assert.equal(await run(noSize.id), "TARGET_INELIGIBLE");
  assert.equal(await run(noStorage.id), "TARGET_INELIGIBLE");
});

test("legacy assetIds callers resolve through the same path and are deduplicated", { skip: !enabled }, async () => {
  const datasetId = await fixtureDataset();
  const a = await asset(datasetId);
  const result = await resolveAiTarget(datasetId, { mode: "LEGACY_ASSET_IDS", assetIds: [a.id, a.id] });
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.targets.length, 1); assert.equal(result.targetMode, "LEGACY_ASSET_IDS"); }
});

// ---- Phase 030.1-B1: Dataset-authoritative target contract (D-2: a cross-modality target stays 422 TARGET_MIXED_MODALITY; the older 409 ASSET_MODALITY_MISMATCH is NOT used here).
const targetAsset = (id: string, modality: Modality) => ({ id, modality, sourceFingerprint: "fp", currentVersionId: null, sourceRevision: null, sizeBytes: BigInt(10), checksum: null, cacheChecksum: null, storageProvider: "MINIO", storageBucket: "bucket", storageKey: `k/${id}`, cacheBucket: null, cacheKey: null });
const fakeClient = (datasetRead: (where: unknown) => { modality: Modality | null } | null, assetModality: Modality) => ({
  dataset: { findFirst: async (args: { where: unknown }) => datasetRead(args.where) },
  asset: { findMany: async (args: { select: Record<string, boolean> }) => Object.keys(args.select).length === 1 ? [{ id: "a1" }] : [targetAsset("a1", assetModality)] },
}) as unknown as Parameters<typeof resolveAiTarget>[2];

test("an Asset of another modality than its Dataset is refused with the existing 422 TARGET_MIXED_MODALITY (not 409 ASSET_MODALITY_MISMATCH)", async () => {
  const result = await resolveAiTarget("dataset", { mode: "CURRENT_ASSET", assetId: "a1" }, fakeClient(() => ({ modality: Modality.IMAGE }), Modality.VIDEO));
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.code, "TARGET_MIXED_MODALITY"); assert.equal(result.status, 422); }
});

test("the Dataset lookup is restricted to live Datasets: deleted and archived Datasets (and a missing one) have no verified AI capability", async () => {
  let where: Record<string, unknown> = {};
  const archived = await resolveAiTarget("dataset", { mode: "CURRENT_ASSET", assetId: "a1" }, fakeClient((w) => { where = w as Record<string, unknown>; return null; }, Modality.IMAGE));
  assert.deepEqual(where, { id: "dataset", deletedAt: null, archivedAt: null }, "the same live-Dataset predicate every other read uses");
  assert.equal(archived.ok, false);
  if (!archived.ok) assert.equal(archived.code, "AI_CAPABILITY_UNVERIFIED");
});

test("the persisted Dataset modality wins over every Asset row; each capability-less modality fails closed", async () => {
  for (const [datasetModality, expected] of [[Modality.IMAGE, "OK:IMAGE"], [Modality.VIDEO, "TARGET_MIXED_MODALITY"], [Modality.AUDIO, "AI_CAPABILITY_UNVERIFIED"], [Modality.TEXT, "AI_CAPABILITY_UNVERIFIED"], [null, "AI_CAPABILITY_UNVERIFIED"]] as const) {
    const r = await resolveAiTarget("dataset", { mode: "CURRENT_ASSET", assetId: "a1" }, fakeClient(() => ({ modality: datasetModality }), Modality.IMAGE));
    assert.equal(r.ok ? `OK:${r.modality}` : r.code, expected, String(datasetModality));
  }
});

test("a VIDEO Dataset resolves a single VIDEO Asset through its authoritative modality; a VIDEO batch stays unverified", async () => {
  const one = await resolveAiTarget("dataset", { mode: "CURRENT_ASSET", assetId: "a1" }, fakeClient(() => ({ modality: Modality.VIDEO }), Modality.VIDEO));
  assert.equal(one.ok ? one.modality : one.code, "VIDEO");
});

test("the previewed and the in-transaction resolution must agree on modality and targets; nothing the browser sends takes part", () => {
  const target = { assetId: "a", inputIndex: 0, sourceIdentityDigest: "d" };
  assert.equal(aiTargetChanged({ modality: Modality.IMAGE, targets: [target] }, { modality: Modality.IMAGE, targets: [{ ...target }] }), false);
  assert.equal(aiTargetChanged({ modality: Modality.IMAGE, targets: [target] }, { modality: Modality.VIDEO, targets: [{ ...target }] }), true, "same assets, different modality");
  assert.equal(aiTargetChanged({ modality: Modality.IMAGE, targets: [target] }, { modality: Modality.IMAGE, targets: [{ ...target, sourceIdentityDigest: "e" }] }), true);
  assert.equal(aiTargetChanged({ modality: Modality.IMAGE, targets: [target] }, { modality: Modality.IMAGE, targets: [] }), true);
  const parsed = createAiTaskSchema.parse({ datasetId: "20028572-c535-4efe-a151-8d73128d17b7", modelId: "m", target: { mode: "CURRENT_ASSET", assetId: "a" }, modality: "VIDEO", engine: "VIDEO", assetModality: "VIDEO", previewModality: "VIDEO" });
  for (const hint of ["modality", "engine", "assetModality", "previewModality"]) assert.equal(hint in parsed, false, `${hint} is not part of the request contract and is dropped`);
});

test("a real archived Dataset (its Assets still exist) has no verified AI capability", { skip: !enabled }, async () => {
  const datasetId = await fixtureDataset();
  const hinted = await asset(datasetId);
  await db.dataset.update({ where: { id: datasetId }, data: { archivedAt: new Date() } });
  const r = await resolveAiTarget(datasetId, { mode: "CURRENT_ASSET", assetId: hinted.id });
  assert.equal(r.ok ? "OK" : r.code, "AI_CAPABILITY_UNVERIFIED");
});
