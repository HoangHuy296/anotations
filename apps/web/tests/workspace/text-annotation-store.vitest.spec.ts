import { describe, expect, it } from "vitest";

import { useTextAnnotationStore } from "@/stores/text-annotation-store";
import type { TextAssetSnapshot } from "@/types/text";

const SNAPSHOT_A: TextAssetSnapshot = {
  assetId: "asset_a", datasetId: "dataset_1", sourceIdentity: "sha256:a",
  boundaryOffsets: [0, 1, 2], savedAnnotations: [], assetRevision: 3,
};
const SNAPSHOT_B: TextAssetSnapshot = {
  assetId: "asset_b", datasetId: "dataset_1", sourceIdentity: "sha256:b",
  boundaryOffsets: [0, 5], savedAnnotations: [], assetRevision: 1,
};

describe("useTextAnnotationStore", () => {
  it("initializeAsset sets the snapshot and starts with empty pending/selection/search/hover state", () => {
    useTextAnnotationStore.getState().initializeAsset(SNAPSHOT_A);
    const state = useTextAnnotationStore.getState();
    expect(state.assetId).toBe("asset_a");
    expect(state.snapshot).toEqual(SNAPSHOT_A);
    expect(state.pendingCommands).toEqual([]);
    expect(state.selection).toBeNull();
    expect(state.search).toEqual({ query: "", matches: [], activeMatchIndex: null });
    expect(state.hoveredAnnotationId).toBeNull();
  });

  it("switching to a different asset clears selection/search/hover/pending state -- no leakage across scope changes", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.setSelection({ startOffset: 0, endOffset: 2 });
    store.setSearch({ query: "hello", matches: [{ startOffset: 0, endOffset: 5 }], activeMatchIndex: 0 });
    store.setHoveredAnnotationId("ann_1");
    store.addPendingCommand({ operationId: "op_1", kind: "createSpan", submittedAt: Date.now(), status: "pending" });
    expect(useTextAnnotationStore.getState().pendingCommands).toHaveLength(1);

    store.initializeAsset(SNAPSHOT_B);
    const state = useTextAnnotationStore.getState();
    expect(state.assetId).toBe("asset_b");
    expect(state.snapshot).toEqual(SNAPSHOT_B);
    expect(state.selection).toBeNull();
    expect(state.search).toEqual({ query: "", matches: [], activeMatchIndex: null });
    expect(state.hoveredAnnotationId).toBeNull();
    expect(state.pendingCommands).toEqual([]);
  });

  it("re-initializing the *same* asset still resets local ephemeral/pending state -- a fresh snapshot is authoritative, never merged with stale local state", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.setSelection({ startOffset: 1, endOffset: 2 });
    store.addPendingCommand({ operationId: "op_2", kind: "createSpan", submittedAt: Date.now(), status: "saving" });

    store.initializeAsset(SNAPSHOT_A);
    const state = useTextAnnotationStore.getState();
    expect(state.selection).toBeNull();
    expect(state.pendingCommands).toEqual([]);
  });

  it("clearAsset resets everything, including the assetId/snapshot themselves", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.setSelection({ startOffset: 0, endOffset: 1 });
    store.clearAsset();
    const state = useTextAnnotationStore.getState();
    expect(state.assetId).toBeNull();
    expect(state.snapshot).toBeNull();
    expect(state.selection).toBeNull();
    expect(state.pendingCommands).toEqual([]);
  });

  it("pending command lifecycle: add, update status, remove", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.addPendingCommand({ operationId: "op_3", kind: "updateSpan", submittedAt: 1, status: "pending" });
    store.updatePendingCommandStatus("op_3", "saved");
    expect(useTextAnnotationStore.getState().pendingCommands[0]?.status).toBe("saved");
    store.removePendingCommand("op_3");
    expect(useTextAnnotationStore.getState().pendingCommands).toEqual([]);
  });

  it("setSearch merges into the existing search state rather than replacing it wholesale", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.setSearch({ query: "AI" });
    store.setSearch({ matches: [{ startOffset: 0, endOffset: 2 }], activeMatchIndex: 0 });
    expect(useTextAnnotationStore.getState().search).toEqual({ query: "AI", matches: [{ startOffset: 0, endOffset: 2 }], activeMatchIndex: 0 });
  });
});

