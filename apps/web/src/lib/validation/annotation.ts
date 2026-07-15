import { z } from "zod";
import { AnnotationType, Modality } from "@internal/db";

const cuid = z.string().cuid();
const editableStatus = z.enum(["DRAFT", "IN_PROGRESS", "COMPLETED"]);
const reviewStatus = z.enum(["ACCEPTED", "REJECTED"]);

// Geometry remains canonical JSON. Bounding boxes are the first editing engine,
// while this object schema keeps future geometry types representable safely.
const canonicalGeometrySchema = z.record(z.string(), z.json());

export const updateAnnotationInputSchema = z.object({
  datasetId: cuid,
  annotationId: cuid,
  geometry: canonicalGeometrySchema,
  version: z.number().int().positive(),
  status: editableStatus.optional(),
});

export const createAnnotationInputSchema = z.object({
  datasetId: cuid,
  assetId: cuid,
  assetVersionId: cuid.nullish(),
  labelId: cuid.nullish(),
  modality: z.nativeEnum(Modality),
  type: z.nativeEnum(AnnotationType),
  geometry: canonicalGeometrySchema,
  status: editableStatus.default("DRAFT"),
});

export const reviewAnnotationInputSchema = z.object({
  datasetId: cuid,
  annotationId: cuid,
  version: z.number().int().positive(),
  status: reviewStatus,
});
