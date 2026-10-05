import assert from "node:assert/strict";
import test from "node:test";

import { AssetRevivalRequiresRelativePathError, assertRevivalHasCanonicalRelativePath, isLikelyLiveRequiresRelativePathViolation } from "../src/asset-revival.js";

test("throws when no relativePath is available for a revival", () => {
  assert.throws(() => assertRevivalHasCanonicalRelativePath("asset-1", null), AssetRevivalRequiresRelativePathError);
  assert.throws(() => assertRevivalHasCanonicalRelativePath("asset-1", undefined), AssetRevivalRequiresRelativePathError);
  assert.throws(() => assertRevivalHasCanonicalRelativePath("asset-1", ""), AssetRevivalRequiresRelativePathError);
});

test("does not throw when a relativePath is available", () => {
  assertRevivalHasCanonicalRelativePath("asset-1", "a/1.png");
});

test("never invents a path -- the thrown error carries the assetId, not a fabricated value", () => {
  try {
    assertRevivalHasCanonicalRelativePath("asset-42", null);
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof AssetRevivalRequiresRelativePathError);
    assert.equal(error.assetId, "asset-42");
  }
});

test("best-effort detector matches the constraint name in a message, nothing else", () => {
  assert.equal(isLikelyLiveRequiresRelativePathViolation({ message: "... asset_live_requires_relative_path ..." }), true);
  assert.equal(isLikelyLiveRequiresRelativePathViolation({ message: "unrelated error" }), false);
  assert.equal(isLikelyLiveRequiresRelativePathViolation({}), false);
  assert.equal(isLikelyLiveRequiresRelativePathViolation(null), false);
});
