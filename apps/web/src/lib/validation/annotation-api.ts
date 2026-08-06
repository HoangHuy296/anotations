import { AnnotationType } from "@internal/db";
import { z } from "zod";

const id = z.string().min(1).max(128);
const revision = z.number().int().positive();
const coordinate = z.number().finite().min(0).max(1);
const point = z.tuple([coordinate, coordinate]);

const boundingBox = z.object({
  x: coordinate,
  y: coordinate,
  width: z.number().finite().positive().max(1),
  height: z.number().finite().positive().max(1),
}).strict().superRefine((value, ctx) => {
  if (value.x + value.width > 1) ctx.addIssue({ code: "custom", path: ["width"], message: "Bounding box exceeds image width." });
  if (value.y + value.height > 1) ctx.addIssue({ code: "custom", path: ["height"], message: "Bounding box exceeds image height." });
});

function uniquePoints(points: readonly [number, number][]) {
  return new Set(points.map(([x, y]) => `${x}:${y}`)).size === points.length;
}

const polygon = z.object({ points: z.array(point).min(3).max(1_000) }).strict().superRefine((value, ctx) => {
  if (!uniquePoints(value.points)) ctx.addIssue({ code: "custom", path: ["points"], message: "Polygon points must be distinct." });
});
const polyline = z.object({ points: z.array(point).min(2).max(1_000) }).strict().superRefine((value, ctx) => {
  if (!uniquePoints(value.points)) ctx.addIssue({ code: "custom", path: ["points"], message: "Polyline points must be distinct." });
});
const circle = z.object({ cx: coordinate, cy: coordinate, r: z.number().finite().positive().max(1) }).strict().superRefine((value, ctx) => {
  if (value.cx - value.r < 0 || value.cx + value.r > 1 || value.cy - value.r < 0 || value.cy + value.r > 1) ctx.addIssue({ code: "custom", path: ["r"], message: "Circle exceeds image bounds." });
});
const singlePoint = z.object({ px: coordinate, py: coordinate }).strict();

export const imageAnnotationGeometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(AnnotationType.BOUNDING_BOX), geometry: boundingBox }).strict(),
  z.object({ type: z.literal(AnnotationType.POLYGON), geometry: polygon }).strict(),
  z.object({ type: z.literal(AnnotationType.CIRCLE), geometry: circle }).strict(),
  z.object({ type: z.literal(AnnotationType.POINT), geometry: singlePoint }).strict(),
  z.object({ type: z.literal(AnnotationType.POLYLINE), geometry: polyline }).strict(),
]);

/** Validates an update against the persisted shape type, not merely a compatible JSON key. */
export function isValidImageGeometryForType(type: AnnotationType, geometry: unknown) {
  return imageAnnotationGeometrySchema.safeParse({ type, geometry }).success;
}

const imageGeometryValueSchema = z.union([boundingBox, polygon, circle, singlePoint, polyline]);

const create = z.object({ id, labelId: id.nullable().optional() }).strict().and(imageAnnotationGeometrySchema);
const update = z.object({ id, revision, geometry: imageGeometryValueSchema.optional(), labelId: id.nullable().optional() }).strict().superRefine((value, ctx) => {
  if (value.geometry === undefined && value.labelId === undefined) ctx.addIssue({ code: "custom", message: "An update must change geometry or label." });
});
const remove = z.object({ id, revision }).strict();

export const annotationChangeSetSchema = z.object({
  creates: z.array(create).max(100).default([]),
  updates: z.array(update).max(100).default([]),
  deletes: z.array(remove).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.creates.length + value.updates.length + value.deletes.length > 100) ctx.addIssue({ code: "custom", message: "Change set is too large." });
  const existing = [...value.updates.map((item) => item.id), ...value.deletes.map((item) => item.id)];
  if (new Set(existing).size !== existing.length) ctx.addIssue({ code: "custom", message: "Annotation mutations may not repeat an identifier." });
  if (new Set(value.creates.map((item) => item.id)).size !== value.creates.length) ctx.addIssue({ code: "custom", message: "Creates may not repeat an identifier." });
});

export type AnnotationChangeSet = z.infer<typeof annotationChangeSetSchema>;
export type ImageAnnotationGeometry = z.infer<typeof imageAnnotationGeometrySchema>;
