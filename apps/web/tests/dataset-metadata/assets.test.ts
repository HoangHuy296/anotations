import assert from "node:assert/strict";
import test from "node:test";

import { assetMetadataSelect } from "@/lib/dataset-metadata";
import { assetListQuerySchema } from "@/lib/validation/asset-list";

test("asset filters are bounded and metadata projection excludes binary/storage/source fields", () => {
  assert.equal(assetListQuerySchema.parse({ limit: "100" }).limit, 100);
  assert.equal(assetListQuerySchema.safeParse({ limit: "101" }).success, false);
  for (const forbidden of ["storageKey", "storageBucket", "sourceUrl", "sourcePath", "sourceFingerprint", "cacheKey"]) assert.equal(forbidden in assetMetadataSelect, false);
});
