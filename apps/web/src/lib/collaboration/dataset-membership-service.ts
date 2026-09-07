import "server-only";

import {
  AssetAssignmentType,
  AssetAssignmentEventAction,
  CollaborationOutboxEventType,
  DatasetInvitationStatus,
  DatasetMemberRole,
  DatasetMembershipEventAction,
  NotificationType,
  Prisma,
  UserRole,
} from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { canManageDatasetMemberRole, isEligibleAssignmentTarget } from "@/lib/authorization";
import {
  createOrReuseCollaborationOutboxEvent,
  enqueueCollaborationOutboxDispatch,
  runCollaborationTransaction,
} from "@/lib/collaboration/collaboration-outbox-service";
import { createDurableNotification } from "@/lib/collaboration/notification-service";

type TransactionClient = Prisma.TransactionClient;
const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export class DatasetMembershipError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "OWNER_PROTECTED",
    message: string,
  ) {
    super(message);
  }
}

type DatasetAccess = { id: string; ownerId: string; actorRole: DatasetMemberRole };
type DispatchResult = { outboxJobIds: string[] };

function isAdmin(actor: RequestActor) {
  return actor.role === UserRole.ADMIN;
}

async function requireManagerInTransaction(tx: TransactionClient, actor: RequestActor, datasetId: string): Promise<DatasetAccess> {
  const dataset = await tx.dataset.findFirst({
    where: {
      id: datasetId,
      deletedAt: null,
      archivedAt: null,
      ...(isAdmin(actor) ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }),
    },
    select: { id: true, ownerId: true, members: { where: { userId: actor.id }, select: { role: true } } },
  });
  if (!dataset) throw new DatasetMembershipError("NOT_FOUND", "The dataset was not found.");
  const actorRole = isAdmin(actor) || dataset.ownerId === actor.id ? DatasetMemberRole.OWNER : dataset.members[0]?.role;
  if (!actorRole || (actorRole !== DatasetMemberRole.OWNER && actorRole !== DatasetMemberRole.MANAGER)) {
    throw new DatasetMembershipError("FORBIDDEN", "You do not have permission to manage dataset members.");
  }
  return { id: dataset.id, ownerId: dataset.ownerId, actorRole };
}

function assertRoleManagedBy(actorRole: DatasetMemberRole, targetRole: DatasetMemberRole) {
  if (!canManageDatasetMemberRole(actorRole, targetRole)) {
    throw new DatasetMembershipError("FORBIDDEN", "You do not have permission to manage this member role.");
  }
}

async function expirePendingInvitations(tx: TransactionClient, where: Prisma.DatasetInvitationWhereInput) {
  const now = new Date();
  await tx.datasetInvitation.updateMany({
    where: { ...where, status: DatasetInvitationStatus.PENDING, expiresAt: { lte: now } },
    data: { status: DatasetInvitationStatus.EXPIRED, activeKey: null, respondedAt: now },
  });
}

async function recordMembershipEvent(
  tx: TransactionClient,
  input: { datasetId: string; memberUserId: string; actorId: string; action: DatasetMembershipEventAction; previousRole?: DatasetMemberRole | null; nextRole?: DatasetMemberRole | null },
) {
  return tx.datasetMembershipEvent.create({ data: input });
}

async function createMembershipOutbox(
  tx: TransactionClient,
  input: { datasetId: string; actorId: string; memberUserId: string; event: "invited" | "accepted" | "declined" | "revoked" | "role_changed" | "removed"; revoke?: boolean },
) {
  return createOrReuseCollaborationOutboxEvent(tx, {
    datasetId: input.datasetId,
    actorId: input.actorId,
    recipientUserId: input.memberUserId,
    type: input.revoke ? CollaborationOutboxEventType.MEMBERSHIP_REVOKED : CollaborationOutboxEventType.MEMBER_CHANGED,
    dedupeKey: `membership:${input.datasetId}:${input.memberUserId}:${input.event}`,
    payload: { event: input.event, memberUserId: input.memberUserId },
  });
}

