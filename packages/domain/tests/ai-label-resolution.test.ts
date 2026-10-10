import assert from "node:assert/strict";
import test from "node:test";

import { AiLabelClassInvalidError, aiLabelColor, canonicalAiLabelKey, resolveAiClassLabels, type AiLabelStore } from "../src/ai-label-resolution.ts";

type Row = { id: string; datasetId: string; normalizedName: string; name: string; modality: string | null; scope: string; color: string };

/** In-memory store with the real unique key (datasetId, normalizedName), INSERT .. ON CONFLICT DO NOTHING semantics, and an optional racing creator. */
function fakeStore(seed: Partial<Row>[] = [], race?: (rows: Row[]) => void) {
  const rows: Row[] = seed.map((row, index) => ({ id: `seed-${index}`, datasetId: "ds", name: row.normalizedName!, scope: "OBJECT", color: "#000000", modality: "VIDEO", ...row, normalizedName: row.normalizedName! }));
  let createCalls = 0;
  const store: AiLabelStore = {
    label: {
      async findMany({ where }) { return rows.filter((row) => row.datasetId === where.datasetId && where.normalizedName.in.includes(row.normalizedName)).map(({ id, normalizedName, modality, scope }) => ({ id, normalizedName, modality, scope })); },
      async createMany({ data }) {
        createCalls++; race?.(rows);
        let count = 0;
        for (const item of data) {
          if (rows.some((row) => row.datasetId === item.datasetId && row.normalizedName === item.normalizedName)) continue;
          rows.push({ id: `new-${rows.length}`, scope: "OBJECT", ...item }); count++;
        }
        return { count };
      },
    },
  };
  return { store, rows, calls: () => createCalls };
}

test("canonical key: trim + en-US lowercase only; `unknown` is the explicit no-class value; malformed values are rejected", () => {
  assert.deepEqual(canonicalAiLabelKey("  Sports Ball "), { key: "sports ball", display: "Sports Ball" });
  assert.equal(canonicalAiLabelKey("UNKNOWN"), null);
  assert.notEqual(canonicalAiLabelKey("traffic light")!.key, canonicalAiLabelKey("traffic-light")!.key, "no fuzzy or alias merging");
  assert.notEqual(canonicalAiLabelKey("person")!.key, canonicalAiLabelKey("persons")!.key);
  for (const [value, reason] of [["", "BLANK"], ["   ", "BLANK"], ["x".repeat(257), "TOO_LONG"], ["bad\u0000name", "CONTROL_CHARACTER"], ["a\nb", "CONTROL_CHARACTER"]] as const) {
    assert.throws(() => canonicalAiLabelKey(value), (error: unknown) => error instanceof AiLabelClassInvalidError && error.reason === reason);
  }
});

test("A: a class that matches a compatible existing label reuses it and changes nothing", async () => {
  const { store, rows } = fakeStore([{ normalizedName: "person", name: "Person (custom)", color: "#123456", modality: "VIDEO" }]);
  const result = await resolveAiClassLabels(store, "ds", "VIDEO", ["Person"]);
  assert.equal(result.labelIds.get("person"), "seed-0");
  assert.deepEqual([result.created, result.conflicts], [[], []]);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.name, "Person (custom)"); assert.equal(rows[0]!.color, "#123456");
});

test("a shared (modality null) OBJECT label is compatible with both modalities", async () => {
  const { store } = fakeStore([{ normalizedName: "dog", modality: null }]);
  assert.equal((await resolveAiClassLabels(store, "ds", "VIDEO", ["dog"])).labelIds.get("dog"), "seed-0");
  assert.equal((await resolveAiClassLabels(store, "ds", "IMAGE", ["dog"])).labelIds.get("dog"), "seed-0");
});

