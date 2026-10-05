import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { UserRole } from "@internal/db";

import { readDatasetOverview } from "@/lib/datasets/dataset-overview-service";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/** T052 (022): a user with no relationship to the dataset cannot read its overview. */
test("a user with no membership or ownership of the dataset cannot read its overview", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const outsider = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const result = await readDatasetOverview(outsider, dataset.id);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 404, "existence is concealed from a non-member, not merely forbidden");
  } finally { await cleanupWorkspaceFixture([owner.id, outsider.id], [dataset.id]); }
});

test("a nonexistent dataset id is reported not found", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  try {
    const result = await readDatasetOverview(owner, "cly0000000000000000000000");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 404);
  } finally { await cleanupWorkspaceFixture([owner.id], []); }
});
