import type { AiTargetMode } from "@annotationplatform/domain/ai-batch";

/**
 * Browser-safe wire types for AI Detection targets (feature 026). The browser
 * only states intent; the server resolves membership authoritatively and never
 * trusts counts, filenames, file locations or full Asset records from here.
 */
export type AiSelectionQuery = {
  q?: string; status?: string[]; modality?: string; labelId?: string[]; assignedToId?: string;
  createdFrom?: string; createdTo?: string; updatedFrom?: string; updatedTo?: string;
};

export type AiDetectionTarget =
  | { mode: "CURRENT_ASSET"; assetId: string }
  | { mode: "BULK_SELECTION"; selection: { mode: "EXPLICIT"; assetIds: string[] } | { mode: "FILTERED"; query: AiSelectionQuery } };

export type AiTargetSummary = { mode: AiTargetMode; count: number; modality: "IMAGE" | "VIDEO"; effectiveLimit: number };
