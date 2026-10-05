import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { projectAnnotation } from "@/lib/visualization/annotation-adapter";
import { boxPixels } from "@/lib/visualization/geometry";
import { visualizationAssetsQuerySchema } from "@/lib/validation/visualization";
import { visualizationFetch, VisualizationClientError, handleVisualizationAccessError } from "@/lib/visualization/read-client";

const row = { id: "annotation", type: "BOUNDING_BOX", revision: 4, geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, label: { id: "label", name: "Car", color: "#12abef" } };
test("normalized geometry, stable annotation/label IDs and colors survive projection without mutation", () => {
  const result = projectAnnotation(row, 1000, 500);
  assert.equal(result.id, row.id); assert.deepEqual(result.label, row.label);
  assert.deepEqual(result.geometry, row.geometry);
  assert.deepEqual(boxPixels(result.geometry!, 1000, 500), { x: 100, y: 100, width: 300, height: 200 });
  assert.deepEqual(boxPixels(result.geometry!, 200, 100), { x: 20, y: 20, width: 60, height: 40 });
  assert.deepEqual(row.geometry, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
});
test("missing/invalid geometry and dimensions never guess overlays", () => {
  for (const geometry of [null, {}, { x: 10, y: 20, width: 30, height: 40 }, { x: 0.9, y: 0, width: 0.5, height: 0.1 }]) {
    const result = projectAnnotation({ ...row, geometry }, 100, 100);
    assert.equal(result.geometry, null); assert.ok(result.overlayUnavailable);
  }
  for (const width of [null, 0, -1]) assert.equal(projectAnnotation(row, width, 100).geometry, null);
  assert.equal(projectAnnotation({ ...row, type: "POLYGON" }, 100, 100).geometry, null);
});
test("query input is bounded and allowlisted", () => {
  for (const query of [{ page: 0 }, { pageSize: 51 }, { sort: "storageKey" }, { modality: "MIXED" }, { page: ["1", "2"] }, { labelId: "invalid" }, { q: "x".repeat(101) }, { extra: true }]) assert.equal(visualizationAssetsQuerySchema.safeParse(query).success, false);
  assert.equal(visualizationAssetsQuerySchema.parse({ page: "2", pageSize: "5" }).page, 2);
});
test("all normal viewer requests use GET/no-store and reopening returns a typed failure", async (t) => {
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { calls.push(init); return Response.json({ data: {} }); });
  for (const suffix of ["", "/assets?page=2", "/assets/id", "/assets/id/media", "/insights", "/schema", "/activity", "/versions", "/derived", "/versions/vs_id", "/artifacts/va_id"]) await visualizationFetch(`/api/datasets/id/visualization${suffix}`);
  for (const call of calls) { assert.equal(call.method, "GET"); assert.equal(call.cache, "no-store"); assert.equal(call.body, undefined); }
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "DATASET_NOT_COMPLETED" } }, { status: 409 }));
  await assert.rejects(visualizationFetch("/api/datasets/id/visualization"), error => error instanceof VisualizationClientError && error.status === 409 && error.code === "DATASET_NOT_COMPLETED");
});

test("reopening clears existing viewer data before replacing navigation", () => {
  const steps: string[] = [];
  assert.equal(handleVisualizationAccessError(new VisualizationClientError(409, "DATASET_NOT_COMPLETED"), "dataset", () => steps.push("clear"), path => steps.push(path)), true);
  assert.deepEqual(steps, ["clear", "/workspace/dataset"]);
  assert.equal(handleVisualizationAccessError(new VisualizationClientError(409, "ASSET_UNAVAILABLE"), "dataset", () => steps.push("unexpected"), () => {}), false);
});
