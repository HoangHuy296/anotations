import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTextAnnotationStore } from "@/stores/text-annotation-store";
import { redoLastTextCommand, undoLastTextCommand } from "@/lib/workspace/text-workspace";
import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";

/**
 * T095/T090: Undo/Redo core. `text-workspace.ts` is the only place an
 * entry's inverse/forward command is actually submitted -- these tests
 * mock `fetch` the same way `text-read-client.vitest.spec.ts` already does
 * for this codebase's other browser-client modules, since `node:test`'s
 * integration suite calls server functions directly and never exercises
 * this client-side orchestration layer.
 */

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}
function errorResponse(code: string, reason: string, status = 409) {
  return new Response(JSON.stringify({ error: { code, reason } }), { status });
}

const ASSET_ID = "asset-1";
const SOURCE_IDENTITY = `sha256:${"a".repeat(64)}`;

function span(overrides: Partial<SafeTextAnnotation> & { id: string }): SafeTextAnnotation {
  return {
    assetId: ASSET_ID, datasetId: "dataset-1", labelId: null, status: "DRAFT", revision: 1,
    geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity: SOURCE_IDENTITY, offsetUnit: "UTF16_CODE_UNIT", startOffset: 0, endOffset: 5 },
    properties: { custom: {} }, fromAnnotationId: null, toAnnotationId: null,
    createdById: "user-1", updatedById: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function seedAsset(annotations: SafeTextAnnotation[]) {
  useTextAnnotationStore.getState().initializeAsset({
    assetId: ASSET_ID, datasetId: "dataset-1", sourceIdentity: SOURCE_IDENTITY, boundaryOffsets: [0, 5, 10],
    savedAnnotations: annotations, assetRevision: 1,
  });
}

describe("text-workspace Undo/Redo core", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useTextAnnotationStore.getState().clearAsset();
  });

  it("undoLastTextCommand: submits the inverse labelId, updates the store, and moves the entry to the redo stack", async () => {
    seedAsset([span({ id: "span-1", labelId: "label-new", revision: 2 })]);
    useTextAnnotationStore.getState().pushUndoEntry({ kind: "label", annotationId: "span-1", inverseLabelId: "label-old", redoLabelId: "label-new" });

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.command).toEqual({ kind: "updateSpan", annotationId: "span-1", expectedRevision: 2, labelId: "label-old" });
      return jsonResponse(span({ id: "span-1", labelId: "label-old", revision: 3 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await undoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    expect(outcome).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const state = useTextAnnotationStore.getState();
    expect(state.undoStack).toHaveLength(0);
    expect(state.redoStack).toHaveLength(1);
    expect(state.snapshot?.savedAnnotations.find((a) => a.id === "span-1")?.labelId).toBe("label-old");
  });

  it("redoLastTextCommand: submits the forward labelId and moves the entry back to the undo stack", async () => {
    seedAsset([span({ id: "span-1", labelId: "label-old", revision: 3 })]);
    useTextAnnotationStore.getState().pushRedoEntry({ kind: "label", annotationId: "span-1", inverseLabelId: "label-old", redoLabelId: "label-new" });

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.command).toEqual({ kind: "updateSpan", annotationId: "span-1", expectedRevision: 3, labelId: "label-new" });
      return jsonResponse(span({ id: "span-1", labelId: "label-new", revision: 4 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await redoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    expect(outcome).toEqual({ ok: true });

    const state = useTextAnnotationStore.getState();
    expect(state.redoStack).toHaveLength(0);
    expect(state.undoStack).toHaveLength(1);
    expect(state.snapshot?.savedAnnotations.find((a) => a.id === "span-1")?.labelId).toBe("label-new");
  });

  it("undoLastTextCommand: a property-patch entry submits its inverse set/unset and never touches label or geometry", async () => {
    seedAsset([span({ id: "span-1", labelId: "kept-label", properties: { custom: { confidence: 0.9 } }, revision: 5 })]);
    useTextAnnotationStore.getState().pushUndoEntry({
      kind: "properties", annotationId: "span-1",
      inversePatch: { set: { confidence: 0.5 }, unset: ["reviewed"] },
      redoPatch: { set: { confidence: 0.9, reviewed: true }, unset: [] },
    });

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.command).toEqual({ kind: "updateSpan", annotationId: "span-1", expectedRevision: 5, propertyPatch: { set: { confidence: 0.5 }, unset: ["reviewed"] } });
      return jsonResponse(span({ id: "span-1", labelId: "kept-label", properties: { custom: { confidence: 0.5 } }, revision: 6 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await undoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    expect(outcome).toEqual({ ok: true });
    const updated = useTextAnnotationStore.getState().snapshot?.savedAnnotations.find((a) => a.id === "span-1");
    expect(updated?.properties).toEqual({ custom: { confidence: 0.5 } });
    expect(updated?.labelId).toBe("kept-label");
  });

  it("undoLastTextCommand: a geometry entry submits its inverse startOffset/endOffset (T080/T081 range resize) and never touches label or properties", async () => {
    seedAsset([span({ id: "span-1", labelId: "kept-label", geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity: SOURCE_IDENTITY, offsetUnit: "UTF16_CODE_UNIT", startOffset: 0, endOffset: 8 }, revision: 4 })]);
    useTextAnnotationStore.getState().pushUndoEntry({ kind: "geometry", annotationId: "span-1", inverseRange: { startOffset: 0, endOffset: 5 }, redoRange: { startOffset: 0, endOffset: 8 } });

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.command).toEqual({ kind: "updateSpan", annotationId: "span-1", expectedRevision: 4, startOffset: 0, endOffset: 5 });
      return jsonResponse(span({ id: "span-1", labelId: "kept-label", geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity: SOURCE_IDENTITY, offsetUnit: "UTF16_CODE_UNIT", startOffset: 0, endOffset: 5 }, revision: 5 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await undoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    expect(outcome).toEqual({ ok: true });
    const updated = useTextAnnotationStore.getState().snapshot?.savedAnnotations.find((a) => a.id === "span-1");
    expect(updated?.labelId).toBe("kept-label");
    expect(updated?.geometry).toMatchObject({ startOffset: 0, endOffset: 5 });
  });

  it("a conflicting inverse (REVISION_STALE) leaves durable content and the undo stack intact -- the entry is put back, not dropped", async () => {
    seedAsset([span({ id: "span-1", labelId: "label-new", revision: 2 })]);
    const entry = { kind: "label" as const, annotationId: "span-1", inverseLabelId: "label-old", redoLabelId: "label-new" };
    useTextAnnotationStore.getState().pushUndoEntry(entry);

    vi.stubGlobal("fetch", vi.fn(async () => errorResponse("ANNOTATION_REVISION_CONFLICT", "REVISION_STALE")));

    const outcome = await undoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    expect(outcome.ok).toBe(false);

    const state = useTextAnnotationStore.getState();
    expect(state.undoStack).toEqual([entry]);
    expect(state.redoStack).toHaveLength(0);
    // Durable content (the store's own view of it) is unchanged -- still label-new, never optimistically set to label-old.
    expect(state.snapshot?.savedAnnotations.find((a) => a.id === "span-1")?.labelId).toBe("label-new");
  });

  it("undo/redo with an empty stack is a no-op that never calls fetch", async () => {
    seedAsset([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await undoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1)).toEqual({ ok: false, reason: "Nothing to undo." });
    expect(await redoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1)).toEqual({ ok: false, reason: "Nothing to redo." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T172: a combined session (label, then geometry, then property edits on one span) undoes and redoes each in correct LIFO order with zero cross-kind interference", async () => {
    seedAsset([span({ id: "span-1", labelId: "label-b", geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity: SOURCE_IDENTITY, offsetUnit: "UTF16_CODE_UNIT", startOffset: 0, endOffset: 8 }, properties: { custom: { confidence: 0.9 } }, revision: 4 })]);
    // Push order mirrors a real editing session: relabel, then resize, then annotate a property -- each independently.
    useTextAnnotationStore.getState().pushUndoEntry({ kind: "label", annotationId: "span-1", inverseLabelId: "label-a", redoLabelId: "label-b" });
    useTextAnnotationStore.getState().pushUndoEntry({ kind: "geometry", annotationId: "span-1", inverseRange: { startOffset: 0, endOffset: 5 }, redoRange: { startOffset: 0, endOffset: 8 } });
    useTextAnnotationStore.getState().pushUndoEntry({ kind: "properties", annotationId: "span-1", inversePatch: { set: {}, unset: ["confidence"] }, redoPatch: { set: { confidence: 0.9 }, unset: [] } });
    expect(useTextAnnotationStore.getState().undoStack).toHaveLength(3);

    let revision = 4;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      revision += 1;
      // Each command patches fields from exactly one kind-group -- never a
      // mix -- proving no cross-kind interference. Geometry legitimately
      // touches two fields together (startOffset+endOffset), so the check
      // is "belongs to one group", not "exactly one raw field".
      const fields = Object.keys(body.command).filter((key) => !["kind", "annotationId", "expectedRevision"].includes(key));
      const groups = { label: ["labelId"], geometry: ["startOffset", "endOffset"], properties: ["propertyPatch"] };
      const matchedGroup = Object.entries(groups).find(([, groupFields]) => fields.every((field) => groupFields.includes(field)));
      expect(matchedGroup, `command fields ${JSON.stringify(fields)} must belong to exactly one kind-group`).toBeDefined();
      const current = useTextAnnotationStore.getState().snapshot!.savedAnnotations.find((a) => a.id === "span-1")!;
      const kind = matchedGroup![0];
      if (kind === "properties") {
        const nextCustom: Record<string, unknown> = { ...current.properties.custom, ...body.command.propertyPatch.set };
        for (const key of body.command.propertyPatch.unset as string[]) delete nextCustom[key];
        return jsonResponse({ ...current, revision, properties: { custom: nextCustom } });
      }
      return jsonResponse({ ...current, revision, ...(kind === "label" ? { labelId: body.command.labelId } : { geometry: { ...current.geometry, startOffset: body.command.startOffset, endOffset: body.command.endOffset } }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Undo x3: properties -> geometry -> label (LIFO on the undo stack itself).
    await undoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    await undoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    await undoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    expect(useTextAnnotationStore.getState().undoStack).toHaveLength(0);
    expect(useTextAnnotationStore.getState().redoStack).toHaveLength(3);
    const afterUndo = useTextAnnotationStore.getState().snapshot?.savedAnnotations.find((a) => a.id === "span-1");
    expect(afterUndo?.labelId).toBe("label-a");
    expect(afterUndo?.geometry).toMatchObject({ startOffset: 0, endOffset: 5 });
    expect(afterUndo?.properties).toEqual({ custom: {} });

    // Redo x3: label -> geometry -> properties (LIFO on the redo stack -- the most recently undone action redoes first).
    await redoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    await redoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    await redoLastTextCommand(ASSET_ID, SOURCE_IDENTITY, 1);
    expect(useTextAnnotationStore.getState().redoStack).toHaveLength(0);
    expect(useTextAnnotationStore.getState().undoStack).toHaveLength(3);
    const afterRedo = useTextAnnotationStore.getState().snapshot?.savedAnnotations.find((a) => a.id === "span-1");
    expect(afterRedo?.labelId).toBe("label-b");
    expect(afterRedo?.geometry).toMatchObject({ startOffset: 0, endOffset: 8 });
    expect(afterRedo?.properties).toEqual({ custom: { confidence: 0.9 } });

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("a genuinely new edit (pushUndoEntry) clears the redo stack; redo-then-restore (restoreUndoEntry) does not", async () => {
    useTextAnnotationStore.getState().pushRedoEntry({ kind: "label", annotationId: "x", inverseLabelId: null, redoLabelId: "y" });
    useTextAnnotationStore.getState().pushUndoEntry({ kind: "label", annotationId: "z", inverseLabelId: null, redoLabelId: "w" });
    expect(useTextAnnotationStore.getState().redoStack).toHaveLength(0);

    useTextAnnotationStore.getState().pushRedoEntry({ kind: "label", annotationId: "a", inverseLabelId: null, redoLabelId: "b" });
    useTextAnnotationStore.getState().restoreUndoEntry({ kind: "label", annotationId: "c", inverseLabelId: null, redoLabelId: "d" });
    expect(useTextAnnotationStore.getState().redoStack).toHaveLength(1);
    expect(useTextAnnotationStore.getState().undoStack.at(-1)).toEqual({ kind: "label", annotationId: "c", inverseLabelId: null, redoLabelId: "d" });
  });
});
