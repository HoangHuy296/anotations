import assert from "node:assert/strict";
import test from "node:test";

import { useAnnotationStore } from "../../src/stores/image-annotation-store.js";
import { TrackAutosaveCoordinator } from "../../src/lib/workspace/video-autosave.js";
import { workspaceEngineRegistry } from "../../src/lib/workspace/workspace-engine-registry.js";
import { submitTextAnnotationCommand } from "../../src/lib/annotations/text-annotation-client.js";

/**
 * T047: proves the T046 active-engine flush contract — the single function
 * `workspace-header.tsx` (Submit/Resubmit), `dataset-sidebar.tsx`
 * (previous/next), and every `*-properties-tabs.tsx` (asset-list selection)
 * now all call instead of independently firing both autosave systems and
 * reusing a stale page-load revision. This repo has no jsdom/@testing-
 * library/react (AGENTS.md requires explicit permission before adding one —
 * see the sibling `workspace-engine-registry.vitest.spec.ts`), so this
 * exercises the shared contract those callers depend on directly: the real
 * Zustand autosave store and the real `TrackAutosaveCoordinator`, with only
 * the browser `fetch` call to the workflow-status endpoint stubbed (the one
 * genuine network boundary a Node test can't cross).
 *
 * Foundation checkpoint requirement (tasks.md): this must pass *before* any
 * user story begins, proving the pre-existing bug this session found and
 * fixed — Submit reusing a stale page-load revision after an autosaved edit
 * — is actually gone, not just plausible from reading the diff.
 */

const REAL_FETCH = globalThis.fetch;

function stubWorkflowRevisionFetch(outcome: { revision: number } | { networkError: true } | { httpError: true }) {
  globalThis.fetch = (async () => {
    if ("networkError" in outcome) throw new Error("simulated network failure");
    if ("httpError" in outcome) return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), { status: 500 });
    return new Response(JSON.stringify({ data: { asset: { status: "IN_PROGRESS", revision: outcome.revision } } }), { status: 200 });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = REAL_FETCH;
}

function resetAutosaveStore() {
  useAnnotationStore.setState({ saveStates: {}, conflictDrafts: {} });
}

test("IMAGE-style flush (createEngineFlush(false)): with nothing pending, success carries the exact server-authoritative revision", async () => {
  resetAutosaveStore();
  stubWorkflowRevisionFetch({ revision: 7 });
  try {
    const result = await workspaceEngineRegistry.IMAGE.flush("dataset_1", "asset_1");
    assert.deepEqual(result, { ok: true, assetRevision: 7 });
  } finally {
    restoreFetch();
  }
});

test("IMAGE-style flush: a pending autosave finishes before the revision is read (dirty work must complete first)", async () => {
  resetAutosaveStore();
  stubWorkflowRevisionFetch({ revision: 12 });
  let taskRan = false;
  try {
    useAnnotationStore.getState().scheduleAutosave("annotation:a1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      taskRan = true;
      return "saved";
    }, 5_000); // long delay -- only `flush()` should trigger it, not the timer
    const result = await workspaceEngineRegistry.IMAGE.flush("dataset_1", "asset_1");
    assert.equal(taskRan, true, "flush must await the pending autosave, not race it");
    assert.deepEqual(result, { ok: true, assetRevision: 12 });
  } finally {
    restoreFetch();
  }
});

test("IMAGE-style flush: a failed autosave blocks the barrier entirely -- never reports success with a possibly-stale revision", async () => {
  resetAutosaveStore();
  stubWorkflowRevisionFetch({ revision: 99 });
  try {
    useAnnotationStore.getState().scheduleAutosave("annotation:a2", async () => "failed", 5_000);
    const result = await workspaceEngineRegistry.IMAGE.flush("dataset_1", "asset_1");
    assert.deepEqual(result, { ok: false, reason: "SAVE_FAILED" });
  } finally {
    restoreFetch();
  }
});

