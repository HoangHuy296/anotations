import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { useDatasetLabelsStore, type DatasetLabel } from "@/stores/dataset-labels-store";

function uniqueDatasetId() {
  return `ds-${randomBytes(6).toString("hex")}`;
}

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => { globalThis.fetch = original; });
}

function labelsResponse(items: DatasetLabel[]) {
  return new Response(JSON.stringify({ data: { items } }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("ensureLoaded -- two concurrent callers for the same dataset share one fetch", async () => {
  const datasetId = uniqueDatasetId();
  let fetchCount = 0;
  await withFetch(async () => { fetchCount += 1; return labelsResponse([{ id: "l1", name: "Cat", color: "#000", modality: null }]); }, async () => {
    // Mirrors React 18 Strict Mode's mount -> cleanup -> mount, which calls
    // `ensureLoaded` twice back-to-back before either fetch resolves.
    await Promise.all([useDatasetLabelsStore.getState().ensureLoaded(datasetId), useDatasetLabelsStore.getState().ensureLoaded(datasetId)]);
  });
  assert.equal(fetchCount, 1, "concurrent callers must coalesce into a single fetch");
  assert.deepEqual(useDatasetLabelsStore.getState().entries[datasetId]?.labels, [{ id: "l1", name: "Cat", color: "#000", modality: null }]);
});

test("ensureLoaded -- a later call for an already-loaded dataset never re-fetches (the bug this store fixes)", async () => {
  const datasetId = uniqueDatasetId();
  let fetchCount = 0;
  await withFetch(async () => { fetchCount += 1; return labelsResponse([{ id: "l1", name: "Cat", color: "#000", modality: null }]); }, () => useDatasetLabelsStore.getState().ensureLoaded(datasetId));
  assert.equal(fetchCount, 1);

  // This simulates switching Image -> Video -> Image: each switch remounts
  // the properties-tab component (a fresh mount effect, well after the
  // first fetch settled), but the store itself is a module-level singleton
  // that remembers "loaded" across those remounts.
  await withFetch(async () => { fetchCount += 1; return labelsResponse([]); }, () => useDatasetLabelsStore.getState().ensureLoaded(datasetId));
  assert.equal(fetchCount, 1, "a call after the first fetch already completed must not re-fetch");
});

test("ensureLoaded -- a different dataset always fetches its own labels", async () => {
  const datasetA = uniqueDatasetId();
  const datasetB = uniqueDatasetId();
  let fetchCount = 0;
  await withFetch(async () => { fetchCount += 1; return labelsResponse([{ id: "a1", name: "A", color: "#111", modality: null }]); }, () => useDatasetLabelsStore.getState().ensureLoaded(datasetA));
  await withFetch(async () => { fetchCount += 1; return labelsResponse([{ id: "b1", name: "B", color: "#222", modality: null }]); }, () => useDatasetLabelsStore.getState().ensureLoaded(datasetB));
  assert.equal(fetchCount, 2, "a fresh dataset must still fetch its own labels once");
  assert.equal(useDatasetLabelsStore.getState().entries[datasetA]?.labels[0]?.id, "a1");
  assert.equal(useDatasetLabelsStore.getState().entries[datasetB]?.labels[0]?.id, "b1");
});

test("ensureLoaded -- a seed paints the entry immediately but does not skip the fetch", async () => {
  const datasetId = uniqueDatasetId();
  const seed: DatasetLabel[] = [{ id: "seed1", name: "Seeded", color: "#333", modality: "IMAGE" }];
  let resolveFetch!: (response: Response) => void;
  let fetchCount = 0;
  const pending = withFetch(async () => {
    fetchCount += 1;
    return new Promise<Response>((resolve) => { resolveFetch = resolve; });
  }, () => useDatasetLabelsStore.getState().ensureLoaded(datasetId, seed));

  // Before the fetch resolves, the entry is already painted with the seed.
  await Promise.resolve();
  assert.deepEqual(useDatasetLabelsStore.getState().entries[datasetId]?.labels, seed);
  assert.equal(useDatasetLabelsStore.getState().entries[datasetId]?.status, "loading");

  resolveFetch(labelsResponse([{ id: "fresh1", name: "Fresh", color: "#444", modality: null }]));
  await pending;
  assert.equal(fetchCount, 1, "seeding must not skip the network fetch");
  assert.deepEqual(useDatasetLabelsStore.getState().entries[datasetId]?.labels, [{ id: "fresh1", name: "Fresh", color: "#444", modality: null }]);
});

test("addLabel/removeLabel -- update the shared entry without any network call", async () => {
  const datasetId = uniqueDatasetId();
  await withFetch(async () => labelsResponse([]), () => useDatasetLabelsStore.getState().ensureLoaded(datasetId));

  useDatasetLabelsStore.getState().addLabel(datasetId, { id: "l1", name: "Zebra", color: "#000", modality: null });
  useDatasetLabelsStore.getState().addLabel(datasetId, { id: "l2", name: "Ant", color: "#fff", modality: null });
  assert.deepEqual(useDatasetLabelsStore.getState().entries[datasetId]?.labels.map((l) => l.id), ["l2", "l1"], "labels stay name-sorted");

  useDatasetLabelsStore.getState().removeLabel(datasetId, "l1");
  assert.deepEqual(useDatasetLabelsStore.getState().entries[datasetId]?.labels.map((l) => l.id), ["l2"]);
});

test("invalidate -- forces the next ensureLoaded call to hit the network again", async () => {
  const datasetId = uniqueDatasetId();
  let fetchCount = 0;
  await withFetch(async () => { fetchCount += 1; return labelsResponse([{ id: "l1", name: "One", color: "#000", modality: null }]); }, () => useDatasetLabelsStore.getState().ensureLoaded(datasetId));
  assert.equal(fetchCount, 1);

  useDatasetLabelsStore.getState().invalidate(datasetId);
  await withFetch(async () => { fetchCount += 1; return labelsResponse([{ id: "l2", name: "Two", color: "#111", modality: null }]); }, () => useDatasetLabelsStore.getState().ensureLoaded(datasetId));
  assert.equal(fetchCount, 2, "an invalidated dataset must refetch on the next ensureLoaded call");
  assert.equal(useDatasetLabelsStore.getState().entries[datasetId]?.labels[0]?.id, "l2");
});
