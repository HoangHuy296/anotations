import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTextPropertyPatch,
  textPropertiesSchema,
  textPropertyPatchSchema,
  TEXT_CUSTOM_PROPERTY_LIMITS,
} from "../src/text-properties-contract.js";

test("merge, stored null and explicit deletion are distinct and preserve unrelated metadata", () => {
  const original = { provenance: { immutable: true }, custom: { retained: true, remove: 3, nullable: "old" } };
  const result = applyTextPropertyPatch(original, { set: { nullable: null, added: 0 }, unset: ["remove", "absent"] });
  assert.deepEqual(result, { provenance: { immutable: true }, custom: { retained: true, nullable: null, added: 0 } });
  assert.equal(original.custom.remove, 3);
  assert.deepEqual(applyTextPropertyPatch({ custom: { last: null } }, { set: {}, unset: ["last"] }), { custom: {} });
});

test("strict custom properties reject reserved keys, containers, invalid numbers and unknown namespaces", () => {
  for (const custom of [{ nested: {} }, { list: [] }, { n: Infinity }, { n: NaN }, { n: 1e16 }, { revision: 3 }, JSON.parse('{"__proto__":1}')]) {
    assert.equal(textPropertiesSchema.safeParse({ custom }).success, false);
  }
  assert.equal(textPropertiesSchema.safeParse({ custom: {}, private: "bad" }).success, false);
  assert.equal(textPropertiesSchema.safeParse({ custom: { a: null, b: true, c: "", d: -1e15 } }).success, true);
});

test("patch keys must be nonempty, unique and disjoint", () => {
  for (const patch of [{ set: {}, unset: [] }, { set: { a: 1 }, unset: ["a"] }, { set: {}, unset: ["a", "a"] }]) {
    assert.equal(textPropertyPatchSchema.safeParse(patch).success, false);
  }
});

test("post-merge key count, UTF-16 length and encoded byte limits are enforced", () => {
  const atLimit = Object.fromEntries(Array.from({ length: TEXT_CUSTOM_PROPERTY_LIMITS.maxKeys }, (_, i) => [`key${i}`, null]));
  assert.throws(() => applyTextPropertyPatch({ custom: atLimit }, { set: { extra: true }, unset: [] }));
  assert.doesNotThrow(() => applyTextPropertyPatch({ custom: atLimit }, { set: { extra: true }, unset: ["key0"] }));
  assert.equal(textPropertiesSchema.safeParse({ custom: { tooLong: "😀".repeat(1025) } }).success, false);
  assert.equal(textPropertiesSchema.safeParse({ custom: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`key${i}`, "中".repeat(2048)])) }).success, false);
});
