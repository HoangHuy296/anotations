import "server-only";

import { Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { readAssetAnnotations } from "@/lib/annotations/annotation-service";
import { db } from "@/lib/db";
import { toSafeWorkspaceAsset } from "@/lib/workspace/workspace-assets";
import type {
  SafeImageAnnotation,
  SafeImageWorkspaceAsset,
  SafeReadOnlyImageAnnotation,
  SafeWorkspaceLabel,
} from "@/types/image-workspace";

// Defensive cap only, same rationale as ANNOTATIONS_PER_ASSET_READ_LIMIT in
// annotation-service.ts: this is a dataset-scoped taxonomy reference set the
// image workspace loads in full for label-assignment UI, not a browseable
// list, so it stays a bare array with a generous upper bound rather than a
// page/pageSize/total envelope.
const IMAGE_WORKSPACE_LABEL_READ_LIMIT = 1_000;

export async function readImageWorkspaceAsset(actor: RequestActor, datasetId: string, assetId: string) {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const [asset, labels] = await Promise.all([
    db.asset.findFirst({
      where: { id: assetId, datasetId, modality: Modality.IMAGE, deletedAt: null, archivedAt: null },
      select: {
        id: true, filename: true, width: true, height: true, description: true, revision: true, status: true, batchIndex: true, orderIndex: true,
        _count: { select: { annotations: true } },
      },
    }),
    db.label.findMany({ where: { datasetId, OR: [{ modality: null }, { modality: Modality.IMAGE }] }, orderBy: { normalizedName: "asc" }, select: { id: true, name: true, color: true, modality: true }, take: IMAGE_WORKSPACE_LABEL_READ_LIMIT }),
  ]);
  if (!asset) return null;
  const listed = await readAssetAnnotations(actor, asset.id);
  const editableTypes = ["BOUNDING_BOX", "POLYGON", "CIRCLE", "POINT", "POLYLINE"] as const;
  const allImageAnnotations = listed.ok ? listed.value.filter((annotation) => annotation.modality === Modality.IMAGE) : [];
  const annotations: SafeImageAnnotation[] = allImageAnnotations.filter((annotation): annotation is typeof annotation & { type: SafeImageAnnotation["type"] } => editableTypes.includes(annotation.type as typeof editableTypes[number])).map((annotation) => ({ ...annotation, modality: "IMAGE" as const, geometry: annotation.geometry as SafeImageAnnotation["geometry"] }));
  const unsupportedAnnotations: SafeReadOnlyImageAnnotation[] = allImageAnnotations.filter((annotation) => !editableTypes.includes(annotation.type as typeof editableTypes[number])).map((annotation) => ({ id: annotation.id, type: annotation.type, label: annotation.label, status: annotation.status, geometry: annotation.geometry, revision: annotation.revision }));
  const safeLabels: SafeWorkspaceLabel[] = labels.map((label) => ({ id: label.id, name: label.name, color: label.color, modality: label.modality === Modality.IMAGE ? "IMAGE" : null }));
  const safeAsset: SafeImageWorkspaceAsset = { ...toSafeWorkspaceAsset({ ...asset, modality: Modality.IMAGE }), modality: Modality.IMAGE };
  return { asset: safeAsset, annotations, unsupportedAnnotations, labels: safeLabels };
}