test("IMAGE-style flush: a conflicting autosave also blocks the barrier", async () => {
  resetAutosaveStore();
  stubWorkflowRevisionFetch({ revision: 3 });
  try {
    useAnnotationStore.getState().scheduleAutosave("annotation:a3", async () => "conflict", 5_000);
    const result = await workspaceEngineRegistry.IMAGE.flush("dataset_1", "asset_1");
    assert.deepEqual(result, { ok: false, reason: "SAVE_FAILED" });
  } finally {
    restoreFetch();
  }
});

test("flush: a read failure (network error or non-2xx) after a successful save is never treated as a successful flush", async () => {
  resetAutosaveStore();
  try {
    stubWorkflowRevisionFetch({ networkError: true });
    assert.deepEqual(await workspaceEngineRegistry.IMAGE.flush("dataset_1", "asset_1"), { ok: false, reason: "REVISION_UNAVAILABLE" });
    stubWorkflowRevisionFetch({ httpError: true });
    assert.deepEqual(await workspaceEngineRegistry.IMAGE.flush("dataset_1", "asset_1"), { ok: false, reason: "REVISION_UNAVAILABLE" });
  } finally {
    restoreFetch();
  }
});

test("VIDEO-style flush (createEngineFlush(true)): flushes the dedicated TrackAutosaveCoordinator in addition to the generic store, success carries the current revision", async () => {
  resetAutosaveStore();
  stubWorkflowRevisionFetch({ revision: 21 });
  let saveCalled = false;
  try {
    const coordinator = new TrackAutosaveCoordinator("track_1", 1);
    coordinator.schedule(async (revision) => {
      saveCalled = true;
      return { id: "track_1", videoAssetId: "asset_1", labelId: null, name: null, color: null, properties: {}, status: "DRAFT", revision: revision + 1, annotationType: "BOUNDING_BOX", interpolationMode: "LINEAR", createdAt: "", updatedAt: "" } as never;
    });
    const result = await workspaceEngineRegistry.VIDEO.flush("dataset_1", "asset_1");
    assert.equal(saveCalled, true, "VIDEO flush must await the track coordinator's pending save");
    assert.deepEqual(result, { ok: true, assetRevision: 21 });
    await coordinator.dispose();
  } finally {
    restoreFetch();
  }
});

test("VIDEO-style flush: a track-revision conflict blocks the barrier (hasVideoAutosaveConflict)", async () => {
  resetAutosaveStore();
  stubWorkflowRevisionFetch({ revision: 5 });
  try {
    const coordinator = new TrackAutosaveCoordinator("track_2", 1);
    coordinator.schedule(async () => {
      const error = new Error("stale") as Error & { code: string };
      error.code = "VIDEO_TRACK_REVISION_CONFLICT";
      throw error;
    });
    const result = await workspaceEngineRegistry.VIDEO.flush("dataset_1", "asset_1");
    assert.deepEqual(result, { ok: false, reason: "SAVE_FAILED" });
    await coordinator.dispose().catch(() => undefined);
  } finally {
    restoreFetch();
  }
});

test("AUDIO/TEXT-style flush (createEngineFlush(false)): shares the exact same contract as IMAGE (no per-engine special-casing beyond the VIDEO track coordinator)", async () => {
  resetAutosaveStore();
  stubWorkflowRevisionFetch({ revision: 42 });
  try {
    assert.deepEqual(await workspaceEngineRegistry.AUDIO.flush("dataset_1", "asset_1"), { ok: true, assetRevision: 42 });
    assert.deepEqual(await workspaceEngineRegistry.TEXT.flush("dataset_1", "asset_1"), { ok: true, assetRevision: 42 });
  } finally {
    restoreFetch();
  }
});

// T086/T098: the test above only proves the no-op case (nothing actually
// pending) -- TEXT's own `includeTextCommands=true` branch
// (`flushTextAnnotationCommands`, text-annotation-client.ts's in-flight
// tracker) needs a genuinely in-flight command to prove Submit actually
// waits for it, not just that the contract shape matches IMAGE/AUDIO.

