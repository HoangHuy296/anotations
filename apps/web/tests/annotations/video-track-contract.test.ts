import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { Modality, UserRole } from "@internal/db";

import { createVideoObjectTrack, deleteVideoObjectTrack, updateVideoObjectTrack } from "@/lib/annotations/video-track-service";
import { db } from "@/lib/db";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_SERVICE_TESTS === "1";
const suffix = randomBytes(6).toString("hex");
let actor: { id: string; email: string; name: string; role: UserRole };
let datasetId = "";
let assetId = "";
let labelId = "";

before(async () => {
  if (!enabled) return;
  const user = await createAnnotationUser(UserRole.MANAGER);
  actor = { id: user.id, email: user.email, name: user.name, role: UserRole.MANAGER };
  datasetId = (await createAnnotationDataset(user.id)).id;
  assetId = (await db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `track-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 5000, sourceFingerprint: `track-${suffix}` }, select: { id: true } })).id;
  await db.videoAsset.create({ data: { assetId } });
  labelId = (await db.label.create({ data: { datasetId, modality: Modality.VIDEO, name: `track-${suffix}`, normalizedName: `track-${suffix}`, color: "#0EA5E9" }, select: { id: true } })).id;
});
after(async () => { if (enabled) await cleanupAnnotationFixture([actor.id], [datasetId]); });

test("Track lifecycle starts at revision one and stale metadata writes do not mutate it", { skip: enabled ? false : "Set VIDEO_ANNOTATION_SERVICE_TESTS=1 with PostgreSQL." }, async () => {
  const created = await createVideoObjectTrack(actor, assetId, { name: "Car", labelId, interpolationMode: "LINEAR", properties: { occluded: false } });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.revision, 1);
  const updated = await updateVideoObjectTrack(actor, created.value.id, { expectedTrackRevision: 1, name: "Vehicle", interpolationMode: "NONE", properties: { occluded: true } });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.value.revision, 2);
  assert.equal(updated.value.interpolationMode, "NONE");
  const stale = await updateVideoObjectTrack(actor, created.value.id, { expectedTrackRevision: 1, name: "stale" });
  assert.deepEqual(stale, { ok: false, reason: "CONFLICT" });
  const persisted = await db.videoObjectTrack.findUniqueOrThrow({ where: { id: created.value.id }, select: { revision: true, name: true, interpolationMode: true } });
  assert.deepEqual(persisted, { revision: 2, name: "Vehicle", interpolationMode: "NONE" });
  const deleted = await deleteVideoObjectTrack(actor, created.value.id, 2);
  assert.deepEqual(deleted, { ok: true, value: null });
  assert.equal(await db.videoObjectTrack.count({ where: { id: created.value.id } }), 0);
});
