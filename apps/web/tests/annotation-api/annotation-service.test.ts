import assert from "node:assert/strict";
import test from "node:test";

import { AnnotationSource, AnnotationStatus, AnnotationType, Modality, UserRole } from "@internal/db";

import { mutateImageAnnotations, readAssetAnnotations } from "@/lib/annotations/annotation-service";
import { db } from "@/lib/db";
import { readImageWorkspaceAsset } from "@/lib/workspace/image-workspace";
import {
  cleanupAnnotationFixture,
  createAnnotationAsset,
  createAnnotationDataset,
  createAnnotationLabel,
  createAnnotationUser,
} from "./helpers";

const integrationEnabled = process.env.ANNOTATION_API_INTEGRATION_TESTS === "1";

test("shared service reads every modality and atomically persists the five approved IMAGE shapes", { skip: integrationEnabled ? false : "Set ANNOTATION_API_INTEGRATION_TESTS=1 with controlled PostgreSQL." }, async () => {
  const user = await createAnnotationUser(UserRole.MANAGER);
  const dataset = await createAnnotationDataset(user.id);
  const image = await createAnnotationAsset(dataset.id);
  const label = await createAnnotationLabel(dataset.id);
  const otherAssets = await Promise.all([Modality.VIDEO, Modality.TEXT, Modality.AUDIO].map((modality) => db.asset.create({
    data: { datasetId: dataset.id, modality, filename: `${modality}.fixture`, mimeType: "application/octet-stream", sourceFingerprint: `${dataset.id}-${modality}` },
    select: { id: true },
  })));
  const actor = { id: user.id, email: user.email, name: user.name, role: user.role };
  try {
    for (const asset of [image, ...otherAssets]) {
      const listed = await readAssetAnnotations(actor, asset.id);
      assert.equal(listed.ok, true);
      if (listed.ok) assert.deepEqual(listed.value, []);
    }
    const created = await mutateImageAnnotations(actor, image.id, {
      creates: [
        { id: "box", type: "BOUNDING_BOX", labelId: label.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
        { id: "polygon", type: "POLYGON", labelId: label.id, geometry: { points: [[0, 0], [0.2, 0], [0.1, 0.2]] } },
        { id: "circle", type: "CIRCLE", labelId: label.id, geometry: { cx: 0.5, cy: 0.5, r: 0.2 } },
        { id: "point", type: "POINT", labelId: label.id, geometry: { px: 0.3, py: 0.3 } },
        { id: "polyline", type: "POLYLINE", labelId: label.id, geometry: { points: [[0.1, 0.1], [0.2, 0.2]] } },
      ], updates: [], deletes: [],
    });
    assert.equal(created.ok, true);
    if (created.ok) assert.equal(created.value.length, 5);
    const stale = await mutateImageAnnotations(actor, image.id, {
      creates: [],
      updates: [{ id: "box", revision: 1, geometry: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } }],
      deletes: [{ id: "point", revision: 0 }],
    });
    assert.deepEqual(stale, { ok: false, reason: "CONFLICT" });
    const after = await readAssetAnnotations(actor, image.id);
    assert.equal(after.ok, true);
    if (after.ok) {
      assert.equal(after.value.length, 5);
      assert.equal(after.value.find((annotation) => annotation.id === "box")?.revision, 1);
    }
  } finally {
    await cleanupAnnotationFixture([user.id], [dataset.id]);
  }
});

test("shared workspace read separates editable image shapes from visible read-only future shapes", { skip: integrationEnabled ? false : "Set ANNOTATION_API_INTEGRATION_TESTS=1 with controlled PostgreSQL." }, async () => {
  const user = await createAnnotationUser(UserRole.MANAGER);
  const dataset = await createAnnotationDataset(user.id);
  const image = await createAnnotationAsset(dataset.id);
  const actor = { id: user.id, email: user.email, name: user.name, role: user.role };
  try {
    await db.annotation.createMany({
      data: [
        {
          id: "workspace-point",
          datasetId: dataset.id,
          assetId: image.id,
          createdById: user.id,
          modality: Modality.IMAGE,
          type: AnnotationType.POINT,
          source: AnnotationSource.MANUAL,
          status: AnnotationStatus.DRAFT,
          geometry: { px: 0.2, py: 0.3 },
          properties: {},
        },
        {
          id: "workspace-mask",
          datasetId: dataset.id,
          assetId: image.id,
          createdById: user.id,
          modality: Modality.IMAGE,
          type: AnnotationType.SEGMENTATION_MASK,
          source: AnnotationSource.MANUAL,
          status: AnnotationStatus.DRAFT,
          geometry: { scaffold: true },
          properties: {},
        },
      ],
    });
    const workspace = await readImageWorkspaceAsset(actor, dataset.id, image.id);
    assert.ok(workspace);
    assert.equal(workspace.annotations.length, 1);
    assert.equal(workspace.annotations[0]?.type, AnnotationType.POINT);
    assert.equal(workspace.unsupportedAnnotations.length, 1);
    assert.equal(workspace.unsupportedAnnotations[0]?.type, AnnotationType.SEGMENTATION_MASK);
    const encoded = JSON.stringify(workspace);
    for (const forbidden of ["createdbyid", "sourceconnection", "storagekey", "jobinput", "token"]) {
      assert.equal(encoded.toLowerCase().includes(forbidden), false);
    }
  } finally {
    await cleanupAnnotationFixture([user.id], [dataset.id]);
  }
});
