import type { AssetStatus, Modality } from "@internal/db";
import type { AnnotationType } from "@internal/db";

export type NormalizedBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type NormalizedPoint = [number, number];
export type ImageAnnotationGeometry =
  | { x: number; y: number; width: number; height: number }
  | { points: NormalizedPoint[] }
  | { cx: number; cy: number; r: number }
  | { px: number; py: number };

export type SafeImageAnnotation = {
  id: string;
  assetId: string;
  labelId: string | null;
  revision: number;
  label?: { id: string; name: string; color: string } | null;
  modality?: "IMAGE";
  type: Extract<AnnotationType, "BOUNDING_BOX" | "POLYGON" | "CIRCLE" | "POINT" | "POLYLINE">;
  geometry: ImageAnnotationGeometry | NormalizedBoundingBox;
  status: string;
  properties?: unknown;
  createdAt?: string;
  updatedAt: string;
};

/** IMAGE records outside the Phase 017 editing contract remain visible but immutable. */
export type SafeReadOnlyImageAnnotation = {
  id: string;
  type: AnnotationType;
  label: { id: string; name: string; color: string } | null;
  status: string;
  geometry: unknown;
  revision: number;
};

export type SafeWorkspaceLabel = {
  id: string;
  name: string;
  color: string;
  modality: "IMAGE" | null;
};

export type SafeWorkspaceAsset = {
  id: string;
  modality: Modality;
  filename: string;
  width: number | null;
  height: number | null;
  description: string | null;
  version: number;
  status: AssetStatus;
  batchIndex: number;
  orderIndex: number;
  annotationCount: number;
};

export type SafeImageWorkspaceAsset = SafeWorkspaceAsset & {
  modality: "IMAGE";
};

export type ImageWorkspacePage = {
  items: SafeWorkspaceAsset[];
  total: number;
  completed: number;
  page: number;
  pageSize: number;
  selectedAssetId: string | null;
  previous: { id: string; modality: Modality; page: number } | null;
  next: { id: string; modality: Modality; page: number } | null;
};

export type SaveState = "idle" | "pending" | "saving" | "saved" | "failed" | "conflict";

export type SaveConflict = {
  resource: "annotation" | "description";
  message: string;
};
