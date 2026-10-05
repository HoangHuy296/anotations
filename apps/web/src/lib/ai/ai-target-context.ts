import type { AiDetectionTarget } from "@/types/ai-batch";
import type { AssetListQuery } from "@/types/workspace";

/**
 * Pure, client-safe derivation of what the AI Detection panel targets from
 * Phase 022 selection state (feature 026). The panel and the store never
 * resolve membership: this only states intent; the server resolves and
 * authorizes it.
 */
export type SelectionSnapshot = {
  datasetId: string | null;
  mode: "NONE" | "EXPLICIT" | "FILTERED";
  explicitIds: ReadonlySet<string>;
  filteredQuery: AssetListQuery | null;
  filteredCount: number;
};

export type AiTargetIntent =
  | { kind: "CURRENT"; target: AiDetectionTarget; displayCount: 1 }
  | { kind: "BULK"; target: AiDetectionTarget; displayCount: number; selectionMode: "EXPLICIT" | "FILTERED" }
  | { kind: "INVALID"; reason: "STALE_DATASET" | "EMPTY_SELECTION" | "TOO_MANY_SELECTED" };

/** Wire ceiling of the Phase 022 explicit selection schema; larger selections are never sent. */
export const AI_EXPLICIT_WIRE_CEILING = 1000;

export function deriveAiTargetIntent(datasetId: string, currentAssetId: string, selection: SelectionSnapshot): AiTargetIntent {
  if (selection.mode === "NONE") return { kind: "CURRENT", target: { mode: "CURRENT_ASSET", assetId: currentAssetId }, displayCount: 1 };
  // An active selection never silently falls back to the current Asset: a stale or empty one is invalid.
  if (selection.datasetId !== datasetId) return { kind: "INVALID", reason: "STALE_DATASET" };
  if (selection.mode === "EXPLICIT") {
    if (selection.explicitIds.size === 0) return { kind: "INVALID", reason: "EMPTY_SELECTION" };
    if (selection.explicitIds.size > AI_EXPLICIT_WIRE_CEILING) return { kind: "INVALID", reason: "TOO_MANY_SELECTED" };
    return { kind: "BULK", selectionMode: "EXPLICIT", displayCount: selection.explicitIds.size, target: { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds: [...selection.explicitIds] } } };
  }
  if (!selection.filteredQuery) return { kind: "INVALID", reason: "EMPTY_SELECTION" };
  return { kind: "BULK", selectionMode: "FILTERED", displayCount: selection.filteredCount, target: { mode: "BULK_SELECTION", selection: { mode: "FILTERED", query: selection.filteredQuery as never } } };
}

/** Stable key for effect dependencies and stale-response comparison. */
export function aiTargetKey(intent: AiTargetIntent): string {
  return intent.kind === "INVALID" ? `invalid:${intent.reason}` : JSON.stringify(intent.target);
}

/** The AI problem a resolved modality runs; the open Asset's own tool may differ from the selection's modality. */
export function aiProblemForModality(modality: "IMAGE" | "VIDEO"): "detection" | "tracking" {
  return modality === "VIDEO" ? "tracking" : "detection";
}

export type AiPreviewState =
  | { status: "IDLE" }
  | { status: "LOADING"; requestId: number }
  | { status: "READY"; requestId: number; count: number; modality: "IMAGE" | "VIDEO"; effectiveLimit: number; previewFingerprint: string; mode: string }
  | { status: "INELIGIBLE"; requestId: number; reason: string; effectiveLimit: number }
  | { status: "ERROR"; requestId: number };

/** Ignores a response that is not for the latest request (out-of-order or superseded previews). */
export function applyPreviewResponse(current: AiPreviewState, requestId: number, next: AiPreviewState): AiPreviewState {
  const latest = current.status === "IDLE" ? -1 : current.requestId;
  return requestId === latest ? next : current;
}

export function targetInvalidMessage(reason: string, effectiveLimit?: number): string {
  switch (reason) {
    case "STALE_DATASET": return "The selection belongs to another dataset. Clear it to run AI on the current asset.";
    case "EMPTY_SELECTION": return "No assets are selected. Select assets or clear the selection.";
    case "TOO_MANY_SELECTED": return "Too many assets are selected for one AI run.";
    case "TARGET_EMPTY": return "No assets match the selection.";
    case "TARGET_TOO_LARGE": return effectiveLimit ? `AI can run on at most ${effectiveLimit} assets at a time. Reduce the selection.` : "The selection is too large for one AI run.";
    case "TARGET_MIXED_MODALITY": return "Selected assets must all be the same type (for example all images).";
    case "TARGET_INELIGIBLE": return "One or more selected assets cannot be processed (missing source file).";
    case "ASSET_NOT_IN_DATASET": return "One or more selected assets are no longer available in this dataset.";
    case "AI_CAPABILITY_UNVERIFIED": return "AI is not available for this asset type or batch size yet.";
    default: return "This selection cannot be run. Adjust it and try again.";
  }
}
