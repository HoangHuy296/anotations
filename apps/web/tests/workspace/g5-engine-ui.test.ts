import "../../../../scripts/db-safety/test-entry.cjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { WorkspaceEngine } from "@/components/workspace/workspace-engine";
import WorkspaceLoading from "@/app/(app)/workspace/[datasetId]/loading";
import WorkspaceError from "@/app/(app)/workspace/[datasetId]/error";
import WorkspaceNotFound from "@/app/(app)/workspace/[datasetId]/not-found";
import { workspaceEngineRegistry, type WorkspaceEngineRegistryEntry } from "@/lib/workspace/workspace-engine-registry";
import type { WorkspaceDataset, WorkspaceSelection } from "@/types/workspace";

// Actual Next router context supplies SSR's required provider; there is no
// framework-module mock or new process allowance. Browser hydration and mount
// effects require separate verification; HTTP SSR cannot establish those effects.
const router: AppRouterInstance = {
  back: () => undefined, forward: () => undefined, refresh: () => undefined,
  push: () => undefined, replace: () => undefined, prefetch: () => undefined,
};
function render(surface: ReactNode) {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, surface));
}

test("registry contains exactly the four engine entries with complete surfaces", () => {
  const keys = Object.keys(workspaceEngineRegistry).sort();
  assert.deepEqual(keys, ["AUDIO", "IMAGE", "TEXT", "VIDEO"]);
  for (const engine of keys as Array<keyof typeof workspaceEngineRegistry>) {
    const entry = workspaceEngineRegistry[engine];
    for (const field of ["Component", "Toolbox", "Tabs", "StatusFields", "flush"] as const) assert.equal(typeof entry[field], "function");
  }
});

test("each engine retains distinct component, toolbox, tabs, status and flush references", () => {
  const entries = Object.values(workspaceEngineRegistry);
  for (const field of ["Component", "Toolbox", "Tabs", "StatusFields", "flush"] as const) assert.equal(new Set(entries.map(entry => entry[field])).size, entries.length);
});

test("an independent synthetic registry entry does not mutate the production registry", () => {
  const before = { ...workspaceEngineRegistry };
  const syntheticEntry: WorkspaceEngineRegistryEntry = {
    Component: () => null, Toolbox: () => null, Tabs: () => null, StatusFields: () => null,
    flush: async () => ({ ok: false, reason: "SYNTHETIC" }),
  };
  const withSynthetic: Record<string, WorkspaceEngineRegistryEntry> = { ...before, SYNTHETIC: syntheticEntry };
  assert.equal(withSynthetic.SYNTHETIC, syntheticEntry);
  for (const engine of Object.keys(before) as Array<keyof typeof before>) assert.equal(withSynthetic[engine], before[engine]);
  delete withSynthetic.SYNTHETIC;
  assert.deepEqual(withSynthetic, before);
  assert.deepEqual(workspaceEngineRegistry, before);
});

test("repeated Dataset IMAGE registry lookup retains its component identity", () => {
  const first = workspaceEngineRegistry.IMAGE;
  assert.equal(first, workspaceEngineRegistry.IMAGE);
  assert.equal(first.Component, workspaceEngineRegistry.IMAGE.Component);
});

test("each resolved Dataset mounts its deterministic engine shell without an Asset", () => {
  for (const modality of ["IMAGE", "VIDEO", "AUDIO", "TEXT"] as const) {
    const dataset: WorkspaceDataset = { id: "empty-dataset", name: "Empty", modality, modalityResolution: "RESOLVED", canResolve: false };
    const html = render(createElement(WorkspaceEngine, { dataset, selection: null }));
    assert.ok(html.includes(`data-workspace-engine="${modality}"`));
    assert.ok(html.includes("selected"));
    assert.ok(!html.includes("data-workspace-unresolved"));
    assert.ok(!html.includes("<video"));
    assert.ok(!html.includes("<audio"));
  }
});

test("a mismatched selected Asset never chooses an alternative engine", () => {
  const dataset: WorkspaceDataset = { id: "image-dataset", name: "Image", modality: "IMAGE", modalityResolution: "RESOLVED", canResolve: false };
  const selection = { engine: "VIDEO", asset: { id: "video-asset", modality: "VIDEO" } } as WorkspaceSelection;
  const html = render(createElement(WorkspaceEngine, { dataset, selection }));
  assert.ok(html.includes("Selected asset is incompatible"));
  assert.ok(!html.includes("data-workspace-engine"));
});

test("all unresolved historical states render without an engine or default modality", () => {
  for (const modalityResolution of ["EMPTY_UNRESOLVED", "MIXED_UNRESOLVED", "SINGLE_UNRESOLVED"] as const) {
    const dataset: WorkspaceDataset = { id: "historical", name: "Historical", modality: null, modalityResolution, canResolve: true };
    const html = render(createElement(WorkspaceEngine, { dataset, selection: null }));
    assert.ok(html.includes(`data-workspace-unresolved="${modalityResolution}"`));
    assert.ok(!html.includes("data-workspace-engine"));
    assert.equal(html.includes("Resolve empty dataset modality"), modalityResolution === "EMPTY_UNRESOLVED");
    if (modalityResolution === "EMPTY_UNRESOLVED") {
      assert.ok(html.includes('value="" selected=""'));
      assert.ok(html.includes("modality is permanent"));
    }
  }
});

test("the Dataset engine boundary remains stable across Assets and resets across Dataset IDs", () => {
  const dataset: WorkspaceDataset = { id: "image-dataset", name: "Image", modality: "IMAGE", modalityResolution: "RESOLVED", canResolve: false };
  const firstSelection = { engine: "IMAGE", asset: { id: "image-a", modality: "IMAGE" } } as WorkspaceSelection;
  const nextSelection = { engine: "IMAGE", asset: { id: "image-b", modality: "IMAGE" } } as WorkspaceSelection;
  // Element type/key encode React reconciliation. Existing content keys still
  // reset player/canvas resources; this is not a DOM mount-effect trace.
  const first = WorkspaceEngine({ dataset, selection: firstSelection });
  const next = WorkspaceEngine({ dataset, selection: nextSelection });
  const other = WorkspaceEngine({ dataset: { ...dataset, id: "another-dataset" }, selection: nextSelection });
  assert.equal(first.type, next.type);
  assert.equal(first.key, next.key);
  assert.equal(first.props.children.type, next.props.children.type);
  assert.notEqual(first.key, other.key);
});

test("loading, failure and unavailable Dataset boundaries mount no engine", () => {
  const surfaces = [createElement(WorkspaceLoading), createElement(WorkspaceError, { reset: () => undefined }), createElement(WorkspaceNotFound)];
  for (const surface of surfaces) {
    const html = render(surface);
    assert.ok(!html.includes("data-workspace-engine"));
    assert.ok(!html.includes("<video"));
    assert.ok(!html.includes("<audio"));
    assert.ok(!html.includes("<canvas"));
  }
});

test("an ineligible actor receives no EMPTY resolution form", () => {
  const dataset: WorkspaceDataset = { id: "empty", name: "Empty", modality: null, modalityResolution: "EMPTY_UNRESOLVED", canResolve: false };
  const html = render(createElement(WorkspaceEngine, { dataset, selection: null }));
  assert.ok(!html.includes("<form"));
  assert.ok(!html.includes("<select"));
});