describe("reader scope", () => {
  it("resets the text tool when a new asset snapshot is loaded", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.setTool("scroll");
    expect(useTextAnnotationStore.getState().tool).toBe("scroll");
    store.initializeAsset(SNAPSHOT_B);
    expect(useTextAnnotationStore.getState().tool).toBe("select");
    expect(useTextAnnotationStore.getState().reader).toBeNull();
  });

  it("changing reader tools clears transient selection without modifying annotations", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.setSelection({ startOffset: 0, endOffset: 2 });
    store.setTool("scroll");
    const state = useTextAnnotationStore.getState();
    expect(state.selection).toBeNull();
    expect(state.snapshot).toEqual(SNAPSHOT_A);
    expect(state.pendingCommands).toEqual([]);
  });

  it("changing reader tools clears an in-progress relation click and any command error", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.setTool("relation");
    store.setPendingRelationFromId("ann_from");
    store.setCommandError("INVALID_REQUEST");
    store.setTool("select");
    const state = useTextAnnotationStore.getState();
    expect(state.pendingRelationFromId).toBeNull();
    expect(state.commandError).toBeNull();
  });
});

describe("policy and label/relation-type selection", () => {
  it("resets policy and active label/relation-type choices on every initializeAsset, even for the same asset", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.setPolicy({ revision: 4, entityLabelIds: ["lbl_1"], classificationGroups: [], relationTypes: [] });
    store.setActiveEntityLabelId("lbl_1");
    store.setActiveRelationLabelId("rel_1");
    expect(useTextAnnotationStore.getState().policyStatus).toBe("loaded");

    store.initializeAsset(SNAPSHOT_A);
    const state = useTextAnnotationStore.getState();
    expect(state.policy).toBeNull();
    expect(state.policyStatus).toBe("idle");
    expect(state.activeEntityLabelId).toBeNull();
    expect(state.activeRelationLabelId).toBeNull();
  });
});

describe("local annotation mutations", () => {
  const SPAN_ONE = { id: "ann_1", assetId: "asset_a", datasetId: "dataset_1", labelId: null, status: "DRAFT", revision: 1, geometry: { schemaVersion: 1 as const, kind: "text-span" as const, sourceIdentity: "sha256:a", offsetUnit: "UTF16_CODE_UNIT" as const, startOffset: 0, endOffset: 2 }, properties: { custom: {} }, fromAnnotationId: null, toAnnotationId: null, createdById: "user_1", updatedById: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

  it("upsertAnnotation appends a new annotation and replaces an existing one by id", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.upsertAnnotation(SPAN_ONE);
    expect(useTextAnnotationStore.getState().snapshot?.savedAnnotations).toEqual([SPAN_ONE]);

    const updated = { ...SPAN_ONE, revision: 2 };
    store.upsertAnnotation(updated);
    const state = useTextAnnotationStore.getState();
    expect(state.snapshot?.savedAnnotations).toHaveLength(1);
    expect(state.snapshot?.savedAnnotations[0]?.revision).toBe(2);
  });

  it("removeAnnotationLocal drops the annotation by id and is a no-op before any snapshot exists", () => {
    useTextAnnotationStore.getState().clearAsset();
    expect(() => useTextAnnotationStore.getState().removeAnnotationLocal("ann_1")).not.toThrow();

    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.upsertAnnotation(SPAN_ONE);
    store.removeAnnotationLocal("ann_1");
    expect(useTextAnnotationStore.getState().snapshot?.savedAnnotations).toEqual([]);
  });

  it("applyRemoteAnnotations (T139/T144): replaces the saved list with a fresh server snapshot for the current asset -- this is what makes another user's realtime edit actually visible, not merely re-fetched and discarded", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.upsertAnnotation(SPAN_ONE);

    const remoteSpan = { ...SPAN_ONE, id: "ann_remote", revision: 1 };
    store.applyRemoteAnnotations("asset_a", [remoteSpan]);
    expect(useTextAnnotationStore.getState().snapshot?.savedAnnotations).toEqual([remoteSpan]);
  });

  it("applyRemoteAnnotations is a no-op for a since-switched-away asset -- never applies stale data to the wrong scope", () => {
    const store = useTextAnnotationStore.getState();
    store.initializeAsset(SNAPSHOT_A);
    store.initializeAsset(SNAPSHOT_B);
    store.applyRemoteAnnotations("asset_a", [SPAN_ONE]);
    expect(useTextAnnotationStore.getState().snapshot?.savedAnnotations).toEqual([]);
  });
});