async function cleanupIneligibleAssignments(
  tx: TransactionClient,
  input: { datasetId: string; userId: string; actorId: string; nextRole: DatasetMemberRole | null },
) {
  const assignments = await tx.assetAssignment.findMany({
    where: { datasetId: input.datasetId, userId: input.userId },
    select: { id: true, assetId: true, type: true },
  });
  const invalid = assignments.filter((assignment) => !input.nextRole || !isEligibleAssignmentTarget(input.nextRole, assignment.type));
  if (invalid.length === 0) return [];

  await tx.assetAssignmentEvent.createMany({
    data: invalid.map((assignment) => ({
      datasetId: input.datasetId,
      assetId: assignment.assetId,
      assignmentId: assignment.id,
      action: AssetAssignmentEventAction.REMOVED_FOR_ROLE_CHANGE,
      previousUserId: input.userId,
      actorId: input.actorId,
    })),
  });
  await tx.assetAssignment.deleteMany({ where: { id: { in: invalid.map((assignment) => assignment.id) } } });
  const legacyAnnotationAssetIds = invalid.filter((assignment) => assignment.type === AssetAssignmentType.ANNOTATION).map((assignment) => assignment.assetId);
  if (legacyAnnotationAssetIds.length) {
    await tx.asset.updateMany({
      where: { id: { in: legacyAnnotationAssetIds }, datasetId: input.datasetId, assignedToId: input.userId },
      data: { assignedToId: null },
    });
  }
  return invalid;
}

function mergeJobIds(...values: Array<{ jobId: string } | { kind: string; jobId: string } | undefined>) {
  return [...new Set(values.filter((value): value is { jobId: string } => Boolean(value)).map((value) => value.jobId))];
}

async function existingOutboxJobIds(tx: TransactionClient, dedupeKeys: string[]) {
  const rows = await tx.collaborationOutboxEvent.findMany({ where: { dedupeKey: { in: dedupeKeys } }, select: { jobId: true } });
  return [...new Set(rows.map((row) => row.jobId))];
}

export async function enqueueMembershipDispatches(result: DispatchResult) {
  await Promise.all(result.outboxJobIds.map((jobId) => enqueueCollaborationOutboxDispatch(jobId)));
}

