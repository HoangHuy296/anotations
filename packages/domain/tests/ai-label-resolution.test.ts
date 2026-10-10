import assert from "node:assert/strict";
import test from "node:test";

import { AiLabelClassInvalidError, canonicalAiLabelKey, isAiLabelCompatible, matchAiClassLabels, usableAiClass, type AiLabelReader } from "../src/ai-label-resolution.ts";

type Row = { id: string; datasetId: string; normalizedName: string; modality: string | null; scope: string };

/** A reader-only store: it has no create method at all, so any attempt to create a Label would throw. */
function store(seed: Array<Partial<Row> & { normalizedName: string }> = []) {
  const rows: Row[] = seed.map((row, index) => ({ id: `seed-${index}`, datasetId: "ds", modality: "VIDEO", scope: "OBJECT", ...row }));
  let reads = 0;
  const reader: AiLabelReader = { label: { async findMany({ where }) { reads++; return rows.filter((row) => row.datasetId === where.datasetId && where.normalizedName.in.includes(row.normalizedName)); } } };
  return { reader, rows, reads: () => reads };
}

test("canonical key: trim + en-US lowercase only; `unknown` is the explicit no-class value; malformed values are rejected; no fuzzy merging", () => {
  assert.deepEqual(canonicalAiLabelKey("  Sports Ball "), { key: "sports ball", display: "Sports Ball" });
  assert.equal(canonicalAiLabelKey("UNKNOWN"), null);
  assert.notEqual(canonicalAiLabelKey("traffic light")!.key, canonicalAiLabelKey("traffic-light")!.key);
  assert.notEqual(canonicalAiLabelKey("person")!.key, canonicalAiLabelKey("persons")!.key);
  for (const [value, reason] of [["", "BLANK"], ["   ", "BLANK"], ["x".repeat(257), "TOO_LONG"], ["bad\u0000name", "CONTROL_CHARACTER"], ["a\nb", "CONTROL_CHARACTER"]] as const) {
    assert.throws(() => canonicalAiLabelKey(value), (error: unknown) => error instanceof AiLabelClassInvalidError && error.reason === reason);
  }
});

test("usableAiClass never throws: a displayable class or null", () => {
  assert.deepEqual(usableAiClass(" sports ball "), { key: "sports ball", display: "sports ball" });
  for (const value of [undefined, null, 7, {}, "", "  ", "unknown", "Unknown", "a\u0000b", "x".repeat(300)]) assert.equal(usableAiClass(value), null);
});

test("D: a class matching a compatible existing label links to it; reuse is read-only (the label row is unchanged)", async () => {
  const { reader, rows } = store([{ normalizedName: "person" }]);
  const before = JSON.stringify(rows);
  const match = await matchAiClassLabels(reader, "ds", "VIDEO", ["Person"]);
  assert.equal(match.labelIds.get("person"), "seed-0");
  assert.deepEqual(match.conflicts, []);
  assert.equal(JSON.stringify(rows), before);
});

test("B/C/G: classes with no Label row simply do not match - nothing is created (the store has no create path)", async () => {
  const { reader, rows } = store([{ normalizedName: "person" }]);
  const match = await matchAiClassLabels(reader, "ds", "VIDEO", ["person", "motorcycle", "sports ball", "tennis racket", "unknown"]);
  assert.deepEqual([...match.labelIds.keys()], ["person"]);
  assert.equal(rows.length, 1, "Label rows do not increase because AI detected new classes");
});

test("a shared (modality null) OBJECT label is compatible with both modalities; other modality or scope is not", () => {
  assert.equal(isAiLabelCompatible({ modality: null, scope: "OBJECT" }, "VIDEO"), true);
  assert.equal(isAiLabelCompatible({ modality: null, scope: "OBJECT" }, "IMAGE"), true);
  assert.equal(isAiLabelCompatible({ modality: "VIDEO", scope: "OBJECT" }, "VIDEO"), true);
  assert.equal(isAiLabelCompatible({ modality: "IMAGE", scope: "OBJECT" }, "VIDEO"), false);
  assert.equal(isAiLabelCompatible({ modality: "VIDEO", scope: "CLASSIFICATION" }, "VIDEO"), false);
});

test("an incompatible same-key label (IMAGE-only in a VIDEO dataset, or non-OBJECT scope) is a reported conflict and is never matched or modified", async () => {
  const { reader, rows } = store([{ normalizedName: "car", modality: "IMAGE" }, { normalizedName: "sky", scope: "CLASSIFICATION" }]);
  const before = JSON.stringify(rows);
  const match = await matchAiClassLabels(reader, "ds", "VIDEO", ["car", "sky", "tree"]);
  assert.equal(match.labelIds.size, 0);
  assert.deepEqual(match.conflicts.map((c) => [c.classKey, c.reason]).sort(), [["car", "INCOMPATIBLE_MODALITY"], ["sky", "INCOMPATIBLE_SCOPE"]]);
  assert.equal(JSON.stringify(rows), before);
});

test("one malformed class rejects the whole result before any read", async () => {
  const { reader, reads } = store();
  await assert.rejects(matchAiClassLabels(reader, "ds", "VIDEO", ["person", "   "]), AiLabelClassInvalidError);
  assert.equal(reads(), 0);
});

test("datasets are isolated: the same class in another dataset never matches", async () => {
  const { reader } = store([{ normalizedName: "person", datasetId: "other" }]);
  assert.equal((await matchAiClassLabels(reader, "ds", "VIDEO", ["person"])).labelIds.size, 0);
});
