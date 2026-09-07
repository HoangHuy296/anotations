import { AssetStatus, Modality } from "@internal/db";
import { z } from "zod";
import { datasetIdSchema } from "@/lib/validation/dataset";

const cuid = z.string().cuid();
const normalizedCoordinate = z.number().finite().min(0).max(1);

export const normalizedBoundingBoxSchema = z
  .object({
    x: normalizedCoordinate,
    y: normalizedCoordinate,
    width: z.number().finite().gt(0).max(1),
    height: z.number().finite().gt(0).max(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.x + value.width > 1) {
      context.addIssue({ code: "custom", path: ["width"], message: "Bounding box exceeds the image width." });
    }
    if (value.y + value.height > 1) {
      context.addIssue({ code: "custom", path: ["height"], message: "Bounding box exceeds the image height." });
    }
  });

const revision = z.number().int().positive();

/**
 * Query values accepted by the shared workspace route. `asset` and `modality`
 * are paired -- the URL always encodes modality via which navigation key
 * produced the id (`?image=`, `?video=`, `?audio=`, `?text=`); it is never
 * inferred from the id alone, so a stale/mismatched pair fails validation
 * instead of silently resolving the wrong engine.
 */
export const workspaceListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  q: z.string().trim().max(100).default(""),
  statuses: z.array(z.nativeEnum(AssetStatus)).max(Object.keys(AssetStatus).length).default([]),
  asset: cuid.optional(),
  modality: z.nativeEnum(Modality).optional(),
  // Asset Browser filters (022) -- deliberately separate names from
  // `asset`/`modality` above, which identify the *selected* asset, not a
  // browse filter.
  filterModality: z.nativeEnum(Modality).optional(),
  labelId: z.array(cuid).max(50).default([]),
  assignedToId: cuid.optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  updatedFrom: z.string().datetime().optional(),
  updatedTo: z.string().datetime().optional(),
  sort: z.enum(["createdAt", "updatedAt", "filename"]).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
}).strict().refine((value) => (value.asset === undefined) === (value.modality === undefined), {
  message: "asset and modality must be provided together.",
  path: ["asset"],
});

export type WorkspaceListQuery = z.infer<typeof workspaceListQuerySchema>;

export const createBoundingBoxInputSchema = z.object({
  datasetId: datasetIdSchema,
  assetId: cuid,
  labelId: cuid.nullish(),
  geometry: normalizedBoundingBoxSchema,
}).strict();

export const updateBoundingBoxGeometryInputSchema = z.object({
  datasetId: datasetIdSchema,
  assetId: cuid,
  annotationId: cuid,
  revision,
  geometry: normalizedBoundingBoxSchema,
}).strict();

export const updateBoundingBoxLabelInputSchema = z.object({
  datasetId: datasetIdSchema,
  assetId: cuid,
  annotationId: cuid,
  revision,
  labelId: cuid.nullable(),
}).strict();

export const deleteBoundingBoxInputSchema = z.object({
  datasetId: datasetIdSchema,
  assetId: cuid,
  annotationId: cuid,
  revision,
}).strict();

export const updateAssetDescriptionInputSchema = z.object({
  datasetId: datasetIdSchema,
  assetId: cuid,
  version: revision,
  description: z.string().trim().max(10_000).nullable(),
}).strict();

export type NormalizedBoundingBoxInput = z.infer<typeof normalizedBoundingBoxSchema>;
