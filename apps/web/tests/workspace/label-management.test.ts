import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { createBoundingBox } from "@/lib/workspace/image-mutations";
import { deleteUnreferencedLabel, ensureDefaultImageLabels, seedDefaultImageLabelsIfEmpty } from "@/lib/workspace/label-management";
import { db } from "@/lib/db";
import { normalizeLabelName } from "@/lib/validation/label";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("custom label names use the same normalized taxonomy key", () => {
  assert.equal(normalizeLabelName("  Traffic Sign  "), "traffic sign");
});

test("an authorized dataset reader establishes idempotent default labels and referenced labels cannot be deleted", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
    const first = await ensureDefaultImageLabels(labeler, dataset.id);
    assert.deepEqual(first, { ok: true, created: 6 });
    const replay = await ensureDefaultImageLabels(owner, dataset.id);
    assert.deepEqual(replay, { ok: true, created: 0 });
    const labels = await db.label.findMany({ where: { datasetId: dataset.id }, orderBy: { normalizedName: "asc" }, select: { id: true, normalizedName: true } });
    assert.deepEqual(labels.map((label) => label.normalizedName), ["aidetect", "animal", "object", "person", "text", "vehicle"]);
    const asset = await createImageAsset(dataset.id);
    const annotation = await createBoundingBox(labeler, { datasetId: dataset.id, assetId: asset.id, labelId: labels[0]!.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(annotation.ok, true);
    assert.deepEqual(await deleteUnreferencedLabel(owner, labels[0]!.id), { ok: false, status: 409 });
    assert.deepEqual(await deleteUnreferencedLabel(labeler, labels[1]!.id), { ok: false, status: 403 });
    assert.deepEqual(await deleteUnreferencedLabel(owner, labels[1]!.id), { ok: true });
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]); }
});

