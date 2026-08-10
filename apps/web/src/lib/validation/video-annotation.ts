import { z } from "zod";

const id = z.string().trim().min(1).max(128);
const finite = z.number().finite();
const normalized = finite.min(0).max(1);
const timestamp = z.number().int().finite().min(0);
const properties = z.record(z.string(), z.unknown()).default({});

export const videoBoundingBoxSchema = z.object({
  kind: z.literal("BOUNDING_BOX").default("BOUNDING_BOX"),
  x: normalized,
  y: normalized,
  width: finite.positive().max(1),
  height: finite.positive().max(1),
}).strict().superRefine((box, ctx) => {
  if (box.x + box.width > 1) ctx.addIssue({ code: "custom", path: ["width"], message: "Bounding box exceeds frame width." });
  if (box.y + box.height > 1) ctx.addIssue({ code: "custom", path: ["height"], message: "Bounding box exceeds frame height." });
});

export const videoTrackCreateSchema = z.object({
  labelId: id.nullable().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  annotationType: z.literal("BOUNDING_BOX").default("BOUNDING_BOX"),
  interpolationMode: z.enum(["LINEAR", "NONE"]).default("LINEAR"),
  properties,
}).strict();

export const videoTrackUpdateSchema = z.object({
  expectedTrackRevision: z.number().int().positive(),
  labelId: id.nullable().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  status: z.enum(["DRAFT", "IN_PROGRESS", "COMPLETED", "SUBMITTED", "REVIEWED", "ACCEPTED", "REJECTED"]).optional(),
  interpolationMode: z.enum(["LINEAR", "NONE"]).optional(),
  properties: properties.optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedTrackRevision"), { message: "Track update is empty." });

export const videoKeyframeCreateSchema = z.object({
  expectedTrackRevision: z.number().int().positive(),
  timestampMs: timestamp,
  geometry: videoBoundingBoxSchema,
  properties,
}).strict();

export const videoKeyframeUpdateSchema = z.object({
  expectedTrackRevision: z.number().int().positive(),
  timestampMs: timestamp.optional(),
  geometry: videoBoundingBoxSchema.optional(),
  properties: properties.optional(),
  // Per-shape label override. A keyframe Annotation always has its own
  // `labelId` column (it does not need to match its Track's `labelId`) --
  // this just lets the Shapes tab in `video-properties-tabs.tsx` assign a
  // label to *one* drawn box without renaming/relabeling every other
  // keyframe that happens to share the same Track.
  labelId: id.nullable().optional(),
}).strict().refine((value) => value.timestampMs !== undefined || value.geometry !== undefined || value.properties !== undefined || value.labelId !== undefined, { message: "Keyframe update is empty." });

export const videoKeyframeDeleteSchema = z.object({
  expectedTrackRevision: z.number().int().positive(),
}).strict();

export const videoTrackDeleteSchema = videoKeyframeDeleteSchema;

export const videoTemporalLabelCreateSchema = z.object({
  type: z.enum(["EVENT", "SCENE", "SHOT_BOUNDARY"]),
  labelId: id.nullable().optional(),
  startMs: timestamp,
  endMs: timestamp,
  properties,
}).strict().refine((value) => value.startMs < value.endMs, { path: ["endMs"], message: "Temporal label must have a positive duration." });

export const videoTemporalLabelUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  labelId: id.nullable().optional(),
  startMs: timestamp.optional(),
  endMs: timestamp.optional(),
  properties: properties.optional(),
}).strict().refine((value) => value.labelId !== undefined || value.startMs !== undefined || value.endMs !== undefined || value.properties !== undefined, { message: "Temporal label update is empty." });

export const videoTemporalLabelDeleteSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict();

export const videoReadQuerySchema = z.object({
  fromMs: timestamp.optional(),
  toMs: timestamp.optional(),
  cursor: id.optional(),
  limit: z.number().int().min(1).max(500).default(100),
}).strict().superRefine((value, ctx) => {
  if (value.fromMs !== undefined && value.toMs !== undefined && value.fromMs >= value.toMs) ctx.addIssue({ code: "custom", path: ["toMs"], message: "Read window must be positive." });
});

export type VideoTrackCreateInput = z.infer<typeof videoTrackCreateSchema>;
export type VideoTrackUpdateInput = z.infer<typeof videoTrackUpdateSchema>;
export type VideoKeyframeCreateInput = z.infer<typeof videoKeyframeCreateSchema>;
export type VideoKeyframeUpdateInput = z.infer<typeof videoKeyframeUpdateSchema>;
export type VideoTemporalLabelCreateInput = z.infer<typeof videoTemporalLabelCreateSchema>;
export type VideoTemporalLabelUpdateInput = z.infer<typeof videoTemporalLabelUpdateSchema>;
