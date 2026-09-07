import assert from "node:assert/strict";
import test from "node:test";

import { assetMetadataSelect } from "@/lib/dataset-metadata";
import { assetListQuerySchema } from "@/lib/validation/asset-list";

test("asset filters are bounded and metadata projection excludes binary/storage/source fields", () => {
  assert.equal(assetListQuerySchema.parse({ limit: "100" }).limit, 100);
  assert.equal(assetListQuerySchema.safeParse({ limit: "101" }).success, false);
  for (const forbidden of ["storageKey", "storageBucket", "sourceUrl", "sourcePath", "sourceFingerprint", "cacheKey"]) assert.equal(forbidden in assetMetadataSelect, false);
});

// T011 (022): the Asset Browser's extended query params on
// `GET /api/datasets/[datasetId]/assets`, per contracts/assets-list.md.
// Backward compatibility: a single bare `status` value (the pre-022 shape)
// still parses to a one-element array, so existing callers are unaffected.
test("status/labelId accept repeated values while a single bare value still parses (backward compatible)", () => {
  const repeated = assetListQuerySchema.parse({ status: ["NEEDS_REVIEW", "REVIEWED"], labelId: ["cly0000000000000000000000", "cly0000000000000000000001"] });
  assert.deepEqual(repeated.status, ["NEEDS_REVIEW", "REVIEWED"]);
  assert.deepEqual(repeated.labelId, ["cly0000000000000000000000", "cly0000000000000000000001"]);
  const single = assetListQuerySchema.parse({ status: "NEEDS_REVIEW" });
  assert.deepEqual(single.status, ["NEEDS_REVIEW"], "a single bare status value (the pre-022 shape) still parses, just as a one-element array");
  assert.equal(assetListQuerySchema.safeParse({ status: "NOT_A_STATUS" }).success, false);
});

test("sort/order are optional and validated; order defaults to desc", () => {
  const withSort = assetListQuerySchema.parse({ sort: "updatedAt", order: "asc" });
  assert.equal(withSort.sort, "updatedAt");
  assert.equal(withSort.order, "asc");
  assert.equal(assetListQuerySchema.parse({}).order, "desc", "order defaults to desc even when unset");
  assert.equal(assetListQuerySchema.safeParse({ sort: "annotationCount" }).success, false, "only createdAt/updatedAt/filename are valid sort fields");
});

test("date range filters must be valid ISO datetimes and createdTo/updatedTo may not precede their -From counterpart", () => {
  const valid = assetListQuerySchema.safeParse({ createdFrom: "2026-01-01T00:00:00.000Z", createdTo: "2026-06-01T00:00:00.000Z" });
  assert.equal(valid.success, true);
  assert.equal(assetListQuerySchema.safeParse({ createdFrom: "not-a-date" }).success, false);
  const inverted = assetListQuerySchema.safeParse({ createdFrom: "2026-06-01T00:00:00.000Z", createdTo: "2026-01-01T00:00:00.000Z" });
  assert.equal(inverted.success, false, "createdTo before createdFrom must be rejected");
  const invertedUpdated = assetListQuerySchema.safeParse({ updatedFrom: "2026-06-01T00:00:00.000Z", updatedTo: "2026-01-01T00:00:00.000Z" });
  assert.equal(invertedUpdated.success, false, "updatedTo before updatedFrom must be rejected");
});

test("assignedToId must be a valid id when present but stays optional (022 assignment filtering boundary, FR-004)", () => {
  assert.equal(assetListQuerySchema.safeParse({}).success, true, "assignedToId is optional");
  assert.equal(assetListQuerySchema.safeParse({ assignedToId: "cly0000000000000000000000" }).success, true);
  assert.equal(assetListQuerySchema.safeParse({ assignedToId: "not-a-cuid" }).success, false);
});
