import assert from "node:assert/strict";
import test from "node:test";

import { UserRole } from "@internal/db";

import { readWorkspacePage } from "@/lib/workspace/workspace-read";
import { WORKSPACE_ASSET_PAGE_SIZE } from "@/lib/workspace/workspace-assets";
import { cleanupWorkspaceFixture, createWorkspaceAssetBatch, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/**
 * T067 -- no component-rendering test harness exists in this repo (no
 * jsdom/@testing-library/react dependency; see AGENTS.md's "do not add npm
 * packages without explicit permission"), so `AssetNavigator`'s own
 * Previous/Next JSX (`page <= 1`, `page * pageSize >= totalAssets`) is not
 * directly renderable here. What those two boundary checks actually consume
 * -- `page`/`pageSize`/`total` -- is computed server-side in
 * `readWorkspacePage`, so this test proves FR-043's `pageSize = 10` boundary
 * behavior at that real, database-backed source instead of re-deriving it
 * against a fake DOM.
 */
test("readWorkspacePage's page/pageSize/total drive AssetNavigator's Previous/Next boundary at pageSize = 10", { skip: !enabled }, async () => {
  assert.equal(WORKSPACE_ASSET_PAGE_SIZE, 10, "FR-043: the workspace Assets tab page size is fixed at 10");
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    // 11 assets: exactly one item past a single page of 10, the minimal
    // fixture that exercises both boundary transitions (page 1 -> Next
    // enabled, page 2 -> Previous enabled/Next disabled).
    await createWorkspaceAssetBatch(dataset.id, 11);

    const first = await readWorkspacePage(owner, dataset.id, { page: 1 });
    assert.equal(first?.page.items.length, 10);
    assert.equal(first?.page.pageSize, WORKSPACE_ASSET_PAGE_SIZE);
    assert.equal(first?.page.total, 11);
    // AssetNavigator's Previous button: disabled = page <= 1.
    assert.equal(first!.page.page <= 1, true);
    // AssetNavigator's Next button: disabled = page * pageSize >= total.
    assert.equal(first!.page.page * first!.page.pageSize >= first!.page.total, false, "an 11th asset exists on page 2, so Next must stay enabled");

    const second = await readWorkspacePage(owner, dataset.id, { page: 2 });
    assert.equal(second?.page.items.length, 1);
    assert.equal(second?.page.total, 11);
    assert.equal(second!.page.page <= 1, false, "Previous must be enabled once past page 1");
    assert.equal(second!.page.page * second!.page.pageSize >= second!.page.total, true, "the 11th asset is the last one, so Next must be disabled");

    // Beyond the last page is never an error -- empty items, real total.
    const beyond = await readWorkspacePage(owner, dataset.id, { page: 3 });
    assert.equal(beyond?.page.items.length, 0);
    assert.equal(beyond?.page.total, 11);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