export async function createDatasetInvitation(actor: RequestActor, input: { datasetId: string; inviteeUserId: string; role: DatasetMemberRole }) {
  return runCollaborationTransaction(async (tx) => {
    const access = await requireManagerInTransaction(tx, actor, input.datasetId);
    assertRoleManagedBy(access.actorRole, input.role);
    if (input.role === DatasetMemberRole.OWNER) throw new DatasetMembershipError("OWNER_PROTECTED", "Owner invitations are not allowed.");
    if (input.inviteeUserId === access.ownerId) throw new DatasetMembershipError("CONFLICT", "The dataset owner is already a member.");
    const invitee = await tx.user.findUnique({ where: { id: input.inviteeUserId }, select: { id: true, email: true } });
    if (!invitee) throw new DatasetMembershipError("NOT_FOUND", "The invitee was not found.");
    const existingMember = await tx.datasetMember.findUnique({ where: { datasetId_userId: { datasetId: input.datasetId, userId: input.inviteeUserId } }, select: { id: true } });
    if (existingMember) throw new DatasetMembershipError("CONFLICT", "The user is already a dataset member.");
    await expirePendingInvitations(tx, { datasetId: input.datasetId, inviteeUserId: input.inviteeUserId });
    const pending = await tx.datasetInvitation.findUnique({
      where: { datasetId_inviteeUserId_activeKey: { datasetId: input.datasetId, inviteeUserId: input.inviteeUserId, activeKey: "PENDING" } },
      select: { id: true, role: true, expiresAt: true, status: true },
    });
    if (pending) {
      if (pending.role !== input.role) throw new DatasetMembershipError("CONFLICT", "A pending invitation already exists with a different role.");
      return { invitation: pending, reused: true, outboxJobIds: await existingOutboxJobIds(tx, [
        `membership:${input.datasetId}:${input.inviteeUserId}:invited`,
        `notification:dataset-invitation:${pending.id}:${input.inviteeUserId}`,
      ]) };
    }
    const invitation = await tx.datasetInvitation.create({
      data: {
        datasetId: input.datasetId,
        inviteeUserId: input.inviteeUserId,
        invitedById: actor.id,
        role: input.role,
        status: DatasetInvitationStatus.PENDING,
        activeKey: "PENDING",
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
      select: { id: true, datasetId: true, inviteeUserId: true, role: true, status: true, expiresAt: true, createdAt: true },
    });
    await recordMembershipEvent(tx, { datasetId: input.datasetId, memberUserId: input.inviteeUserId, actorId: actor.id, action: DatasetMembershipEventAction.INVITED, nextRole: input.role });
    const notification = await createDurableNotification(tx, {
      userId: input.inviteeUserId, actorId: actor.id, type: NotificationType.DATASET_INVITE, datasetId: input.datasetId,
      title: "Dataset invitation", body: "You were invited to collaborate on a dataset.", dedupeKey: `dataset-invitation:${invitation.id}`,
    });
    const membershipOutbox = await createMembershipOutbox(tx, { datasetId: input.datasetId, actorId: actor.id, memberUserId: input.inviteeUserId, event: "invited" });
    const notificationOutbox = notification.kind === "stored" ? await createOrReuseCollaborationOutboxEvent(tx, {
      datasetId: input.datasetId, actorId: actor.id, recipientUserId: input.inviteeUserId, type: CollaborationOutboxEventType.NOTIFICATION_CREATED,
      dedupeKey: `notification:dataset-invitation:${invitation.id}:${input.inviteeUserId}`, payload: { notificationId: notification.notification.id },
    }) : undefined;
    return { invitation, reused: false, outboxJobIds: mergeJobIds(membershipOutbox, notificationOutbox) };
  });
}

export async function listDatasetInvitations(actor: RequestActor, datasetId: string) {
  return runCollaborationTransaction(async (tx) => {
    await requireManagerInTransaction(tx, actor, datasetId);
    await expirePendingInvitations(tx, { datasetId });
    return tx.datasetInvitation.findMany({
      where: { datasetId }, orderBy: { createdAt: "desc" },
      select: { id: true, datasetId: true, inviteeUserId: true, role: true, status: true, expiresAt: true, respondedAt: true, revokedAt: true, createdAt: true, invitee: { select: { email: true, name: true } } },
    });
  });
}

export async function listDatasetMembers(actor: RequestActor, datasetId: string) {
  return runCollaborationTransaction(async (tx) => {
    await requireManagerInTransaction(tx, actor, datasetId).catch(async (error) => {
      if (!(error instanceof DatasetMembershipError) || error.code !== "FORBIDDEN") throw error;
      // Reading the directory is available to any current dataset reader; keep management checks separate.
      const dataset = await tx.dataset.findFirst({ where: { id: datasetId, deletedAt: null, archivedAt: null, ...(isAdmin(actor) ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }) }, select: { id: true, owner: { select: { id: true, email: true, name: true } } } });
      if (!dataset) throw new DatasetMembershipError("NOT_FOUND", "The dataset was not found.");
      return null;
    });
    const dataset = await tx.dataset.findUnique({ where: { id: datasetId }, select: { owner: { select: { id: true, email: true, name: true } } } });
    if (!dataset) throw new DatasetMembershipError("NOT_FOUND", "The dataset was not found.");
    const members = await tx.datasetMember.findMany({ where: { datasetId }, select: { role: true, user: { select: { id: true, name: true, email: true } } }, orderBy: { user: { email: "asc" } } });
    const items = members.map((member) => ({ id: member.user.id, name: member.user.name ?? member.user.email, email: member.user.email, role: member.role }));
    if (!items.some((member) => member.id === dataset.owner.id)) items.unshift({ id: dataset.owner.id, name: dataset.owner.name ?? dataset.owner.email, email: dataset.owner.email, role: DatasetMemberRole.OWNER });
    return items;
  });
}

