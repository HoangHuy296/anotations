import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { Modality, StorageProvider, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { resolveAiTarget } from "@/lib/ai/ai-target-service";
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

test("mixed modality is rejected atomically; VIDEO batches and AUDIO are unverified in v1 while one VIDEO Asset keeps working", { skip: !enabled }, async () => {
  const datasetId = await fixtureDataset();
  const image = await asset(datasetId);
  const videoA = await asset(datasetId, { modality: Modality.VIDEO, mimeType: "video/mp4", filename: "v1.mp4" });
  const videoB = await asset(datasetId, { modality: Modality.VIDEO, mimeType: "video/mp4", filename: "v2.mp4" });
  const audio = await asset(datasetId, { modality: Modality.AUDIO, mimeType: "audio/wav", filename: "a.wav" });
  const code = async (assetIds: string[]) => { const r = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds } }); return r.ok ? "OK" : r.code; };
  assert.equal(await code([image.id, videoA.id]), "TARGET_MIXED_MODALITY");
  assert.equal(await code([image.id, audio.id]), "TARGET_MIXED_MODALITY");
  assert.equal(await code([videoA.id, videoB.id]), "AI_CAPABILITY_UNVERIFIED");
  assert.equal(await code([audio.id]), "AI_CAPABILITY_UNVERIFIED");
  assert.equal(await code([videoA.id]), "OK");
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
