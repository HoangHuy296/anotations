import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { updateImageDescription } from "@/lib/workspace/image-mutations";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("Asset description revision rejects a stale writer and a labeler has no side effect", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
    const asset = await createImageAsset(dataset.id);
    const first = await updateImageDescription(owner, { datasetId: dataset.id, assetId: asset.id, version: asset.revision, description: "first durable description" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const stale = await updateImageDescription(owner, { datasetId: dataset.id, assetId: asset.id, version: asset.revision, description: "stale overwrite" });
    assert.deepEqual(stale, { ok: false, status: 409 });
    const denied = await updateImageDescription(labeler, { datasetId: dataset.id, assetId: asset.id, version: first.value.version, description: "forbidden overwrite" });
    assert.deepEqual(denied, { ok: false, status: 403 });
    const persisted = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { description: true, revision: true } });
    assert.equal(persisted.description, "first durable description");
    assert.equal(persisted.revision, first.value.version);
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]); }
});
