import type { AssetStatus, Modality } from "@internal/db";

import type { SafeMediaReadiness } from "@/types/media-processing";
import type { SafeVideoAnnotations } from "@/types/video-annotation";
import type { SafeImageAnnotation, SafeImageWorkspaceAsset, SafeReadOnlyImageAnnotation, SafeWorkspaceLabel } from "@/types/image-workspace";

/** Lightweight, modality-neutral record used by the shared Assets navigator. */
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

/** Shared list/pagination DTO for the workspace Assets tab. */
export type WorkspaceAssetPage = {
  items: SafeWorkspaceAsset[];
  total: number;
  completed: number;
  page: number;
  pageSize: number;
  /** The confirmed `{ id, modality }` of whatever ended up selected -- not an echo of the request. */
  selectedAsset: { id: string; modality: Modality } | null;
  previous: { id: string; modality: Modality; page: number } | null;
  next: { id: string; modality: Modality; page: number } | null;
};

export type SafeReadOnlyWorkspaceAsset = {
  id: string;
  modality: "TEXT";
  filename: string;
  description: string | null;
};

export type WorkspaceSelection =
  | { engine: "IMAGE"; asset: SafeImageWorkspaceAsset; annotations: SafeImageAnnotation[]; unsupportedAnnotations: SafeReadOnlyImageAnnotation[]; labels: SafeWorkspaceLabel[] }
  | { engine: "VIDEO"; asset: { id: string; modality: "VIDEO"; filename: string; description: string | null; version: number }; readiness: SafeMediaReadiness; annotations: SafeVideoAnnotations }
  | { engine: "AUDIO"; asset: { id: string; modality: "AUDIO"; filename: string; description: string | null }; readiness: SafeMediaReadiness }
  | { engine: "TEXT"; asset: SafeReadOnlyWorkspaceAsset };
