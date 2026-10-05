import { createHash } from "node:crypto";
import { z } from "zod";

/** Server/worker contract only. Never exported through the browser domain entry. */
export const VISUALIZATION_CAPTURE_ALGORITHM = "capture-v1";
export const VISUALIZATION_PROFILE_ALGORITHM = "profile-v1";
export const VISUALIZATION_PREVIEW_ALGORITHM = "ffmpeg-image-v1";
export const VISUALIZATION_LIMITS = {
  assets: 1000,
  annotations: 100000,
  labels: 10000,
  sourceBytes: 25 * 1024 * 1024,
  totalSourceBytes: 512 * 1024 * 1024,
  descriptorBytes: 32 * 1024 * 1024,
  profileBytes: 2 * 1024 * 1024,
} as const;

const id = z.string().min(1).max(200);
export const visualizationGenerationSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).max(19);
export const snapshotIdSchema = z.string().regex(/^vs_[a-f0-9]{64}$/);
export const artifactIdSchema = z.string().regex(/^va_[a-f0-9]{64}$/);
export const visualizationCaptureInputSchema = z.object({
  generation: visualizationGenerationSchema,
  algorithm: z.literal(VISUALIZATION_CAPTURE_ALGORITHM),
}).strict();
export const visualizationDeriveInputSchema = z.object({
  generation: visualizationGenerationSchema,
  snapshotId: snapshotIdSchema,
  profileAlgorithm: z.literal(VISUALIZATION_PROFILE_ALGORITHM),
  previewAlgorithm: z.literal(VISUALIZATION_PREVIEW_ALGORITHM),
}).strict();
export const visualizationArtifactKinds = ["CAPTURE", "SOURCE_IMAGE", "THUMBNAIL", "PREVIEW", "PROFILE"] as const;
export type VisualizationArtifactKind = (typeof visualizationArtifactKinds)[number];

export const capturedLabelSchema = z.object({
  id, name: z.string().max(1000), color: z.string().max(100),
  modality: z.string().nullable(), scope: z.string(), description: z.string().max(10000).nullable(),
}).strict();
export const capturedAnnotationSchema = z.object({
  id, assetId: id, labelId: id.nullable(), type: z.string(), modality: z.string(),
  geometry: z.json(), revision: z.number().int().positive(), status: z.string(), source: z.string(),
}).strict();
export const capturedAssetSchema = z.object({
  id, filename: z.string().max(2000), modality: z.string(), mimeType: z.string().max(255),
  width: z.number().int().nullable(), height: z.number().int().nullable(),
  sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  sourceBytes: z.number().int().nonnegative().nullable(),
}).strict();
export const capturedContentSchema = z.object({
  dataset: z.object({ id, name: z.string().max(1000), description: z.string().max(10000).nullable() }).strict(),
  assets: z.array(capturedAssetSchema).max(VISUALIZATION_LIMITS.assets),
  labels: z.array(capturedLabelSchema).max(VISUALIZATION_LIMITS.labels),
  annotations: z.array(capturedAnnotationSchema).max(VISUALIZATION_LIMITS.annotations),
}).strict();
export type CapturedContent = z.infer<typeof capturedContentSchema>;
export const snapshotDescriptorSchema = z.object({
  schemaVersion: z.literal(1), snapshotId: snapshotIdSchema, generation: visualizationGenerationSchema,
  algorithm: z.literal(VISUALIZATION_CAPTURE_ALGORITHM), contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  content: capturedContentSchema,
}).strict();
export type SnapshotDescriptor = z.infer<typeof snapshotDescriptorSchema>;