test("B + D + G: missing classes create exactly one Dataset-scoped label each, with the Dataset modality and a deterministic colour", async () => {
  const { store, rows } = fakeStore([{ normalizedName: "person" }]);
  const classes = ["person", "Motorcycle", "motorcycle", "MOTORCYCLE", "sports ball", "tennis racket", "unknown"];
  const result = await resolveAiClassLabels(store, "ds", "VIDEO", classes);
  assert.deepEqual([...result.labelIds.keys()].sort(), ["motorcycle", "person", "sports ball", "tennis racket"]);
  assert.deepEqual([...result.created].sort(), ["motorcycle", "sports ball", "tennis racket"]);
  assert.equal(rows.filter((row) => row.normalizedName === "motorcycle").length, 1, "three tracks of one class -> one label");
  const motorcycle = rows.find((row) => row.normalizedName === "motorcycle")!;
  assert.deepEqual([motorcycle.modality, motorcycle.name, motorcycle.color], ["VIDEO", "Motorcycle", aiLabelColor("motorcycle")]);
  assert.equal(result.labelIds.has("unknown"), false);
});

test("E: repeating the same resolution is idempotent (no new labels, same ids)", async () => {
  const { store, rows } = fakeStore();
  const first = await resolveAiClassLabels(store, "ds", "IMAGE", ["cat", "dog"]);
  const second = await resolveAiClassLabels(store, "ds", "IMAGE", ["dog", "cat"]);
  assert.equal(rows.length, 2);
  assert.deepEqual([...second.created], []);
  assert.deepEqual([...second.labelIds.entries()].sort(), [...first.labelIds.entries()].sort());
});

test("concurrent tasks: a label created by a racing task between read and create is reused, never duplicated", async () => {
  const { store, rows } = fakeStore([], (current) => { current.push({ id: "racer", datasetId: "ds", normalizedName: "bicycle", name: "bicycle", modality: "VIDEO", scope: "OBJECT", color: "#111111" }); });
  const result = await resolveAiClassLabels(store, "ds", "VIDEO", ["bicycle", "dog"]);
  assert.equal(result.labelIds.get("bicycle"), "racer");
  assert.equal(rows.filter((row) => row.normalizedName === "bicycle").length, 1);
  assert.ok(result.labelIds.get("dog"));
});

test("J: an incompatible same-key label (IMAGE-only in a VIDEO dataset, or a non-OBJECT scope) is reported as a conflict, never reused or modified", async () => {
  const { store, rows } = fakeStore([{ normalizedName: "car", modality: "IMAGE", name: "Car", color: "#abcdef" }, { normalizedName: "sky", modality: "VIDEO", scope: "CLASSIFICATION" }]);
  const result = await resolveAiClassLabels(store, "ds", "VIDEO", ["car", "sky", "tree"]);
  assert.equal(result.labelIds.has("car"), false);
  assert.equal(result.labelIds.has("sky"), false);
  assert.deepEqual(result.conflicts.map((c) => [c.classKey, c.reason]).sort(), [["car", "INCOMPATIBLE_MODALITY"], ["sky", "INCOMPATIBLE_SCOPE"]]);
  assert.ok(result.labelIds.get("tree"));
  assert.deepEqual([rows[0]!.modality, rows[0]!.color, rows[0]!.name], ["IMAGE", "#abcdef", "Car"]);
  assert.equal(rows.filter((row) => row.normalizedName === "car").length, 1);
});

test("J: one malformed class rejects the whole result before any write", async () => {
  const { store, calls } = fakeStore();
  await assert.rejects(resolveAiClassLabels(store, "ds", "VIDEO", ["person", "   "]), AiLabelClassInvalidError);
  assert.equal(calls(), 0);
});

test("datasets are isolated: the same class in another dataset never resolves to this dataset's label", async () => {
  const { store } = fakeStore([{ normalizedName: "person", datasetId: "other" }]);
  const result = await resolveAiClassLabels(store, "ds", "VIDEO", ["person"]);
  assert.notEqual(result.labelIds.get("person"), "seed-0");
  assert.deepEqual([...result.created], ["person"]);
});
