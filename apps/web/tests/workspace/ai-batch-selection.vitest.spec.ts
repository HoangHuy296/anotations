import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { describe, expect, it } from "vitest";

import { aiProblemForModality, aiTargetKey, applyPreviewResponse, deriveAiTargetIntent, targetInvalidMessage, type AiPreviewState, type SelectionSnapshot } from "@/lib/ai/ai-target-context";
import { useAssetSelectionStore } from "@/stores/asset-selection-store";

const none: SelectionSnapshot = { datasetId: null, mode: "NONE", explicitIds: new Set(), filteredQuery: null, filteredCount: 0 };

describe("AI target intent from Phase 022 selection state", () => {
  it("no selection targets the current Asset as one CURRENT_ASSET target", () => {
    const intent = deriveAiTargetIntent("d1", "a1", none);
    expect(intent).toEqual({ kind: "CURRENT", displayCount: 1, target: { mode: "CURRENT_ASSET", assetId: "a1" } });
  });

  it("an explicit selection in this dataset is sent as the ids (across pages/hidden), not a page slice", () => {
    const ids = new Set(["a", "b", "hidden-by-filter"]);
    const intent = deriveAiTargetIntent("d1", "open", { ...none, datasetId: "d1", mode: "EXPLICIT", explicitIds: ids });
    expect(intent.kind).toBe("BULK");
    if (intent.kind !== "BULK") return;
    expect(intent.displayCount).toBe(3);
    expect(intent.target).toEqual({ mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds: ["a", "b", "hidden-by-filter"] } });
  });

  it("a filtered selection sends the query only; filteredCount is display, never an id list", () => {
    const query = { q: "cat", modality: "IMAGE" as const };
    const intent = deriveAiTargetIntent("d1", "open", { ...none, datasetId: "d1", mode: "FILTERED", filteredQuery: query, filteredCount: 4321 });
    expect(intent.kind).toBe("BULK");
    if (intent.kind !== "BULK") return;
    expect(intent.displayCount).toBe(4321);
    expect(intent.target).toEqual({ mode: "BULK_SELECTION", selection: { mode: "FILTERED", query } });
    expect(JSON.stringify(intent.target)).not.toContain("4321");
  });

  it("an active selection from another dataset, or an empty one, is invalid and never falls back to the current Asset", () => {
    expect(deriveAiTargetIntent("d1", "open", { ...none, datasetId: "other", mode: "EXPLICIT", explicitIds: new Set(["x"]) })).toEqual({ kind: "INVALID", reason: "STALE_DATASET" });
    expect(deriveAiTargetIntent("d1", "open", { ...none, datasetId: "d1", mode: "EXPLICIT", explicitIds: new Set() })).toEqual({ kind: "INVALID", reason: "EMPTY_SELECTION" });
    expect(deriveAiTargetIntent("d1", "open", { ...none, datasetId: "d1", mode: "FILTERED", filteredQuery: null })).toEqual({ kind: "INVALID", reason: "EMPTY_SELECTION" });
  });

  it("more than the wire ceiling of explicit ids is never sent", () => {
    const ids = new Set(Array.from({ length: 1001 }, (_, i) => `id${i}`));
    expect(deriveAiTargetIntent("d1", "open", { ...none, datasetId: "d1", mode: "EXPLICIT", explicitIds: ids })).toEqual({ kind: "INVALID", reason: "TOO_MANY_SELECTED" });
  });

  it("sort and pagination cannot change the target: the key depends only on the selection", () => {
    const a = deriveAiTargetIntent("d1", "open", { ...none, datasetId: "d1", mode: "FILTERED", filteredQuery: { q: "x" }, filteredCount: 5 });
    const b = deriveAiTargetIntent("d1", "open", { ...none, datasetId: "d1", mode: "FILTERED", filteredQuery: { q: "x" }, filteredCount: 5 });
    expect(aiTargetKey(a)).toBe(aiTargetKey(b));
  });

  it("current-Asset and one-member explicit intents differ only in the target wrapper, so both go through the same execution", () => {
    const current = deriveAiTargetIntent("d1", "a1", none);
    const explicit = deriveAiTargetIntent("d1", "a1", { ...none, datasetId: "d1", mode: "EXPLICIT", explicitIds: new Set(["a1"]) });
    expect(current.kind !== "INVALID" && explicit.kind !== "INVALID").toBe(true);
    if (current.kind === "INVALID" || explicit.kind === "INVALID") return;
    expect(current.displayCount).toBe(explicit.displayCount);
  });

  it("the run problem follows the resolved modality, not the open Asset's tool", () => {
    expect(aiProblemForModality("IMAGE")).toBe("detection");
    expect(aiProblemForModality("VIDEO")).toBe("tracking");
  });
});

describe("stale preview handling", () => {
  it("ignores an out-of-order response and accepts only the latest request", () => {
    let state: AiPreviewState = { status: "LOADING", requestId: 2 };
    const staleReady: AiPreviewState = { status: "READY", requestId: 1, count: 9, modality: "IMAGE", effectiveLimit: 3, previewFingerprint: "old", mode: "EXPLICIT" };
    state = applyPreviewResponse(state, 1, staleReady);
    expect(state).toEqual({ status: "LOADING", requestId: 2 });
    const fresh: AiPreviewState = { status: "READY", requestId: 2, count: 3, modality: "IMAGE", effectiveLimit: 3, previewFingerprint: "new", mode: "EXPLICIT" };
    expect(applyPreviewResponse(state, 2, fresh)).toEqual(fresh);
  });

  it("explains every rejection in visible text and states the effective limit", () => {
    for (const reason of ["STALE_DATASET", "EMPTY_SELECTION", "TARGET_EMPTY", "TARGET_MIXED_MODALITY", "TARGET_INELIGIBLE", "AI_CAPABILITY_UNVERIFIED", "ASSET_NOT_IN_DATASET"]) expect(targetInvalidMessage(reason).length).toBeGreaterThan(10);
    expect(targetInvalidMessage("TARGET_TOO_LARGE", 3)).toContain("3");
    expect(targetInvalidMessage("TARGET_TOO_LARGE", 3)).not.toContain("200");
  });
});

describe("selection store reuse", () => {
  it("clearing the store is the explicit reset for a stale selection", () => {
    useAssetSelectionStore.getState().toggle("d-old", "a1");
    expect(useAssetSelectionStore.getState().mode).toBe("EXPLICIT");
    useAssetSelectionStore.getState().clear();
    const state = useAssetSelectionStore.getState();
    expect(deriveAiTargetIntent("d-new", "open", { datasetId: state.datasetId, mode: state.mode, explicitIds: state.explicitIds, filteredQuery: state.filteredQuery, filteredCount: state.filteredCount }).kind).toBe("CURRENT");
  });
});
