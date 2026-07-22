import type { JobStage, JobStatus, JobType, Modality } from "@internal/db";

/**
 * Browser-safe export status. This deliberately excludes raw Job JSON,
 * queue/lock fields and private storage metadata.
 */
export type SafeExportJob = {
  id: string;
  datasetId: string;
  type: Extract<JobType, "EXPORT_DATASET">;
  status: JobStatus;
  stage: JobStage | null;
  progress: number | null;
  totalItems: number | null;
  processedItems: number | null;
  successCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
  summary: { message?: string; outcome?: "completed" | "failed" | "canceled"; completedAt?: string; resultCount?: number } | null;
  createdAt: string;
  updatedAt: string;
};

export type SafeExportDownload = {
  /** Authorized, short-lived, object-scoped capability; never persist or log it. */
  url: string;
  expiresAt: string;
  filename: string;
};

export type SafeExportStorageReference = {
  assetId: string;
  modality: Modality;
  contentType: string | null;
  sizeBytes: string | null;
  checksum: string | null;
};

export type DatasetExportManifestV1 = {
  schemaVersion: "1";
  exportedAt: string;
  dataset: Record<string, unknown>;
  assets: Array<Record<string, unknown> & { storage: SafeExportStorageReference | null }>;
  labels: Record<string, unknown>[];
  annotations: Record<string, unknown>[];
};
