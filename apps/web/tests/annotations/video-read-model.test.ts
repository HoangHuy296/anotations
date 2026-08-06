import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { AnnotationSource, AnnotationStatus, AnnotationType, Modality, UserRole } from "@internal/db";

import { readVideoAnnotations } from "@/lib/annotations/video-read-service";
import { db } from "@/lib/db";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_READ_MODEL_TESTS === "1";
const suffix = randomBytes(6).toString("hex");
let user: { id: string; role: UserRole; email: string; name: string };
let datasetId = "";
let populatedAssetId = "";
let emptyAssetId = "";

function assertRedacted(value: unknown) {
  const text = JSON.stringify(value).toLowerCase();
  for (const forbidden of ["storagekey", "storagebucket", "sourceconnection", "token", "password", "stack", "frameindex"]) assert.equal(text.includes(forbidden), false, `safe read projection leaked ${forbidden}`);
}

before(async () => {
  if (!enabled) return;
  const created = await createAnnotationUser(UserRole.MANAGER);
  user = { id: created.id, role: UserRole.MANAGER, email: created.email, name: created.name };
  const dataset = await createAnnotationDataset(user.id);
  datasetId = dataset.id;
  const [populated, empty] = await Promise.all([
    db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `read-model-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 5000, sourceFingerprint: `read-model-${suffix}` }, select: { id: true } }),
    db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `empty-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 5000, sourceFingerprint: `empty-${suffix}` }, select: { id: true } }),
  ]);
  populatedAssetId = populated.id; emptyAssetId = empty.id;
  const video = await db.videoAsset.create({ data: { assetId: populatedAssetId, fps: 25 }, select: { id: true } });
  await db.videoAsset.create({ data: { assetId: emptyAssetId, fps: 25 } });
  const track = await db.videoObjectTrack.create({ data: { videoAssetId: video.id, createdById: user.id, name: "linear", annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } });
  await db.annotation.createMany({ data: [
    { datasetId, assetId: populatedAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0, y: 0, width: 0.2, height: 0.2 }, trackId: track.id, timestampMs: 1000, isKeyframe: true },
    { datasetId, assetId: populatedAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, trackId: track.id, timestampMs: 3000, isKeyframe: true },
  ] });
});

after(async () => { if (enabled) await cleanupAnnotationFixture([user.id], [datasetId]); });

test("Video read returns an empty safe DTO for an authorized empty Asset", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, emptyAssetId);
  assert.deepEqual(read?.tracks, []);
  assert.deepEqual(read?.keyframes, []);
  assert.deepEqual(read?.temporalLabels, []);
  assertRedacted(read);
});

test("bounded reads derive interpolation from persisted bracketing keyframes without returning out-of-window rows", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, populatedAssetId, { fromMs: 2000, toMs: 2100, limit: 100 });
  assert.ok(read);
  assert.deepEqual(read.keyframes, []);
  assert.equal(read.interpolation.length, 1);
  assert.deepEqual(read.interpolation[0] && { kind: read.interpolation[0].kind, x: read.interpolation[0].x, y: read.interpolation[0].y, width: read.interpolation[0].width, height: read.interpolation[0].height }, { kind: "BOUNDING_BOX", x: 0.2, y: 0.2, width: 0.2, height: 0.2 });
  assert.equal(read.interpolation[0]?.timestampMs, 2000);
  assertRedacted(read);
});
