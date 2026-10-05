import type { AssetStatus, AssetWorkflowAction, Modality } from "@internal/db";

import type { SafeMediaReadiness } from "@/types/media-processing";
import type { SafeVideoAnnotations } from "@/types/video-annotation";
import type { SafeImageAnnotation, SafeImageWorkspaceAsset, SafeReadOnlyImageAnnotation, SafeWorkspaceLabel } from "@/types/image-workspace";
import type { TextSourceReadiness } from "@/lib/annotations/text-source-readiness";
import type { TextEngineCapabilities } from "@/lib/workspace/text-engine-capabilities";
import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";
import type { DatasetModalityState } from "@annotationplatform/domain";

/** Authorized live Dataset state chooses the engine, even before an Asset exists. */
export type WorkspaceDataset = {
  id: string;
  name: string;
  canResolve: boolean;
} & DatasetModalityState;

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
  /** Real Details metadata (022 FR-031) -- populated from the Asset row + TextAsset relation, not a placeholder. */
  mimeType: string;
  sizeBytes: string | null;
  textLength: number | null;
  language: string | null;
  createdAt: string;
  updatedAt: string;
  /** The current Asset revision -- the same value the active-engine flush contract reads back after a save. */
  revision: number;
  status: AssetStatus;
};

/**
 * Cheap readiness-only projection (T027's `deriveTextSourceReadiness`) --
 * never the full verified source text/boundaries. Those come from the
 * dedicated `GET /api/assets/{assetId}/text` route (T054) once the reader
 * mounts, not the broad workspace-selection DTO every navigation loads.
 */
export type SafeTextSourceContext =
  | { readiness: "READY"; sourceIdentity: string; offsetUnit: "UTF16_CODE_UNIT"; sourceCodeUnitLength: number; sourceByteLength: number }
  | { readiness: Exclude<TextSourceReadiness, "READY"> };

export type WorkspaceSelection =
  | { engine: "IMAGE"; asset: SafeImageWorkspaceAsset; annotations: SafeImageAnnotation[]; unsupportedAnnotations: SafeReadOnlyImageAnnotation[]; labels: SafeWorkspaceLabel[] }
  | { engine: "VIDEO"; asset: { id: string; modality: "VIDEO"; filename: string; description: string | null; version: number; status: AssetStatus }; readiness: SafeMediaReadiness; annotations: SafeVideoAnnotations }
  | { engine: "AUDIO"; asset: { id: string; modality: "AUDIO"; filename: string; description: string | null; version: number; status: AssetStatus }; readiness:SafeMediaReadiness }
  | { engine: "TEXT"; asset: SafeReadOnlyWorkspaceAsset; source: SafeTextSourceContext; annotations: SafeTextAnnotation[]; capabilities: TextEngineCapabilities };

/**
 * Asset Browser query shape (022). Deliberately excludes `sort`/`order` and
 * pagination fields -- those are display concerns and must never define what
 * a Selection (below) matches. See
 * specs/022-asset-browser-dataset-management-workspace/research.md (§3).
 */
export type AssetListQuery = {
  q?: string;
  status?: AssetStatus[];
  modality?: Modality;
  labelId?: string[];
  assignedToId?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
};

export type AssetListSort = "createdAt" | "updatedAt" | "filename";
export type AssetListOrder = "asc" | "desc";

/** Server-side maximum resolved-selection size for synchronous bulk actions; see research.md §6. */
export const BULK_SYNC_MAX_ASSETS = 200;

export type BulkSelection =
  | { mode: "EXPLICIT"; assetIds: string[] }
  | { mode: "FILTERED"; datasetId: string; query: AssetListQuery };

export type BulkOperationResult = {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  failures?: { assetId: string; reason: string }[];
};

export type BulkAction = "ADD_LABEL" | "REMOVE_LABEL" | "CHANGE_STATUS" | "ASSIGN" | "DELETE" | "EXPORT_SELECTED";

/** Safe workflow DTOs intentionally omit any server-only actor data. */
export type SafeAssetWorkflowEvent = {
  id: string;
  action: AssetWorkflowAction;
  fromStatus: AssetStatus | null;
  toStatus: AssetStatus | null;
  assetRevision: number;
  feedback: string | null;
  createdAt: Date;
  actor: { id: string; name: string | null; email: string };
};

/**
 * Browser-safe workflow projection for the selected asset.  The server derives
 * this from the current Asset row and the caller's dataset permissions; it is
 * deliberately not an authorization input.
 */
export type SafeWorkspaceWorkflow = {
  datasetId: string;
  assetId: string;
  status: AssetStatus;
  revision: number;
  permittedActions: AssetWorkflowAction[];
};
