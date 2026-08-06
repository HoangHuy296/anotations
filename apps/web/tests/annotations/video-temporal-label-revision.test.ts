import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { Modality, UserRole } from "@internal/db";

import {
  createVideoTemporalLabel,
  deleteVideoTemporalLabel,
  updateVideoTemporalLabel,
} from "@/lib/annotations/video-temporal-label-service";
import { db } from "@/lib/db";
import {
  cleanupAnnotationFixture,
  createAnnotationDataset,
  createAnnotationUser,
} from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_RACE_TESTS === "1";
const suffix = randomBytes(6).toString("hex");
let actor: { id: string; email: string; name: string; role: UserRole };
let datasetId = "";
let assetId = "";
let trackId = "";

async function createTemporal(startMs: number, endMs: number) {
  const result = await createVideoTemporalLabel(actor, assetId, {
    type: "EVENT",
    startMs,
    endMs,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Temporal fixture creation failed");
  return result.value;
}

before(async () => {
  if (!enabled) return;
  const user = await createAnnotationUser(UserRole.MANAGER);
  actor = { id: user.id, email: user.email, name: user.name, role: UserRole.MANAGER };
  datasetId = (await createAnnotationDataset(user.id)).id;
  assetId = (await db.asset.create({
    data: {
      datasetId,
      modality: Modality.VIDEO,
      filename: `temporal-race-${suffix}.mp4`,
      mimeType: "video/mp4",
      durationMs: 10_000,
      sourceFingerprint: `temporal-race-${suffix}`,
    },
    select: { id: true },
  })).id;
  const videoAsset = await db.videoAsset.create({ data: { assetId }, select: { id: true } });
  trackId = (await db.videoObjectTrack.create({
    data: {
      videoAssetId: videoAsset.id,
      createdById: actor.id,
      annotationType: "BOUNDING_BOX",
      interpolationMode: "LINEAR",
    },
    select: { id: true },
  })).id;
});

after(async () => {
  if (enabled) await cleanupAnnotationFixture([actor.id], [datasetId]);
});

test("same temporal revision has one winner and preserves the local resource's Track isolation", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with PostgreSQL." }, async () => {
  const label = await createTemporal(100, 900);
  const [first, second] = await Promise.all([
    updateVideoTemporalLabel(actor, label.id, { expectedRevision: 1, startMs: 200, endMs: 1_000 }),
    updateVideoTemporalLabel(actor, label.id, { expectedRevision: 1, startMs: 300, endMs: 1_100 }),
  ]);
  assert.equal([first, second].filter((result) => result.ok).length, 1);
  assert.equal([first, second].filter((result) => !result.ok && result.reason === "CONFLICT").length, 1);
  const persisted = await db.annotation.findUniqueOrThrow({ where: { id: label.id }, select: { revision: true, startMs: true, endMs: true } });
  assert.equal(persisted.revision, 2);
  assert.ok((persisted.startMs === 200 && persisted.endMs === 1_000) || (persisted.startMs === 300 && persisted.endMs === 1_100));
  assert.equal((await db.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: { revision: true } })).revision, 1);
});

test("independent temporal labels advance independently; update versus delete has one terminal result", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with PostgreSQL." }, async () => {
  const [left, right] = await Promise.all([createTemporal(1_000, 2_000), createTemporal(3_000, 4_000)]);
  const [leftUpdate, rightUpdate] = await Promise.all([
    updateVideoTemporalLabel(actor, left.id, { expectedRevision: 1, startMs: 1_100, endMs: 2_100 }),
    updateVideoTemporalLabel(actor, right.id, { expectedRevision: 1, startMs: 3_100, endMs: 4_100 }),
  ]);
  assert.equal(leftUpdate.ok, true);
  assert.equal(rightUpdate.ok, true);

  const target = await createTemporal(5_000, 6_000);
  const [updated, deleted] = await Promise.all([
    updateVideoTemporalLabel(actor, target.id, { expectedRevision: 1, startMs: 5_100, endMs: 6_100 }),
    deleteVideoTemporalLabel(actor, target.id, 1),
  ]);
  assert.equal([updated, deleted].filter((result) => result.ok).length, 1);
  const row = await db.annotation.findUnique({ where: { id: target.id }, select: { revision: true } });
  if (row) assert.equal(row.revision, 2, "a surviving label must have exactly one successful revision increment");
  assert.equal((await db.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: { revision: true } })).revision, 1);
});
