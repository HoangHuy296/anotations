import type { AnnotationType, Modality } from "@internal/db";

export type SafeAnnotation = {
  id: string;
  assetId: string;
  labelId: string | null;
  label: { id: string; name: string; color: string } | null;
  modality: Modality;
  type: AnnotationType;
  geometry: unknown;
  status: string;
  properties: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Relation endpoint identities (TEXT_RELATION only; always null for every other annotation type, IMAGE/VIDEO included). Never derived from geometry -- `fromAnnotationId`/`toAnnotationId` are the only relation endpoint authority (data-model.md D3). */
  fromAnnotationId: string | null;
  toAnnotationId: string | null;
};

type ProjectableAnnotation = {
  id: string; assetId: string; labelId: string | null; modality: Modality; type: AnnotationType;
  geometry: unknown; status: string; properties: unknown; revision: number; createdAt: Date; updatedAt: Date;
  label: { id: string; name: string; color: string } | null;
  fromAnnotationId: string | null; toAnnotationId: string | null;
};

export function toSafeAnnotation(annotation: ProjectableAnnotation): SafeAnnotation {
  return {
    id: annotation.id, assetId: annotation.assetId, labelId: annotation.labelId,
    label: annotation.label ? { id: annotation.label.id, name: annotation.label.name, color: annotation.label.color } : null,
    modality: annotation.modality, type: annotation.type, geometry: annotation.geometry,
    status: annotation.status, properties: annotation.properties, revision: annotation.revision,
    createdAt: annotation.createdAt.toISOString(), updatedAt: annotation.updatedAt.toISOString(),
    fromAnnotationId: annotation.fromAnnotationId, toAnnotationId: annotation.toAnnotationId,
  };
}
