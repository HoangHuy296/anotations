import assert from "node:assert/strict";
import test from "node:test";

import { isAssetRelativePathConflict } from "../src/asset-identity-conflict.js";

test("recognizes the trigger's exact shape: P2002 + target null", () => {
  assert.equal(isAssetRelativePathConflict({ code: "P2002", meta: { modelName: "Asset", target: null } }), true);
});

test("does not misclassify a real, schema-known single-column unique violation", () => {
  assert.equal(isAssetRelativePathConflict({ code: "P2002", meta: { modelName: "Asset", target: ["storageKey"] } }), false);
});

test("does not misclassify a real, schema-known composite unique violation", () => {
  assert.equal(isAssetRelativePathConflict({ code: "P2002", meta: { modelName: "Asset", target: ["storageProvider", "storageBucket", "storageKey"] } }), false);
});

test("does not misclassify a P2002 on a different model", () => {
  assert.equal(isAssetRelativePathConflict({ code: "P2002", meta: { modelName: "PreparedImportItem", target: null } }), false);
});

test("does not misclassify an unrelated error code", () => {
  assert.equal(isAssetRelativePathConflict({ code: "P2025", meta: { modelName: "Asset", target: null } }), false);
  assert.equal(isAssetRelativePathConflict(new Error("boom")), false);
  assert.equal(isAssetRelativePathConflict(null), false);
  assert.equal(isAssetRelativePathConflict(undefined), false);
});

test("accepts an explicitly missing target (undefined) as the same signal as null", () => {
  assert.equal(isAssetRelativePathConflict({ code: "P2002", meta: { modelName: "Asset" } }), true);
});