/** Sort object keys recursively; arrays have explicit stable ordering upstream. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("Non-JSON capture value");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function canonicalCapturedContent(input: CapturedContent): CapturedContent {
  const content = capturedContentSchema.parse(input);
  const assetIds = new Set(content.assets.map(asset => asset.id));
  const labelIds = new Set(content.labels.map(label => label.id));
  if (content.annotations.some(annotation => !assetIds.has(annotation.assetId) || (annotation.labelId !== null && !labelIds.has(annotation.labelId)))) throw new Error("Capture contains cross-dataset references");
  const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { dataset: content.dataset, assets: byId(content.assets), labels: byId(content.labels), annotations: byId(content.annotations) };
}
export function captureIdentity(datasetId: string, generation: string, content: CapturedContent, algorithm: string = VISUALIZATION_CAPTURE_ALGORITHM) {
  visualizationGenerationSchema.parse(generation);
  if (content.dataset.id !== datasetId) throw new Error("Cross-dataset capture");
  const contentDigest = sha256(canonicalJson(canonicalCapturedContent(content)));
  return { contentDigest, snapshotId: `vs_${sha256(canonicalJson({ datasetId, generation, contentDigest, algorithm }))}` };
}
export function artifactIdentity(input: { datasetId: string; snapshotId: string; generation: string; kind: VisualizationArtifactKind; algorithm: string; scope: string }) {
  snapshotIdSchema.parse(input.snapshotId);
  visualizationGenerationSchema.parse(input.generation);
  return `va_${sha256(canonicalJson(input))}`;
}

const countSchema = z.number().int().nonnegative();
export const visualizationProfileSchema = z.object({
  schemaVersion: z.literal(1), assetCount: countSchema, imageCount: countSchema,
  unsupportedCount: countSchema, annotationCount: countSchema, unlabeledAssetCount: countSchema,
  validBoundingBoxCount: countSchema, invalidBoundingBoxCount: countSchema,
  labels: z.array(z.object({ id: z.string().nullable(), name: z.string().max(1000), color: z.string().max(100).nullable(), count: countSchema })).max(VISUALIZATION_LIMITS.labels + 1),
  boxAreaHistogram: z.array(z.object({ lower: z.number().min(0).max(1), upper: z.number().min(0).max(1), count: countSchema })).length(10),
  dimensions: z.object({ count: countSchema, minWidth: countSchema.nullable(), maxWidth: countSchema.nullable(), minHeight: countSchema.nullable(), maxHeight: countSchema.nullable() }),
  schema: z.array(z.object({ field: z.string(), type: z.string(), units: z.string().nullable(), presentCount: countSchema })).max(20),
});
export type VisualizationProfile = z.infer<typeof visualizationProfileSchema>;
export function deriveVisualizationProfile(content: CapturedContent): VisualizationProfile {
  const assets = new Map(content.assets.map(asset => [asset.id, asset]));
  const labels = new Map(content.labels.map(label => [label.id, label]));
  const labelCounts = new Map<string | null, number>();
  const annotatedAssets = new Set<string>();
  const histogram = Array.from({ length: 10 }, (_, i) => ({ lower: i / 10, upper: (i + 1) / 10, count: 0 }));
  let validBoundingBoxCount = 0, invalidBoundingBoxCount = 0;
  for (const annotation of content.annotations) {
    if (!assets.has(annotation.assetId)) throw new Error("Annotation outside captured active asset set");
    if (annotation.labelId !== null && !labels.has(annotation.labelId)) throw new Error("Annotation outside captured label definitions");
    annotatedAssets.add(annotation.assetId);
    labelCounts.set(annotation.labelId, (labelCounts.get(annotation.labelId) ?? 0) + 1);
    if (annotation.type !== "BOUNDING_BOX" || annotation.modality !== "IMAGE") continue;
    const geometry = annotation.geometry;
    if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) { invalidBoundingBoxCount++; continue; }
    const { x, y, width, height } = geometry;
    if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" || ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) { invalidBoundingBoxCount++; continue; }
    validBoundingBoxCount++;
    histogram[Math.min(9, Math.floor(width * height * 10))].count++;
  }
  const dimensioned = content.assets.filter(asset => asset.modality === "IMAGE" && asset.width !== null && asset.height !== null && asset.width > 0 && asset.height > 0);
  const imageCount = content.assets.filter(asset => asset.modality === "IMAGE").length;
  return {
    schema: [
      { field: "Asset.id", type: "string", units: null, presentCount: content.assets.length },
      { field: "Asset.originalDimensions", type: "integer pair", units: "pixels", presentCount: dimensioned.length },
      { field: "Annotation.id", type: "string", units: null, presentCount: content.annotations.length },
      { field: "Annotation.geometry (valid image boxes)", type: "xywh", units: "normalized 0..1", presentCount: validBoundingBoxCount },
      { field: "Label.id/name/color", type: "string", units: null, presentCount: content.labels.length },
    ],
    schemaVersion: 1, assetCount: content.assets.length, imageCount, unsupportedCount: content.assets.length - imageCount,
    annotationCount: content.annotations.length,
    labels: [...labelCounts].sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")).map(([id, count]) => ({ id, name: id === null ? "Unlabeled" : labels.get(id)!.name, color: id === null ? null : labels.get(id)!.color, count })),
    unlabeledAssetCount: content.assets.length - annotatedAssets.size, validBoundingBoxCount, invalidBoundingBoxCount, boxAreaHistogram: histogram,
    dimensions: { count: dimensioned.length, minWidth: dimensioned.length ? Math.min(...dimensioned.map(a => a.width!)) : null, maxWidth: dimensioned.length ? Math.max(...dimensioned.map(a => a.width!)) : null, minHeight: dimensioned.length ? Math.min(...dimensioned.map(a => a.height!)) : null, maxHeight: dimensioned.length ? Math.max(...dimensioned.map(a => a.height!)) : null },
  };
}
