import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLabelName } from "@/lib/validation/label";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";
import { createDatasetMetadataFixture } from "./helpers";
import { requireDatasetPermission } from "@/lib/authorization";

test("label normalization collapses display-name case and whitespace", () => {
  assert.equal(normalizeLabelName("  Traffic Sign "), normalizeLabelName("traffic sign"));
});

test("reviewers cannot mutate taxonomy while an ADMIN can access it", { skip: !hasIntegrationDatabase }, async () => {
  const data = await createDatasetMetadataFixture();
  try {
    assert.equal((await requireDatasetPermission(data.fixture.actors.reviewer, data.fixture.datasetId, "label.manage"))?.forbidden, true);
    assert.equal((await requireDatasetPermission(data.admin, data.fixture.datasetId, "label.manage"))?.forbidden, false);
  } finally { await data.cleanup(); }
});
