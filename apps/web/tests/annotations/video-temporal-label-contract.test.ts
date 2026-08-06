import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { Modality, UserRole } from "@internal/db";

import {
  createVideoTemporalLabel,
  deleteVideoTemporalLabel,
  updateVideoTemporalLabel,
} from "@/lib/annotations/video-temporal-label-service";
import { createVideoObjectTrack } from "@/lib/annotations/video-track-service";
import { db } from "@/lib/db";
import {
  cleanupAnnotationFixture,
  createAnnotationDataset,
  createAnnotationUser,
} from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_SERVICE_TESTS === "1";
const suffix = randomBytes(6).toString("hex");
let actor: { id: string; email: string; name: string; role: UserRole };
let datasetId = "";
let assetId = "";
let labelId = "";
let replacementLabelId = "";

before(async () => {
  if (!enabled) return;
  const user = await createAnnotationUser(UserRole.MANAGER);
  actor = { id: user.id, email: user.email, name: user.name, role: UserRole.MANAGER };
  datasetId = (await createAnnotationDataset(user.id)).id;
  assetId = (await db.asset.create({
    data: {
      datasetId,
      modality: Modality.VIDEO,
      filename: `temporal-contract-${suffix}.mp4`,
      mimeType: "video/mp4",
      durationMs: 5_000,
      sourceFingerprint: `temporal-contract-${suffix}`,
    },
    select: { id: true },
  })).id;
  await db.videoAsset.create({ data: { assetId } });
  labelId = (await db.label.create({
    data: {
      datasetId,
      modality: Modality.VIDEO,
      name: `temporal-${suffix}`,
      normalizedName: `temporal-${suffix}`,
      color: "#0EA5E9",
    },
    select: { id: true },
  })).id;
  replacementLabelId = (await db.label.create({
    data: {
      datasetId,
      modality: Modality.VIDEO,
      name: `temporal-replacement-${suffix}`,
      normalizedName: `temporal-replacement-${suffix}`,
      color: "#F97316",
    },
    select: { id: true },
  })).id;
});

after(async () => {
  if (enabled) await cleanupAnnotationFixture([actor.id], [datasetId]);
});

test("temporal labels use Annotation revision independently from Track revision", { skip: enabled ? false : "Set VIDEO_ANNOTATION_SERVICE_TESTS=1 with PostgreSQL." }, async () => {
  const track = await createVideoObjectTrack(actor, assetId, { name: "unaffected track" });
  assert.equal(track.ok, true);
  if (!track.ok) return;

  const created = await createVideoTemporalLabel(actor, assetId, {
    type: "EVENT",
    labelId,
    startMs: 100,
    endMs: 900,
    properties: { source: "manual" },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.revision, 1);

  const updated = await updateVideoTemporalLabel(actor, created.value.id, {
    expectedRevision: 1,
    labelId: replacementLabelId,
    startMs: 200,
    endMs: 1_000,
    properties: { source: "edited" },
  });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.value.revision, 2);
  assert.equal(updated.value.labelId, replacementLabelId);

  const stale = await updateVideoTemporalLabel(actor, created.value.id, {
    expectedRevision: 1,
    startMs: 300,
    endMs: 1_100,
  });
  assert.deepEqual(stale, { ok: false, reason: "CONFLICT" });

  const invalidRange = await updateVideoTemporalLabel(actor, created.value.id, {
    expectedRevision: 2,
    startMs: 4_900,
    endMs: 5_100,
  });
  assert.deepEqual(invalidRange, { ok: false, reason: "INVALID_REQUEST" });

  const persistedTrack = await db.videoObjectTrack.findUniqueOrThrow({
    where: { id: track.value.id },
    select: { revision: true },
  });
  assert.equal(persistedTrack.revision, 1, "standalone temporal labels must not mutate Track revision");

  const deleted = await deleteVideoTemporalLabel(actor, created.value.id, 2);
  assert.deepEqual(deleted, { ok: true, value: null });
  assert.equal(await db.annotation.count({ where: { id: created.value.id } }), 0);
});
