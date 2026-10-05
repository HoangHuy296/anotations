import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationSource, AnnotationStatus, AnnotationType, Modality, UserRole } from "@internal/db";

import { readAssetAnnotations } from "@/lib/annotations/annotation-service";
import { db } from "@/lib/db";
import { createAnnotationAsset, createAnnotationDataset, createAnnotationLabel, createAnnotationUser, cleanupAnnotationFixture } from "./helpers";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

/**
 * T076/T077: the generic `readAssetAnnotations` reader (backing
 * `GET /api/assets/{assetId}/annotations`) must preserve TEXT_RELATION
 * endpoint identities -- before this fix, `annotationSelect` never fetched
 * `fromAnnotationId`/`toAnnotationId`, so a relation read through the
 * generic endpoint silently lost both endpoints (present in the database,
 * absent from the response). Uses `db.annotation.createMany` directly
 * (matching `annotation-service.test.ts`'s own read-only fixture pattern)
 * rather than the full TEXT command-service + source-preparation path,
 * since this proves the generic *read* projection, not TEXT's own write
 * path (already covered in `text-relation-commands.test.ts`).
 */

test("readAssetAnnotations: a TEXT_RELATION row carries its fromAnnotationId/toAnnotationId; span rows and IMAGE annotations carry null for both, additive-only", { skip: !hasIntegrationDatabase }, async () => {
  const user = await createAnnotationUser(UserRole.MANAGER);
  const dataset = await createAnnotationDataset(user.id);
  const image = await createAnnotationAsset(dataset.id);
  const label = await createAnnotationLabel(dataset.id);
  const textAsset = await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.TEXT, filename: "generic-reader.txt", mimeType: "text/plain", sourceFingerprint: `${dataset.id}-text-generic-reader` },
    select: { id: true },
  });
  const actor = { id: user.id, email: user.email, name: user.name, role: user.role };
  try {
    await db.annotation.createMany({
      data: [
        { id: "generic-reader-span-a", datasetId: dataset.id, assetId: textAsset.id, createdById: user.id, modality: Modality.TEXT, type: AnnotationType.NAMED_ENTITY_RECOGNITION, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity: "sha256:" + "0".repeat(64), offsetUnit: "UTF16_CODE_UNIT", startOffset: 0, endOffset: 5 }, properties: { custom: {} } },
        { id: "generic-reader-span-b", datasetId: dataset.id, assetId: textAsset.id, createdById: user.id, modality: Modality.TEXT, type: AnnotationType.NAMED_ENTITY_RECOGNITION, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity: "sha256:" + "0".repeat(64), offsetUnit: "UTF16_CODE_UNIT", startOffset: 10, endOffset: 15 }, properties: { custom: {} } },
        { id: "generic-reader-relation", datasetId: dataset.id, assetId: textAsset.id, createdById: user.id, modality: Modality.TEXT, type: AnnotationType.TEXT_RELATION, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, fromAnnotationId: "generic-reader-span-a", toAnnotationId: "generic-reader-span-b", geometry: { schemaVersion: 1, kind: "text-relation", sourceIdentity: "sha256:" + "0".repeat(64) }, properties: { custom: {} } },
      ],
    });
    const image_ = await db.annotation.create({
      data: { datasetId: dataset.id, assetId: image.id, labelId: label.id, createdById: user.id, modality: Modality.IMAGE, type: AnnotationType.POINT, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { px: 0.4, py: 0.4 }, properties: {} },
      select: { id: true },
    });

    const textResult = await readAssetAnnotations(actor, textAsset.id);
    assert.equal(textResult.ok, true);
    if (!textResult.ok) return;
    const relation = textResult.value.find((row) => row.id === "generic-reader-relation");
    assert.ok(relation, "the relation row must be present in the generic read");
    assert.equal(relation.fromAnnotationId, "generic-reader-span-a");
    assert.equal(relation.toAnnotationId, "generic-reader-span-b");
    const spanA = textResult.value.find((row) => row.id === "generic-reader-span-a");
    assert.equal(spanA?.fromAnnotationId, null, "a non-relation annotation never carries relation endpoints");
    assert.equal(spanA?.toAnnotationId, null);

    const imageResult = await readAssetAnnotations(actor, image.id);
    assert.equal(imageResult.ok, true);
    if (!imageResult.ok) return;
    const imagePoint = imageResult.value.find((row) => row.id === image_.id);
    assert.equal(imagePoint?.fromAnnotationId, null, "IMAGE annotations are unaffected -- the new fields are additive-only");
    assert.equal(imagePoint?.toAnnotationId, null);
  } finally {
    await cleanupAnnotationFixture([user.id], [dataset.id]);
  }
});