test("TEXT flush: waits for a genuinely in-flight span command to settle before reading the current revision -- Submit cannot race ahead of an unfinished save", async () => {
  resetAutosaveStore();
  let resolveCommand: (value: Response) => void = () => {};
  let workflowFetchCalls = 0;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("/text/annotations")) return new Promise<Response>((resolve) => { resolveCommand = resolve; });
    workflowFetchCalls += 1;
    return new Response(JSON.stringify({ data: { asset: { status: "IN_PROGRESS", revision: 7 } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const commandPromise = submitTextAnnotationCommand("asset_1", { operationId: "op-flush-pending", sourceIdentity: `sha256:${"a".repeat(64)}`, expectedPolicyRevision: 1, command: { kind: "createSpan", startOffset: 0, endOffset: 1, labelId: null } });
    const flushPromise = workspaceEngineRegistry.TEXT.flush("dataset_1", "asset_1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(workflowFetchCalls, 0, "flush must not read the current revision before the pending command settles");
    resolveCommand(new Response(JSON.stringify({ data: { id: "span-1" } }), { status: 201 }));
    const [commandResult, flushResult] = await Promise.all([commandPromise, flushPromise]);
    assert.equal(commandResult.ok, true);
    assert.deepEqual(flushResult, { ok: true, assetRevision: 7 });
    assert.equal(workflowFetchCalls, 1);
  } finally {
    restoreFetch();
  }
});

test("TEXT flush: a failed in-flight span command surfaces as SAVE_FAILED, blocking Submit -- never proceeds with a stale/partial revision", async () => {
  resetAutosaveStore();
  let resolveCommand: (value: Response) => void = () => {};
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("/text/annotations")) return new Promise<Response>((resolve) => { resolveCommand = resolve; });
    return new Response(JSON.stringify({ data: { asset: { status: "IN_PROGRESS", revision: 99 } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const commandPromise = submitTextAnnotationCommand("asset_1", { operationId: "op-flush-failed", sourceIdentity: `sha256:${"a".repeat(64)}`, expectedPolicyRevision: 1, command: { kind: "createSpan", startOffset: 0, endOffset: 1, labelId: null } });
    const flushPromise = workspaceEngineRegistry.TEXT.flush("dataset_1", "asset_1");
    resolveCommand(new Response(JSON.stringify({ error: { code: "ANNOTATION_REVISION_CONFLICT", reason: "REVISION_STALE" } }), { status: 409 }));
    const [, flushResult] = await Promise.all([commandPromise, flushPromise]);
    assert.deepEqual(flushResult, { ok: false, reason: "SAVE_FAILED" });
  } finally {
    restoreFetch();
  }
});

test("late response: a flush's own network call resolving after a caller no longer cares still reports the correct result shape (never a stale echo of a different assetId)", async () => {
  resetAutosaveStore();
  try {
    // Two concurrent flushes for different assets, resolving out of order --
    // each fetch call carries its own assetId in the request; the mock
    // below asserts the revision returned always corresponds to the fetch
    // that was actually issued, never a cross-asset mixup.
    let call = 0;
    globalThis.fetch = (async (url: unknown) => {
      call += 1;
      const isAssetTwo = String(url).includes("asset_two");
      // Resolve asset_two's request first even though it was issued second,
      // to prove there is no shared/global "last response wins" state.
      await new Promise((resolve) => setTimeout(resolve, isAssetTwo ? 5 : 30));
      return new Response(JSON.stringify({ data: { asset: { status: "IN_PROGRESS", revision: isAssetTwo ? 200 : 100 } } }), { status: 200 });
    }) as typeof fetch;

    const [resultOne, resultTwo] = await Promise.all([
      workspaceEngineRegistry.IMAGE.flush("dataset_1", "asset_one"),
      workspaceEngineRegistry.IMAGE.flush("dataset_1", "asset_two"),
    ]);
    assert.equal(call, 2);
    assert.deepEqual(resultOne, { ok: true, assetRevision: 100 });
    assert.deepEqual(resultTwo, { ok: true, assetRevision: 200 });
  } finally {
    restoreFetch();
  }
});
