import assert from "node:assert/strict";
import test from "node:test";

import { datasetIdSchema } from "@/lib/validation/dataset";
import { jobIdSchema } from "@/lib/validation/job";

test("workspace and import identifiers accept both legacy CUIDs and local-import UUIDs", () => {
  const cuid = "cm8x4jk3n0001w8q9azk8cy2u";
  const uuid = "62284cd3-393d-44cd-ab2b-be3c635fa779";
  assert.equal(datasetIdSchema.safeParse(cuid).success, true);
  assert.equal(datasetIdSchema.safeParse(uuid).success, true);
  assert.equal(jobIdSchema.safeParse(cuid).success, true);
  assert.equal(jobIdSchema.safeParse(uuid).success, true);
  assert.equal(datasetIdSchema.safeParse("not-an-id").success, false);
  assert.equal(jobIdSchema.safeParse("not-an-id").success, false);
});