async function loadInvitationForActor(tx: TransactionClient, invitationId: string, actor: RequestActor) {
  const invitation = await tx.datasetInvitation.findUnique({ where: { id: invitationId }, select: { id: true, datasetId: true, inviteeUserId: true, invitedById: true, role: true, status: true, activeKey: true, expiresAt: true } });
  if (!invitation || invitation.inviteeUserId !== actor.id) throw new DatasetMembershipError("NOT_FOUND", "The invitation was not found.");
  await expirePendingInvitations(tx, { id: invitation.id });
  return tx.datasetInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
}

export async function acceptDatasetInvitation(actor: RequestActor, invitationId: string) {
  const outcome = await runCollaborationTransaction(async (tx) => {
    const invitation = await loadInvitationForActor(tx, invitationId, actor);
    if (invitation.status === DatasetInvitationStatus.ACCEPTED) {
      const member = await tx.datasetMember.findUnique({ where: { datasetId_userId: { datasetId: invitation.datasetId, userId: actor.id } }, select: { id: true, role: true } });
      if (!member) throw new DatasetMembershipError("CONFLICT", "The invitation has already been resolved.");
      return { invitationId: invitation.id, member, reused: true, outboxJobIds: await existingOutboxJobIds(tx, [
        `membership:${invitation.datasetId}:${actor.id}:accepted`,
        `notification:dataset-invitation:${invitation.id}:accepted:${invitation.invitedById}`,
      ]) };
    }
    if (invitation.status !== DatasetInvitationStatus.PENDING) return { kind: "conflict" as const };
    const claimed = await tx.datasetInvitation.updateMany({ where: { id: invitation.id, status: DatasetInvitationStatus.PENDING, activeKey: "PENDING", expiresAt: { gt: new Date() } }, data: { status: DatasetInvitationStatus.ACCEPTED, activeKey: null, respondedAt: new Date() } });
    if (claimed.count !== 1) return { kind: "conflict" as const };
    const member = await tx.datasetMember.upsert({ where: { datasetId_userId: { datasetId: invitation.datasetId, userId: actor.id } }, create: { datasetId: invitation.datasetId, userId: actor.id, role: invitation.role }, update: {}, select: { id: true, role: true } });
    await recordMembershipEvent(tx, { datasetId: invitation.datasetId, memberUserId: actor.id, actorId: actor.id, action: DatasetMembershipEventAction.ACCEPTED, nextRole: invitation.role });
    const notification = await createDurableNotification(tx, {
      userId: invitation.invitedById, actorId: actor.id, type: NotificationType.DATASET_INVITE, datasetId: invitation.datasetId,
      title: "Invitation accepted", body: "A collaborator accepted a dataset invitation.", dedupeKey: `dataset-invitation:${invitation.id}:accepted:${invitation.invitedById}`,
    });
    const membershipOutbox = await createMembershipOutbox(tx, { datasetId: invitation.datasetId, actorId: actor.id, memberUserId: actor.id, event: "accepted" });
    const notificationOutbox = notification.kind === "stored" ? await createOrReuseCollaborationOutboxEvent(tx, {
      datasetId: invitation.datasetId, actorId: actor.id, recipientUserId: invitation.invitedById, type: CollaborationOutboxEventType.NOTIFICATION_CREATED,
      dedupeKey: `notification:dataset-invitation:${invitation.id}:accepted:${invitation.invitedById}`, payload: { notificationId: notification.notification.id },
    }) : undefined;
    return { kind: "accepted" as const, invitationId: invitation.id, member, reused: false, outboxJobIds: mergeJobIds(membershipOutbox, notificationOutbox) };
  });
  if ("kind" in outcome && outcome.kind === "conflict") throw new DatasetMembershipError("CONFLICT", "The invitation is no longer pending.");
  return outcome;
}

