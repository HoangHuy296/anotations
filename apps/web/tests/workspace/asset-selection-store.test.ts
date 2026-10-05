import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { useAssetSelectionStore } from "@/stores/asset-selection-store";

const DATASET = "ds-1";

function reset() { useAssetSelectionStore.setState({ datasetId: null, mode: "NONE", explicitIds: new Set(), filteredQuery: null, filteredCount: 0 }); }

/** T025 (022): directly proves FR-013's three selection-reconciliation rules, and basic selection lifecycle, at the store level. */

test("toggle builds an explicit selection and reports the right count", () => {
  reset();
  const store = useAssetSelectionStore.getState();
  store.toggle(DATASET, "a1");
  store.toggle(DATASET, "a2");
  assert.equal(useAssetSelectionStore.getState().mode, "EXPLICIT");
  assert.equal(useAssetSelectionStore.getState().selectedCount(), 2);
  store.toggle(DATASET, "a1"); // toggling off
  assert.equal(useAssetSelectionStore.getState().selectedCount(), 1);
});

test("selectAllFiltered enters FILTERED mode and reports the matched count, not a downloaded list", () => {
  reset();
  useAssetSelectionStore.getState().selectAllFiltered(DATASET, { q: "cat" }, 2438);
  const state = useAssetSelectionStore.getState();
  assert.equal(state.mode, "FILTERED");
  assert.equal(state.selectedCount(), 2438);
  assert.deepEqual(state.explicitIds, new Set(), "FILTERED mode never carries an id list");
});

test("clear resets to no selection regardless of prior mode", () => {
  reset();
  useAssetSelectionStore.getState().selectAllFiltered(DATASET, { q: "cat" }, 10);
  useAssetSelectionStore.getState().clear();
  assert.equal(useAssetSelectionStore.getState().mode, "NONE");
  assert.equal(useAssetSelectionStore.getState().selectedCount(), 0);
});

test("FR-013 rule 1 (sort-only change): sort/order are never part of AssetListQuery, so nothing to reconcile -- membership is untouched by construction", () => {
  reset();
  useAssetSelectionStore.getState().selectAllFiltered(DATASET, { q: "cat", status: ["NEEDS_REVIEW"] }, 50);
  const before = useAssetSelectionStore.getState();
  // Reconciling with the *same* search/filter query (only sort changed
  // elsewhere in the URL, which never reaches this store) must be a no-op
  // beyond a possibly-refreshed count.
  useAssetSelectionStore.getState().reconcile(DATASET, { q: "cat", status: ["NEEDS_REVIEW"] }, 50);
  const after = useAssetSelectionStore.getState();
  assert.equal(after.mode, before.mode);
  assert.deepEqual(after.filteredQuery, before.filteredQuery);
  assert.equal(after.selectedCount(), 50);
});

test("FR-013 rule 2 (FILTERED reconciliation): a filter change re-represents the new query and updates the count", () => {
  reset();
  useAssetSelectionStore.getState().selectAllFiltered(DATASET, { q: "cat" }, 2438);
  useAssetSelectionStore.getState().reconcile(DATASET, { q: "dog" }, 12);
  const state = useAssetSelectionStore.getState();
  assert.equal(state.mode, "FILTERED", "still a filtered selection -- reconciliation is not data loss");
  assert.deepEqual(state.filteredQuery, { q: "dog" });
  assert.equal(state.selectedCount(), 12, "the displayed count updates to the new query's match count");
});

test("FR-013 rule 3 (EXPLICIT untouched): a filter change never alters an explicit selection, even for now-hidden assets", () => {
  reset();
  const store = useAssetSelectionStore.getState();
  store.toggle(DATASET, "a1");
  store.toggle(DATASET, "a2");
  store.reconcile(DATASET, { q: "a-brand-new-filter-that-hides-both" }, 0);
  const state = useAssetSelectionStore.getState();
  assert.equal(state.mode, "EXPLICIT");
  assert.deepEqual(state.explicitIds, new Set(["a1", "a2"]), "explicitly selected assets remain selected even when hidden by a new filter");
  assert.equal(state.selectedCount(), 2);
});

test("selection is independent of pagination: selectVisible across two 'pages' accumulates rather than replacing", () => {
  reset();
  const store = useAssetSelectionStore.getState();
  store.selectVisible(DATASET, ["p1a", "p1b"]);
  store.selectVisible(DATASET, ["p2a", "p2b"]);
  assert.deepEqual(useAssetSelectionStore.getState().explicitIds, new Set(["p1a", "p1b", "p2a", "p2b"]));
});

test("switching to a different dataset starts a fresh selection rather than mixing across datasets", () => {
  reset();
  useAssetSelectionStore.getState().toggle(DATASET, "a1");
  useAssetSelectionStore.getState().toggle("ds-2", "b1");
  const state = useAssetSelectionStore.getState();
  assert.equal(state.datasetId, "ds-2");
  assert.deepEqual(state.explicitIds, new Set(["b1"]), "the previous dataset's selection is not carried into the new one");
});
