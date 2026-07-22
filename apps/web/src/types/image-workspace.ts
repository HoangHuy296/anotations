import type { AssetStatus, Modality } from "@internal/db";

export type NormalizedBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SafeImageAnnotation = {
  id: string;
  assetId: string;
  labelId: string | null;
  type: "BOUNDING_BOX";
  geometry: NormalizedBoundingBox;
  status: "DRAFT" | "IN_PROGRESS" | "COMPLETED";
  version: number;
  updatedAt: string;
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
  previous: { id: string; page: number } | null;
  next: { id: string; page: number } | null;
};

export type SaveState = "idle" | "pending" | "saving" | "saved" | "failed" | "conflict";

export type SaveConflict = {
  resource: "annotation" | "description";
  message: string;
};
