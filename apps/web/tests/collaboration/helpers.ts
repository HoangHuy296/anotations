import { AssetAssignmentType, DatasetMemberRole, UserRole } from "@internal/db";

import { createOrReuseCollaborationOutboxEvent } from "@/lib/collaboration/collaboration-outbox-service";
import { db } from "@/lib/db";
import {
  addWorkspaceMember,
  cleanupWorkspaceFixture,
  createImageAsset,
  createWorkspaceDataset,
  createWorkspaceUser,
} from "../workspace/helpers";

/** Compose/PostgreSQL fixture shared by later collaboration service and route tests. */
export async function createCollaborationFixture() {
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
    owner,
    labeler,
    reviewer,
    dataset,
    asset,
    cleanup: () => cleanupWorkspaceFixture([owner.id, labeler.id, reviewer.id], [dataset.id]),
  };
}

/** Creates a safe, dispatchable durable event without exposing payloads to tests that do not need them. */
export async function createCollaborationOutboxFixture(input: {
  datasetId: string;
  assetId?: string;
  actorId: string;
  recipientUserId?: string;
  dedupeKey: string;
}) {
  return db.$transaction((tx) => createOrReuseCollaborationOutboxEvent(tx, {
    datasetId: input.datasetId,
    assetId: input.assetId ?? null,
    actorId: input.actorId,
    recipientUserId: input.recipientUserId ?? null,
    type: "NOTIFICATION_CREATED",
    dedupeKey: input.dedupeKey,
    payload: { reason: "fixture" },
  }));
}

export { AssetAssignmentType };
