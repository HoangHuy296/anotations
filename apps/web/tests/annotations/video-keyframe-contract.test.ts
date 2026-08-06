import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { AnnotationType, Modality, UserRole } from "@internal/db";

import { createVideoKeyframe, deleteVideoKeyframe, updateVideoKeyframe } from "@/lib/annotations/video-keyframe-service";
import { createVideoObjectTrack } from "@/lib/annotations/video-track-service";
import { db } from "@/lib/db";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_SERVICE_TESTS === "1";
const suffix = randomBytes(6).toString("hex");
let actor: { id: string; email: string; name: string; role: UserRole };
let datasetId = "";
let assetId = "";
let trackId = "";

const geometry = { kind: "BOUNDING_BOX" as const, x: 0.1, y: 0.1, width: 0.2, height: 0.2 };

before(async () => {
  if (!enabled) return;
  const user = await createAnnotationUser(UserRole.MANAGER);
  actor = { id: user.id, email: user.email, name: user.name, role: UserRole.MANAGER };
  datasetId = (await createAnnotationDataset(user.id)).id;
  assetId = (await db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `keyframe-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 5000, sourceFingerprint: `keyframe-${suffix}` }, select: { id: true } })).id;
  await db.videoAsset.create({ data: { assetId } });
  const track = await createVideoObjectTrack(actor, assetId, { name: "object" });
  assert.equal(track.ok, true);
  if (track.ok) trackId = track.value.id;
});
after(async () => { if (enabled) await cleanupAnnotationFixture([actor.id], [datasetId]); });

test("keyframe lifecycle uses only Track revision and duplicate timestamps roll back", { skip: enabled ? false : "Set VIDEO_ANNOTATION_SERVICE_TESTS=1 with PostgreSQL." }, async () => {
  const created = await createVideoKeyframe(actor, trackId, { expectedTrackRevision: 1, timestampMs: 1000, geometry });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.track.revision, 2);
  assert.equal(created.value.keyframe.revision, 1);
  const moved = await updateVideoKeyframe(actor, created.value.keyframe.id, { expectedTrackRevision: 2, timestampMs: 2000, geometry: { ...geometry, x: 0.2 } });
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.equal(moved.value.track.revision, 3);
  assert.equal(moved.value.keyframe.revision, 1, "keyframe Annotation revision is not the Track client lock");
  const beforeDuplicate = await db.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: { revision: true } });
  const duplicate = await createVideoKeyframe(actor, trackId, { expectedTrackRevision: 3, timestampMs: 2000, geometry });
  assert.deepEqual(duplicate, { ok: false, reason: "DUPLICATE_TIMESTAMP" });
  const afterDuplicate = await db.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: { revision: true } });
  assert.deepEqual(afterDuplicate, beforeDuplicate, "partial-index failure rolls back Track revision");
  const invalid = await createVideoKeyframe(actor, trackId, { expectedTrackRevision: 3, timestampMs: -1, geometry });
  assert.deepEqual(invalid, { ok: false, reason: "INVALID_REQUEST" });
  const deleted = await deleteVideoKeyframe(actor, created.value.keyframe.id, 3);
  assert.equal(deleted.ok, true);
  assert.equal(await db.annotation.count({ where: { id: created.value.keyframe.id, type: AnnotationType.BOUNDING_BOX } }), 0);
});