test("default labels backfill only the missing ones into a dataset that already has custom labels", { skip: !enabled }, async () => {
  // Regression coverage: ensureDefaultImageLabels used to early-return
  // { created: 0 } for any dataset with >0 labels, so a dataset with even
  // one pre-existing custom label could never pick up a newly-added
  // DEFAULT_IMAGE_LABELS entry (e.g. "aidetect") -- contradicting the "Add
  // defaults" UI's own copy ("skips any name that already exists").
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await db.label.create({ data: { datasetId: dataset.id, modality: "IMAGE", name: "Traffic Sign", normalizedName: normalizeLabelName("Traffic Sign"), color: "#123456" } });
    const result = await ensureDefaultImageLabels(owner, dataset.id);
    assert.deepEqual(result, { ok: true, created: 6 });
    const labels = await db.label.findMany({ where: { datasetId: dataset.id }, select: { normalizedName: true } });
    assert.deepEqual(new Set(labels.map((label) => label.normalizedName)), new Set(["traffic sign", "aidetect", "animal", "object", "person", "text", "vehicle"]));
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("default labels are written for IMAGE and VIDEO datasets only; TEXT and AUDIO datasets never inherit them", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const datasets = [] as string[];
  try {
    for (const [modality, expected] of [["IMAGE", 6], ["VIDEO", 6], ["TEXT", 0], ["AUDIO", 0]] as const) {
      const dataset = await createWorkspaceDataset(owner.id, modality);
      datasets.push(dataset.id);
      assert.deepEqual(await ensureDefaultImageLabels(owner, dataset.id), { ok: true, created: expected }, modality);
      assert.deepEqual(await ensureDefaultImageLabels(owner, dataset.id), { ok: true, created: 0 }, `${modality} replay`);
      assert.equal(await db.label.count({ where: { datasetId: dataset.id } }), expected, `${modality} stored labels`);
      if (expected > 0) assert.equal(await db.label.count({ where: { datasetId: dataset.id, modality } }), expected, `${modality} defaults carry the Dataset modality`);
    }
  } finally { await cleanupWorkspaceFixture([owner.id], datasets); }
});

test("a VIDEO dataset whose defaults were stored as IMAGE is repaired in place without duplicating or losing labels", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id, "VIDEO");
  try {
    await db.label.createMany({ data: ["person", "object"].map((name) => ({ datasetId: dataset.id, modality: "IMAGE" as const, name, normalizedName: name, color: "#123456" })) });
    const before = await db.label.findMany({ where: { datasetId: dataset.id }, select: { id: true, normalizedName: true } });
    assert.deepEqual(await ensureDefaultImageLabels(owner, dataset.id), { ok: true, created: 4 });
    const after = await db.label.findMany({ where: { datasetId: dataset.id }, select: { id: true, normalizedName: true, modality: true, color: true } });
    assert.equal(after.length, 6);
    assert.ok(after.every((label) => label.modality === "VIDEO"));
    for (const old of before) assert.ok(after.some((label) => label.id === old.id && label.normalizedName === old.normalizedName), `${old.normalizedName} keeps its id`);
    assert.deepEqual(await ensureDefaultImageLabels(owner, dataset.id), { ok: true, created: 0 });
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

const DEFAULT_NAMES = ["aidetect", "animal", "object", "person", "text", "vehicle"];
const namesOf = async (datasetId: string) => (await db.label.findMany({ where: { datasetId }, orderBy: { normalizedName: "asc" }, select: { normalizedName: true } })).map((label) => label.normalizedName);

test("implicit default seeding creates the six defaults only for an empty dataset", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const empty = await createWorkspaceDataset(owner.id);
  const custom = await createWorkspaceDataset(owner.id);
  try {
    assert.deepEqual(await seedDefaultImageLabelsIfEmpty(owner, empty.id), { ok: true, created: 6 });
    assert.deepEqual(await namesOf(empty.id), DEFAULT_NAMES);
    assert.deepEqual(await seedDefaultImageLabelsIfEmpty(owner, empty.id), { ok: true, created: 0 }, "a second read is idempotent");
    // A dataset that already has one (custom) label is never topped up with the missing defaults.
    await db.label.create({ data: { datasetId: custom.id, modality: "IMAGE", name: "Traffic Sign", normalizedName: normalizeLabelName("Traffic Sign"), color: "#123456" } });
    assert.deepEqual(await seedDefaultImageLabelsIfEmpty(owner, custom.id), { ok: true, created: 0 });
    assert.deepEqual(await namesOf(custom.id), ["traffic sign"]);
  } finally { await cleanupWorkspaceFixture([owner.id], [empty.id, custom.id]); }
});

test("a removed default stays removed when /labels or the labels API is opened again; emptying the taxonomy re-seeds it", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await seedDefaultImageLabelsIfEmpty(owner, dataset.id);
    const labels = await db.label.findMany({ where: { datasetId: dataset.id }, orderBy: { normalizedName: "asc" }, select: { id: true, normalizedName: true } });
    const removed = labels.find((label) => label.normalizedName === "vehicle")!;
    assert.deepEqual(await deleteUnreferencedLabel(owner, removed.id), { ok: true });
    // "Reopening /labels" = the same implicit seeding call the page and the labels API make on every read.
    for (let reopen = 0; reopen < 2; reopen += 1) {
      assert.deepEqual(await seedDefaultImageLabelsIfEmpty(owner, dataset.id), { ok: true, created: 0 });
      assert.deepEqual(await namesOf(dataset.id), DEFAULT_NAMES.filter((name) => name !== "vehicle"));
    }
    // Removing every remaining label empties the taxonomy, so the next implicit read seeds the six defaults again.
    await db.label.deleteMany({ where: { datasetId: dataset.id } });
    assert.deepEqual(await seedDefaultImageLabelsIfEmpty(owner, dataset.id), { ok: true, created: 6 });
    assert.deepEqual(await namesOf(dataset.id), DEFAULT_NAMES);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("the explicit Add defaults action still backfills missing defaults and a referenced label is still protected (409)", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await seedDefaultImageLabelsIfEmpty(owner, dataset.id);
    const labels = await db.label.findMany({ where: { datasetId: dataset.id }, orderBy: { normalizedName: "asc" }, select: { id: true } });
    assert.deepEqual(await deleteUnreferencedLabel(owner, labels[1]!.id), { ok: true });
    assert.deepEqual(await ensureDefaultImageLabels(owner, dataset.id), { ok: true, created: 1 }, "explicit backfill restores only the removed one");
    const asset = await createImageAsset(dataset.id);
    const annotation = await createBoundingBox(owner, { datasetId: dataset.id, assetId: asset.id, labelId: labels[0]!.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(annotation.ok, true);
    assert.deepEqual(await deleteUnreferencedLabel(owner, labels[0]!.id), { ok: false, status: 409 });
    assert.deepEqual(await namesOf(dataset.id), DEFAULT_NAMES, "the referenced default survives");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("the /labels page and the dataset labels API seed only an empty taxonomy, never the backfilling helper", () => {
  const labelsPage = readFileSync(new URL("../../src/app/(app)/labels/page.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../../src/app/api/datasets/[datasetId]/labels/route.ts", import.meta.url), "utf8");
  for (const [name, source] of [["labels page", labelsPage], ["labels API route", route]] as const) {
    assert.match(source, /seedDefaultImageLabelsIfEmpty\(/, `${name} seeds through the seed-if-empty helper`);
    assert.doesNotMatch(source, /ensureDefaultImageLabels\(/, `${name} must not call the backfill-missing helper`);
  }
});
