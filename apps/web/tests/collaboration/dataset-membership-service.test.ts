import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetAssignmentType, DatasetInvitationStatus, DatasetMemberRole, UserRole } from "@internal/db";

import {
  acceptDatasetInvitation,
  changeDatasetMemberRole,
  createDatasetInvitation,
  DatasetMembershipError,
  declineDatasetInvitation,
  removeDatasetMember,
  revokeDatasetInvitation,
} from "@/lib/collaboration/dataset-membership-service";
import { db } from "@/lib/db";
import { createImageAsset, createWorkspaceDataset, createWorkspaceUser, addWorkspaceMember, cleanupWorkspaceFixture } from "../workspace/helpers";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";

test("dataset invitation lifecycle is idempotent, terminal invitations cannot be accepted, and pending uniqueness is durable", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
  const invitee = { id: labeler.id, email: labeler.email, name: labeler.name, role: labeler.role };
  let secondInviteeId: string | undefined;
  try {
    const created = await createDatasetInvitation(actor, { datasetId: dataset.id, inviteeUserId: labeler.id, role: DatasetMemberRole.LABELER });
    const replay = await createDatasetInvitation(actor, { datasetId: dataset.id, inviteeUserId: labeler.id, role: DatasetMemberRole.LABELER });
    assert.equal(replay.reused, true);
    assert.equal(replay.invitation.id, created.invitation.id);
    assert.ok(replay.outboxJobIds.length > 0, "a command replay can re-enqueue its already durable delivery Jobs");
    await assert.rejects(() => createDatasetInvitation(actor, { datasetId: dataset.id, inviteeUserId: labeler.id, role: DatasetMemberRole.REVIEWER }), DatasetMembershipError);

    const [first, second] = await Promise.all([acceptDatasetInvitation(invitee, created.invitation.id), acceptDatasetInvitation(invitee, created.invitation.id)]);
    assert.equal([first, second].filter((result) => !result.reused).length, 1);
    assert.ok([first, second].find((result) => result.reused)?.outboxJobIds.length, "double acceptance replay retains dispatch recovery intent");
    assert.equal(await db.datasetMember.count({ where: { datasetId: dataset.id, userId: labeler.id } }), 1);
    assert.equal(await db.datasetMembershipEvent.count({ where: { datasetId: dataset.id, memberUserId: labeler.id, action: "ACCEPTED" } }), 1);
    await assert.rejects(() => createDatasetInvitation(actor, { datasetId: dataset.id, inviteeUserId: labeler.id, role: DatasetMemberRole.LABELER }), DatasetMembershipError);
    assert.equal(await db.notification.count({ where: { userId: labeler.id, type: "DATASET_INVITE" } }), 1);

    const secondInvitee = await createWorkspaceUser(); secondInviteeId = secondInvitee.id;
    const secondActor = { id: secondInvitee.id, email: secondInvitee.email, name: secondInvitee.name, role: secondInvitee.role };
    const declined = await createDatasetInvitation(actor, { datasetId: dataset.id, inviteeUserId: secondInvitee.id, role: DatasetMemberRole.LABELER });
    await declineDatasetInvitation(secondActor, declined.invitation.id);
    await assert.rejects(() => acceptDatasetInvitation(secondActor, declined.invitation.id), DatasetMembershipError);
    const reissued = await createDatasetInvitation(actor, { datasetId: dataset.id, inviteeUserId: secondInvitee.id, role: DatasetMemberRole.LABELER });
    await revokeDatasetInvitation(actor, { datasetId: dataset.id, invitationId: reissued.invitation.id });
    await assert.rejects(() => acceptDatasetInvitation(secondActor, reissued.invitation.id), DatasetMembershipError);
    await db.datasetInvitation.update({ where: { id: (await createDatasetInvitation(actor, { datasetId: dataset.id, inviteeUserId: secondInvitee.id, role: DatasetMemberRole.LABELER })).invitation.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    const expired = await createDatasetInvitation(actor, { datasetId: dataset.id, inviteeUserId: secondInvitee.id, role: DatasetMemberRole.LABELER });
    assert.notEqual(expired.invitation.status, DatasetInvitationStatus.EXPIRED);
    await db.datasetInvitation.update({ where: { id: expired.invitation.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await assert.rejects(() => acceptDatasetInvitation(secondActor, expired.invitation.id), DatasetMembershipError);
    assert.equal((await db.datasetInvitation.findUniqueOrThrow({ where: { id: expired.invitation.id } })).status, DatasetInvitationStatus.EXPIRED);
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id, ...(secondInviteeId ? [secondInviteeId] : [])], [dataset.id]); }
});

test("owner protection, manager limits, role downgrade and removal clean incompatible assignment slots atomically", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const manager = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser();
  const reviewer = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  await addWorkspaceMember(dataset.id, manager.id, DatasetMemberRole.MANAGER);
  await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
  await addWorkspaceMember(dataset.id, reviewer.id, DatasetMemberRole.REVIEWER);
  const [annotationAsset, reviewAsset] = await Promise.all([createImageAsset(dataset.id), createImageAsset(dataset.id)]);
  const ownerActor = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
  const managerActor = { id: manager.id, email: manager.email, name: manager.name, role: manager.role };
  const labelerActor = { id: labeler.id, email: labeler.email, name: labeler.name, role: labeler.role };
  try {
    await db.assetAssignment.create({ data: { datasetId: dataset.id, assetId: annotationAsset.id, userId: labeler.id, type: AssetAssignmentType.ANNOTATION, assignedById: owner.id } });
    await db.asset.update({ where: { id: annotationAsset.id }, data: { assignedToId: labeler.id } });
    await db.assetAssignment.create({ data: { datasetId: dataset.id, assetId: reviewAsset.id, userId: reviewer.id, type: AssetAssignmentType.REVIEW, assignedById: owner.id } });
    await assert.rejects(() => removeDatasetMember(ownerActor, { datasetId: dataset.id, userId: owner.id }), DatasetMembershipError);
    await assert.rejects(() => changeDatasetMemberRole(managerActor, { datasetId: dataset.id, userId: manager.id, role: DatasetMemberRole.LABELER }), DatasetMembershipError);
    await assert.rejects(() => changeDatasetMemberRole(labelerActor, { datasetId: dataset.id, userId: reviewer.id, role: DatasetMemberRole.LABELER }), DatasetMembershipError);
    const downgraded = await changeDatasetMemberRole(ownerActor, { datasetId: dataset.id, userId: labeler.id, role: DatasetMemberRole.REVIEWER });
    assert.equal(downgraded.cleanedAssignmentIds.length, 1);
    assert.equal(await db.assetAssignment.count({ where: { assetId: annotationAsset.id } }), 0);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: annotationAsset.id } })).assignedToId, null);
    assert.equal(await db.assetAssignmentEvent.count({ where: { assetId: annotationAsset.id, action: "REMOVED_FOR_ROLE_CHANGE" } }), 1);
    const removed = await removeDatasetMember(ownerActor, { datasetId: dataset.id, userId: reviewer.id });
    assert.equal(removed.cleanedAssignmentIds.length, 1);
    assert.equal(await db.assetAssignment.count({ where: { assetId: reviewAsset.id } }), 0);
    assert.equal(await db.datasetMember.count({ where: { datasetId: dataset.id, userId: reviewer.id } }), 0);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { datasetId: dataset.id, type: "MEMBERSHIP_REVOKED" } }), 2);
  } finally { await cleanupWorkspaceFixture([owner.id, manager.id, labeler.id, reviewer.id], [dataset.id]); }
});

test("failed invitation transactions leave no invitation, notification, event, or outbox partial state", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const target = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
  try {
    await assert.rejects(() => createDatasetInvitation(actor, { datasetId: dataset.id, inviteeUserId: "cl000000000000000000000000", role: DatasetMemberRole.LABELER }), DatasetMembershipError);
    assert.equal(await db.datasetInvitation.count({ where: { datasetId: dataset.id } }), 0);
    assert.equal(await db.notification.count({ where: { userId: target.id, datasetId: dataset.id } }), 0);
    assert.equal(await db.datasetMembershipEvent.count({ where: { datasetId: dataset.id } }), 0);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { datasetId: dataset.id } }), 0);
  } finally { await cleanupWorkspaceFixture([owner.id, target.id], [dataset.id]); }
});
