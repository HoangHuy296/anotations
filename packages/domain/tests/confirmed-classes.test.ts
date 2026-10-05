import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_CONFIRMED_CLASSES, analyzeConfirmedClasses, assignClassColors, buildConfirmedLabelRows, folderTaxonomyCanonical, normalizeClassName, repositoryTaxonomyIdentity,
} from "../src/confirmed-classes.js";

const webFile = (path: string) => readFileSync(new URL(`../../../apps/web/${path}`, import.meta.url), "utf8");
const ORIGINAL_PALETTE = [
  "#0EA5E9", "#2563EB", "#4F46E5", "#7C3AED", "#9333EA", "#C026D3", "#DB2777", "#E11D48", "#EA580C", "#F97316", "#CA8A04", "#EAB308",
  "#65A30D", "#16A34A", "#059669", "#0F766E", "#0891B2", "#475569", "#334155", "#78350F", "#BE123C", "#A21CAF", "#1D4ED8", "#047857",
];
const palette = [...webFile("src/lib/labels/label-color-presets.ts").matchAll(/"(#[0-9A-F]{6})"/g)].map((match) => match[1]!);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const names = (count: number) => Array.from({ length: count }, (_, index) => `Class ${String(index).padStart(3, "0")}`);
const slot = (name: string) => { let hash = 0; for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0; return hash % 24; };

