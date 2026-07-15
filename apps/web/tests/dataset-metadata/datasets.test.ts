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

test("MULTI_MODAL Dataset input allows absent primary modality and excludes browser ownership", () => {
  const parsed = createDatasetSchema.parse({ name: "Multimodal", type: "MULTI_MODAL", ownerId: "forged" });
  assert.equal(parsed.primaryModality, null);
  assert.equal("ownerId" in parsed, false);
});