export async function declineDatasetInvitation(actor: RequestActor, invitationId: string) {
  const outcome = await runCollaborationTransaction(async (tx) => {
    const invitation = await loadInvitationForActor(tx, invitationId, actor);
    if (invitation.status === DatasetInvitationStatus.DECLINED) return { invitationId, reused: true, outboxJobIds: await existingOutboxJobIds(tx, [`membership:${invitation.datasetId}:${actor.id}:declined`]) };
    if (invitation.status !== DatasetInvitationStatus.PENDING) return { kind: "conflict" as const };
    await tx.datasetInvitation.update({ where: { id: invitation.id }, data: { status: DatasetInvitationStatus.DECLINED, activeKey: null, respondedAt: new Date() } });
    await recordMembershipEvent(tx, { datasetId: invitation.datasetId, memberUserId: actor.id, actorId: actor.id, action: DatasetMembershipEventAction.DECLINED, previousRole: invitation.role });
    const outbox = await createMembershipOutbox(tx, { datasetId: invitation.datasetId, actorId: actor.id, memberUserId: actor.id, event: "declined" });
    return { kind: "declined" as const, invitationId: invitation.id, reused: false, outboxJobIds: mergeJobIds(outbox) };
  });
  if ("kind" in outcome && outcome.kind === "conflict") throw new DatasetMembershipError("CONFLICT", "The invitation is no longer pending.");
  return outcome;
}

export async function revokeDatasetInvitation(actor: RequestActor, input: { datasetId: string; invitationId: string }) {
  const outcome = await runCollaborationTransaction(async (tx) => {
    const access = await requireManagerInTransaction(tx, actor, input.datasetId);
    await expirePendingInvitations(tx, { id: input.invitationId, datasetId: input.datasetId });
    const invitation = await tx.datasetInvitation.findFirst({ where: { id: input.invitationId, datasetId: input.datasetId } });
    if (!invitation) throw new DatasetMembershipError("NOT_FOUND", "The invitation was not found.");
    assertRoleManagedBy(access.actorRole, invitation.role);
    if (invitation.status === DatasetInvitationStatus.REVOKED) return { invitationId: invitation.id, reused: true, outboxJobIds: await existingOutboxJobIds(tx, [`membership:${input.datasetId}:${invitation.inviteeUserId}:revoked`]) };
    if (invitation.status !== DatasetInvitationStatus.PENDING) return { kind: "conflict" as const };
    await tx.datasetInvitation.update({ where: { id: invitation.id }, data: { status: DatasetInvitationStatus.REVOKED, activeKey: null, revokedAt: new Date() } });
    await recordMembershipEvent(tx, { datasetId: input.datasetId, memberUserId: invitation.inviteeUserId, actorId: actor.id, action: DatasetMembershipEventAction.REVOKED, previousRole: invitation.role });
    const outbox = await createMembershipOutbox(tx, { datasetId: input.datasetId, actorId: actor.id, memberUserId: invitation.inviteeUserId, event: "revoked" });
    return { kind: "revoked" as const, invitationId: invitation.id, reused: false, outboxJobIds: mergeJobIds(outbox) };
  });
  if ("kind" in outcome && outcome.kind === "conflict") throw new DatasetMembershipError("CONFLICT", "The invitation is no longer pending.");
  return outcome;
}

