import { z } from "zod";
import { textPropertiesSchema, projectTextProperties, type TextProperties } from "./text-properties-contract.js";

/**
 * Canonical TEXT geometry shapes and the safe annotation/export serializer.
 * Owned once here; web and worker import these, never redefine them.
 * No web/server imports, no I/O, no source excerpts.
 */

export const TEXT_GEOMETRY_SCHEMA_VERSION = 1 as const;
export const UTF16_CODE_UNIT = "UTF16_CODE_UNIT" as const;

const sourceIdentitySchema = z.string().min(1);

export const textSpanGeometrySchema = z
  .object({
    schemaVersion: z.literal(TEXT_GEOMETRY_SCHEMA_VERSION),
    kind: z.literal("text-span"),
    sourceIdentity: sourceIdentitySchema,
    offsetUnit: z.literal(UTF16_CODE_UNIT),
    startOffset: z.number().int().nonnegative().safe(),
    endOffset: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((geometry, ctx) => {
    if (!(geometry.startOffset < geometry.endOffset)) {
      ctx.addIssue({ code: "custom", message: "startOffset must be strictly less than endOffset" });
    }
  });

export const textDocumentGeometrySchema = z
  .object({
    schemaVersion: z.literal(TEXT_GEOMETRY_SCHEMA_VERSION),
    kind: z.literal("text-document"),
    sourceIdentity: sourceIdentitySchema,
  })
  .strict();

export const textRelationGeometrySchema = z
  .object({
    schemaVersion: z.literal(TEXT_GEOMETRY_SCHEMA_VERSION),
    kind: z.literal("text-relation"),
    sourceIdentity: sourceIdentitySchema,
  })
  .strict();

export const textGeometrySchema = z.discriminatedUnion("kind", [
  textSpanGeometrySchema,
  textDocumentGeometrySchema,
  textRelationGeometrySchema,
]);

export type TextSpanGeometry = z.infer<typeof textSpanGeometrySchema>;
export type TextDocumentGeometry = z.infer<typeof textDocumentGeometrySchema>;
export type TextRelationGeometry = z.infer<typeof textRelationGeometrySchema>;
export type TextGeometry = z.infer<typeof textGeometrySchema>;

/** Input contract: the minimal generic Annotation row fields the serializer reads. */
export const textAnnotationRecordSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  datasetId: z.string().min(1),
  labelId: z.string().min(1).nullable(),
  status: z.string().min(1),
  revision: z.number().int().positive(),
  geometry: z.unknown(),
  properties: z.unknown(),
  fromAnnotationId: z.string().min(1).nullable(),
  toAnnotationId: z.string().min(1).nullable(),
  createdById: z.string().min(1),
  updatedById: z.string().min(1).nullable(),
  createdAt: z.union([z.date(), z.string()]),
  updatedAt: z.union([z.date(), z.string()]),
});

export type TextAnnotationRecord = z.infer<typeof textAnnotationRecordSchema>;

/** Output contract: the only shape returned to browsers, realtime payloads and exports. */
export interface SafeTextAnnotation {
  id: string;
  assetId: string;
  datasetId: string;
  labelId: string | null;
  status: string;
  revision: number;
  geometry: TextGeometry;
  properties: TextProperties;
  fromAnnotationId: string | null;
  toAnnotationId: string | null;
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Pure safe serializer shared by the generic annotation API, TEXT-specific routes,
 * realtime projections and the worker export manifest. Never includes selected
 * source text, storage locators or unallowlisted fields — callers with an
 * authorized source context derive excerpts separately.
 */
export function serializeSafeTextAnnotation(input: unknown): SafeTextAnnotation {
  const record = textAnnotationRecordSchema.parse(input);
  const geometry = textGeometrySchema.parse(record.geometry);
  const properties = projectTextProperties((record.properties as Record<string, unknown> | null) ?? {});
  const isRelation = geometry.kind === "text-relation";
  return {
    id: record.id,
    assetId: record.assetId,
    datasetId: record.datasetId,
    labelId: record.labelId,
    status: record.status,
    revision: record.revision,
    geometry,
    properties,
    fromAnnotationId: isRelation ? record.fromAnnotationId : null,
    toAnnotationId: isRelation ? record.toAnnotationId : null,
    createdById: record.createdById,
    updatedById: record.updatedById,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}
