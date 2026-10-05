export const visualizationTabs = ["data", "insights", "schema", "versions", "activity"] as const;
export type VisualizationTab = (typeof visualizationTabs)[number];

/** Identity already authorized by the server entry point. */
export type VisualizationDatasetIdentity = { id: string; name: string };

export type NormalizedBox = { x: number; y: number; width: number; height: number };
export type ViewerLabel = { id: string; name: string; color: string };
export type ViewerAsset = {
  row_id: string; filename: string; modality: string; width: number | null; height: number | null;
  mediaAvailable: boolean;
};
export type ViewerAnnotation = {
  id: string; type: string; revision: number; label: ViewerLabel | null;
  geometry: NormalizedBox | null; overlayUnavailable: string | null;
};
export type ViewerAssetDetail = ViewerAsset & {
  annotations: ViewerAnnotation[]; annotationCount: number; annotationsTruncated: boolean;
};
export type ViewerPage<T> = { items: T[]; page: number; pageSize: number; total: number };
export type ViewerInsights = {
  assetCount: number; imageCount: number; unsupportedCount: number; annotationCount: number;
  labelDistribution: { label: ViewerLabel | null; count: number }[]; distributionTruncated: boolean;
  dimensions: { count: number; minWidth: number | null; maxWidth: number | null; minHeight: number | null; maxHeight: number | null };
};
export type ViewerSchema = {
  fields: { name: string; type: string }[]; labels: ViewerPage<ViewerLabel>;
};
export type ViewerActivity = ViewerPage<{ id: string; type: string; status: string; createdAt: string; finishedAt: string | null }>;

export type DerivedVisualizationState = {
  status: "pending" | "processing" | "ready" | "failed";
  generation: string; snapshotId: string | null; current: boolean;
};
export type ViewerSnapshot = { id: string; ordinal: number; generation: string; assetCount: number; annotationCount: number; publishedAt: string };
export type ViewerVersions = ViewerPage<ViewerSnapshot> & { state: DerivedVisualizationState };
export type ViewerDerivedProfile = {
  profileSnapshotId: string | null; profileCurrent: boolean;
  state: DerivedVisualizationState;
  profile: {
    assetCount: number; annotationCount: number; unlabeledAssetCount: number;
    validBoundingBoxCount: number; invalidBoundingBoxCount: number;
    schema: Array<{ field: string; type: string; units: string | null; presentCount: number }>;
    boxAreaHistogram: Array<{ lower: number; upper: number; count: number }>;
  } | null;
};

export type ViewerSnapshotContent = ViewerPage<{
  id: string; filename: string; modality: string; mimeType: string;
  width: number | null; height: number | null; imageArtifactId: string | null;
}> & { id: string; generation: string; annotations: Array<ViewerAnnotation & { assetId: string }>; annotationsTruncated: boolean; labels: ViewerLabel[]; labelsTruncated: boolean };
