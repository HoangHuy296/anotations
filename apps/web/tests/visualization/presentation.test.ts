import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { visualizationQuerySchema, visualizationTabHref } from "@/lib/validation/visualization";
import { visualizationTabs } from "@/types/visualization";

const dataset = { id: "00000000-0000-4000-8000-000000000001", name: "Actual <dataset>" };

test("Data is the default and malformed/repeated tabs fall back to Data", () => {
  for (const tab of [undefined, null, "", "DATA", "unknown", ["insights", "schema"], {}, 42]) {
    assert.equal(visualizationQuerySchema.parse({ tab }).tab, "data");
  }
  assert.deepEqual(visualizationQuerySchema.parse({}), { tab: "data" });
});

test("all five sections have round-trippable same-dataset URLs", () => {
  assert.deepEqual(visualizationTabs, ["data", "insights", "schema", "versions", "activity"]);
  for (const tab of visualizationTabs) {
    assert.equal(visualizationQuerySchema.parse({ tab }).tab, tab);
    const url = new URL(visualizationTabHref(dataset.id, tab), "http://localhost:3000");
    assert.equal(url.pathname, `/datasets/visualize/${dataset.id}`);
    assert.equal(url.searchParams.get("tab"), tab);
    assert.equal(visualizationQuerySchema.parse(Object.fromEntries(url.searchParams)).tab, tab);
  }
  assert.throws(() => visualizationTabHref("../other", "data"));
});