export async function changeDatasetMemberRole(actor: RequestActor, input: { datasetId: string; userId: string; role: DatasetMemberRole }) {
  return runCollaborationTransaction(async (tx) => {
    const access = await requireManagerInTransaction(tx, actor, input.datasetId);
    if (input.userId === access.ownerId || input.role === DatasetMemberRole.OWNER) throw new DatasetMembershipError("OWNER_PROTECTED", "The dataset owner cannot be changed.");
    const member = await tx.datasetMember.findUnique({ where: { datasetId_userId: { datasetId: input.datasetId, userId: input.userId } }, select: { id: true, role: true } });
    if (!member) throw new DatasetMembershipError("NOT_FOUND", "The dataset member was not found.");
    assertRoleManagedBy(access.actorRole, member.role);
    assertRoleManagedBy(access.actorRole, input.role);
    if (member.role === input.role) return { member: { userId: input.userId, role: member.role }, reused: true, cleanedAssignmentIds: [], outboxJobIds: [] };
    await tx.datasetMember.update({ where: { id: member.id }, data: { role: input.role } });
    const cleaned = await cleanupIneligibleAssignments(tx, { datasetId: input.datasetId, userId: input.userId, actorId: actor.id, nextRole: input.role });
    await recordMembershipEvent(tx, { datasetId: input.datasetId, memberUserId: input.userId, actorId: actor.id, action: DatasetMembershipEventAction.ROLE_CHANGED, previousRole: member.role, nextRole: input.role });
    const membershipOutbox = await createMembershipOutbox(tx, { datasetId: input.datasetId, actorId: actor.id, memberUserId: input.userId, event: "role_changed", revoke: true });
    const assignmentOutbox = cleaned.length ? await createOrReuseCollaborationOutboxEvent(tx, {
      datasetId: input.datasetId, actorId: actor.id, recipientUserId: input.userId, type: CollaborationOutboxEventType.ASSIGNMENT_CHANGED,
      dedupeKey: `assignment-cleanup:${input.datasetId}:${input.userId}:role:${input.role}`, payload: { event: "assignment_removed_for_role_change", userId: input.userId },
    }) : undefined;
    return { member: { userId: input.userId, role: input.role }, reused: false, cleanedAssignmentIds: cleaned.map((assignment) => assignment.id), outboxJobIds: mergeJobIds(membershipOutbox, assignmentOutbox) };
  });
}

export async function removeDatasetMember(actor: RequestActor, input: { datasetId: string; userId: string }) {
  return runCollaborationTransaction(async (tx) => {
    const access = await requireManagerInTransaction(tx, actor, input.datasetId);
    if (input.userId === access.ownerId) throw new DatasetMembershipError("OWNER_PROTECTED", "The dataset owner cannot be removed.");
    const member = await tx.datasetMember.findUnique({ where: { datasetId_userId: { datasetId: input.datasetId, userId: input.userId } }, select: { id: true, role: true } });
    if (!member) throw new DatasetMembershipError("NOT_FOUND", "The dataset member was not found.");
    assertRoleManagedBy(access.actorRole, member.role);
    const cleaned = await cleanupIneligibleAssignments(tx, { datasetId: input.datasetId, userId: input.userId, actorId: actor.id, nextRole: null });
    await tx.datasetMember.delete({ where: { id: member.id } });
    await recordMembershipEvent(tx, { datasetId: input.datasetId, memberUserId: input.userId, actorId: actor.id, action: DatasetMembershipEventAction.REMOVED, previousRole: member.role });
    const membershipOutbox = await createMembershipOutbox(tx, { datasetId: input.datasetId, actorId: actor.id, memberUserId: input.userId, event: "removed", revoke: true });
    const assignmentOutbox = cleaned.length ? await createOrReuseCollaborationOutboxEvent(tx, {
      datasetId: input.datasetId, actorId: actor.id, recipientUserId: input.userId, type: CollaborationOutboxEventType.ASSIGNMENT_CHANGED,
      dedupeKey: `assignment-cleanup:${input.datasetId}:${input.userId}:removed`, payload: { event: "assignment_removed_for_member_removal", userId: input.userId },
    }) : undefined;
    return { removedUserId: input.userId, reused: false, cleanedAssignmentIds: cleaned.map((assignment) => assignment.id), outboxJobIds: mergeJobIds(membershipOutbox, assignmentOutbox) };
  });
}