test("the shared palette is the original 24 uppercase presets, unchanged and in order; the picker no longer owns a private copy", () => {
  assert.deepEqual(palette, ORIGINAL_PALETTE);
  assert.equal(new Set(palette).size, 24);
  assert.ok(palette.every((color) => /^#[0-9A-F]{6}$/.test(color)));
  const form = webFile("src/components/labels/label-form.tsx");
  assert.match(form, /import \{ LABEL_COLOR_PRESETS as LABEL_COLORS \} from "@\/lib\/labels\/label-color-presets";/);
  assert.ok(!/const LABEL_COLORS\s*=/.test(form) && !form.includes('"#0EA5E9", "#2563EB"'), "the literal list moved out of label-form.tsx");
  assert.ok(form.includes("LABEL_COLORS.map("), "the picker still renders every preset");
});

test("normalization is trim + en-US lowercase only: no Unicode normalization and no collapsing of inner whitespace", () => {
  assert.equal(normalizeClassName("  Car "), "car");
  assert.equal(normalizeClassName("TRAFFIC  Sign"), "traffic  sign");
  assert.notEqual(normalizeClassName("é"), normalizeClassName("é"), "NFC/NFD forms stay distinct");
  assert.notEqual(normalizeClassName("ﬁ"), "fi", "no compatibility folding");
  assert.equal(normalizeClassName("İ"), "i̇");
});

test("class-list boundaries: absent, [], 1, 24, 25, 100 are valid; 101 is rejected as a whole", () => {
  for (const input of [undefined, []]) { const result = analyzeConfirmedClasses(input); assert.equal(result.ok, true); if (result.ok) { assert.deepEqual(result.classes, []); assert.deepEqual(result.sortedNormalized, []); } }
  for (const count of [1, 24, 25, 100]) { const result = analyzeConfirmedClasses(names(count)); assert.equal(result.ok, true, String(count)); if (result.ok) { assert.equal(result.classes.length, count); assert.equal(result.sortedNormalized.length, count); } }
  assert.equal(MAX_CONFIRMED_CLASSES, 100);
  assert.deepEqual(analyzeConfirmedClasses(names(101)), { ok: false, issue: "TOO_MANY" });
  assert.deepEqual(analyzeConfirmedClasses(names(1000)), { ok: false, issue: "TOO_MANY" });
});

test("duplicates are detected on the normalized name and reject the whole list", () => {
  for (const list of [["Car", "car"], ["Car", " CAR "], ["Car", "Bus", "bus"], ["a1", "A1"]]) assert.deepEqual(analyzeConfirmedClasses(list), { ok: false, issue: "DUPLICATE" }, JSON.stringify(list));
  assert.equal(analyzeConfirmedClasses(["Car", "Cars"]).ok, true);
  assert.equal(analyzeConfirmedClasses(["Car", "Ca r"]).ok, true, "inner whitespace is part of identity");
  // the caller-supplied normalizer is what decides identity (the web layer passes normalizeLabelName)
  assert.deepEqual(analyzeConfirmedClasses(["Ab", "Ac"], (name) => name.slice(0, 1)), { ok: false, issue: "DUPLICATE" });
});

test("identity is the sorted normalized set: order and casing are irrelevant, display keeps the first trimmed spelling in entry order", () => {
  const a = analyzeConfirmedClasses(["Car", " person ", "Traffic Sign"]);
  const b = analyzeConfirmedClasses(["traffic sign", "CAR", "Person"]);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(a.sortedNormalized, ["car", "person", "traffic sign"]);
  assert.deepEqual(a.sortedNormalized, b.sortedNormalized);
  assert.deepEqual(a.classes.map((entry) => entry.display), ["Car", "person", "Traffic Sign"]);
  assert.deepEqual(b.classes.map((entry) => entry.display), ["traffic sign", "CAR", "Person"]);
  const permutations = [["b1", "a1", "C1"], ["C1", "b1", "a1"], ["a1", "C1", "b1"]];
  const sorted = permutations.map((list) => { const r = analyzeConfirmedClasses(list); return r.ok ? r.sortedNormalized.join("|") : "bad"; });
  assert.equal(new Set(sorted).size, 1);
  assert.deepEqual(analyzeConfirmedClasses(["b", "B2", "a", "10", "9"].map((n) => `${n}x`)).ok && (analyzeConfirmedClasses(["bx", "B2x", "ax", "10x", "9x"]) as { sortedNormalized: string[] }).sortedNormalized, ["10x", "9x", "ax", "b2x", "bx"], "plain code-unit order, locale independent");
});

test("repository identity fragment exists only for a non-empty taxonomy; folder canonical form is versioned and null when empty", () => {
  assert.equal(repositoryTaxonomyIdentity([]), undefined);
  assert.deepEqual(repositoryTaxonomyIdentity(["car", "person"]), { v: 1, classes: ["car", "person"] });
  assert.equal(folderTaxonomyCanonical("IMAGE", []), null);
  const canonical = folderTaxonomyCanonical("IMAGE", ["car", "person", "traffic sign"]);
  assert.equal(canonical, '{"v":1,"kind":"local-folder-creation","modality":"IMAGE","taxonomy":["car","person","traffic sign"]}');
  assert.equal(sha(canonical!), "3738861fa6fe048ace7a091d87a423513e799ffa50ce6e42a88cbe81f654f8dd");
  assert.notEqual(folderTaxonomyCanonical("VIDEO", ["car"]), folderTaxonomyCanonical("IMAGE", ["car"]));
  assert.notEqual(folderTaxonomyCanonical("IMAGE", ["car"]), folderTaxonomyCanonical("IMAGE", ["car", "bus"]));
  const a = analyzeConfirmedClasses(["Car", " person ", "Traffic Sign"]), b = analyzeConfirmedClasses(["traffic sign", "CAR", "Person"]);
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.equal(folderTaxonomyCanonical("TEXT", a.sortedNormalized), folderTaxonomyCanonical("TEXT", b.sortedNormalized));
});

test("colors: deterministic, order independent, uppercase #RRGGBB from the palette, unique for the first 24, base-slot reuse afterwards, bounded", () => {
  const example = assignClassColors(["car", "person", "traffic sign"], palette);
  assert.deepEqual([...example], [["car", "#9333EA"], ["person", "#A21CAF"], ["traffic sign", "#EA580C"]]);
  assert.deepEqual([...assignClassColors(["car", "person", "traffic sign"], palette)], [...example], "repeatable");
  for (const count of [1, 5, 24]) {
    const sorted = [...names(count)].map(normalizeClassName).sort();
    const colors = [...assignClassColors(sorted, palette).values()];
    assert.equal(new Set(colors).size, count, `${count} classes get ${count} distinct colors`);
    assert.ok(colors.every((color) => palette.includes(color)));
  }
  // adversarial: many names that all hash to the same base slot still get 24 distinct colors, then reuse their base slot
  const collide: string[] = [];
  for (let n = 0; collide.length < 40; n += 1) { const candidate = `x${n}`; if (slot(candidate) === 7) collide.push(candidate); }
  const sorted = [...collide].sort();
  const colors = assignClassColors(sorted, palette);
  assert.equal(new Set(sorted.slice(0, 24).map((name) => colors.get(name))).size, 24, "the first 24 are unique even when every base slot collides");
  for (const name of sorted.slice(24)) assert.equal(colors.get(name), palette[7], "after the palette is full a class reuses its base slot");
  // 100 classes: terminates, every color valid, later classes reuse base slots
  const hundred = names(100).map(normalizeClassName).sort();
  const all = assignClassColors(hundred, palette);
  assert.equal(all.size, 100); assert.ok([...all.values()].every((color) => /^#[0-9A-F]{6}$/.test(color) && palette.includes(color)));
  for (const name of hundred.slice(24)) assert.equal(all.get(name), palette[slot(name)]);
  assert.throws(() => assignClassColors(["a"], []), /PALETTE_EMPTY/);
  // colors depend only on the sorted set, so request order cannot change them
  const one = analyzeConfirmedClasses(["Zed", "alpha", "Mid"]), two = analyzeConfirmedClasses(["mid", "ZED", "Alpha"]);
  assert.ok(one.ok && two.ok);
  if (one.ok && two.ok) assert.deepEqual([...assignClassColors(one.sortedNormalized, palette)], [...assignClassColors(two.sortedNormalized, palette)]);
});

test("label rows use the Dataset modality and OBJECT scope (no TEXT scope guessing), first trimmed spelling, entry order and derived colors", () => {
  for (const modality of ["IMAGE", "VIDEO", "AUDIO", "TEXT"] as const) {
    const analysis = analyzeConfirmedClasses([" Traffic Sign ", "car"]);
    assert.ok(analysis.ok);
    if (!analysis.ok) continue;
    const rows = buildConfirmedLabelRows(analysis.classes, analysis.sortedNormalized, modality, palette);
    assert.deepEqual(rows.map((row) => row.name), ["Traffic Sign", "car"]);
    assert.deepEqual(rows.map((row) => row.normalizedName), ["traffic sign", "car"]);
    assert.ok(rows.every((row) => row.modality === modality && row.scope === "OBJECT" && /^#[0-9A-F]{6}$/.test(row.color)));
    assert.equal(rows[1]!.color, "#9333EA"); assert.equal(rows[0]!.color, "#EA580C");
  }
});
