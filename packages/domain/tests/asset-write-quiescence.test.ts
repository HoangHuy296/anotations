import assert from "node:assert/strict";
import test from "node:test";

import { isAssetWriteQuiescenceValue } from "../src/asset-write-quiescence.js";

test("only the exact literal '1' means paused", () => {
  assert.equal(isAssetWriteQuiescenceValue("1"), true);
});

test("absent, empty, or any other value means not paused (fail open)", () => {
  assert.equal(isAssetWriteQuiescenceValue(null), false);
  assert.equal(isAssetWriteQuiescenceValue(undefined), false);
  assert.equal(isAssetWriteQuiescenceValue(""), false);
  assert.equal(isAssetWriteQuiescenceValue("true"), false);
  assert.equal(isAssetWriteQuiescenceValue("0"), false);
});
