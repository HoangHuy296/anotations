import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { canCreateDataset, requireDatasetPermission } from "@/lib/authorization";
import { createDatasetSchema } from "@/lib/validation/dataset";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";
import { createDatasetMetadataFixture } from "./helpers";

test("system ADMIN overrides Dataset membership while MANAGER remains scoped", { skip: !hasIntegrationDatabase }, async () => {
  const data = await createDatasetMetadataFixture();
  try {
    assert.equal((await requireDatasetPermission(data.admin, data.fixture.otherDatasetId, "dataset.delete"))?.forbidden, false);
    assert.equal(await requireDatasetPermission(data.manager, data.fixture.otherDatasetId, "dataset.read"), null);
    assert.equal(canCreateDataset(data.admin), true);
    assert.equal(canCreateDataset(data.manager), true);
    assert.equal(canCreateDataset(data.fixture.actors.labeler), false);
  } finally { await data.cleanup(); }
});

test("Dataset creation requires explicit modality and excludes browser ownership", () => {
  assert.equal(createDatasetSchema.safeParse({ name: "Image dataset", type: "MULTI_MODAL" }).success, false);
  assert.equal(createDatasetSchema.safeParse({ name: "Image dataset", type: "MULTI_MODAL", modality: "IMAGE", ownerId: "forged" }).success, false);
  const parsed = createDatasetSchema.parse({ name: "Image dataset", type: "MULTI_MODAL", modality: "IMAGE" });
  assert.equal(parsed.modality, "IMAGE");
  assert.equal("ownerId" in parsed, false);
});
