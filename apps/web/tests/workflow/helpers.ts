import { DatasetMemberRole, UserRole } from "@internal/db";

import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

/**
 * Phase 023's standard fixture: one dataset owner, one labeler, one reviewer,
 * and a single IMAGE Asset. Tests can add annotations/extra Assets without
 * duplicating membership setup or leaving records behind.
 */
export async function createWorkflowFixture() {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const reviewer = await createWorkspaceUser(UserRole.REVIEWER);
  const dataset = await createWorkspaceDataset(owner.id);
  await Promise.all([
    addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER),
    addWorkspaceMember(dataset.id, reviewer.id, DatasetMemberRole.REVIEWER),
  ]);
  const asset = await createImageAsset(dataset.id);
  return {
    owner, labeler, reviewer, dataset, asset,
    cleanup: () => cleanupWorkspaceFixture([owner.id, labeler.id, reviewer.id], [dataset.id]),
  };
}
