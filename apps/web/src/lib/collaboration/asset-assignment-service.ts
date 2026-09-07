import "server-only";

import {
  AssetAssignmentEventAction,
  AssetAssignmentType,
  CollaborationOutboxEventType,
  DatasetMemberRole,
  NotificationType,
  Prisma,
  UserRole,
} from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { isEligibleAssignmentTarget } from "@/lib/authorization";
import {
  createOrReuseCollaborationOutboxEvent,
  enqueueCollaborationOutboxDispatch,
  runCollaborationTransaction,
} from "@/lib/collaboration/collaboration-outbox-service";
import { createDurableNotification } from "@/lib/collaboration/notification-service";

type TransactionClient = Prisma.TransactionClient;
type AssignmentDispatchResult = { outboxJobIds: string[] };

export class AssetAssignmentError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_TARGET", message: string) { super(message); }
}

function uniqueJobIds(...values: Array<{ jobId: string } | undefined>) {
  return [...new Set(values.filter((value): value is { jobId: string } => Boolean(value)).map((value) => value.jobId))];
}

async function requireAssignmentManager(tx: TransactionClient, actor: RequestActor, datasetId: string) {
  const dataset = await tx.dataset.findFirst({
    where: {
      id: datasetId, deletedAt: null, archivedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }),
    },
    select: { id: true, ownerId: true, members: { where: { userId: actor.id }, select: { role: true } } },
  });
  if (!dataset) throw new AssetAssignmentError("NOT_FOUND", "The dataset was not found.");
  const role = actor.role === UserRole.ADMIN || dataset.ownerId === actor.id ? DatasetMemberRole.OWNER : dataset.members[0]?.role;
  if (role !== DatasetMemberRole.OWNER && role !== DatasetMemberRole.MANAGER) throw new AssetAssignmentError("FORBIDDEN", "You do not have permission to manage asset assignments.");
  return dataset;
}

async function requireAssignmentRead(tx: TransactionClient, actor: RequestActor, datasetId: string) {
  const dataset = await tx.dataset.findFirst({
    where: {
      id: datasetId, deletedAt: null, archivedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }),
    }, select: { id: true },
  });
  if (!dataset) throw new AssetAssignmentError("NOT_FOUND", "The dataset was not found.");
}

async function requireAsset(tx: TransactionClient, datasetId: string, assetId: string) {
  const asset = await tx.asset.findFirst({ where: { id: assetId, datasetId, deletedAt: null, archivedAt: null }, select: { id: true, assignedToId: true } });
  if (!asset) throw new AssetAssignmentError("NOT_FOUND", "The asset was not found.");
  return asset;
}

async function requireEligibleTarget(tx: TransactionClient, datasetId: string, userId: string, type: AssetAssignmentType) {
  const member = await tx.datasetMember.findUnique({ where: { datasetId_userId: { datasetId, userId } }, select: { role: true, user: { select: { id: true } } } });
  if (!member || !isEligibleAssignmentTarget(member.role, type)) {
    throw new AssetAssignmentError("INVALID_TARGET", "The target is not an eligible current dataset member for this responsibility.");
  }
}

async function assignmentOutbox(tx: TransactionClient, input: { datasetId: string; assetId: string; actorId: string; recipientUserId: string; eventId: string; type: AssetAssignmentType; notificationId?: string }) {
  const assignment = await createOrReuseCollaborationOutboxEvent(tx, {
    datasetId: input.datasetId, assetId: input.assetId, actorId: input.actorId, recipientUserId: input.recipientUserId,
    type: CollaborationOutboxEventType.ASSIGNMENT_CHANGED, dedupeKey: `assignment-event:${input.eventId}`,
    payload: { event: "assignment_changed", assignmentType: input.type, assetId: input.assetId },
  });
  const notification = input.notificationId ? await createOrReuseCollaborationOutboxEvent(tx, {
    datasetId: input.datasetId, assetId: input.assetId, actorId: input.actorId, recipientUserId: input.recipientUserId,
    type: CollaborationOutboxEventType.NOTIFICATION_CREATED, dedupeKey: `notification:assignment-event:${input.eventId}:${input.recipientUserId}`,
    payload: { notificationId: input.notificationId },
  }) : undefined;
  return uniqueJobIds(assignment, notification);
}

export async function enqueueAssignmentDispatches(result: AssignmentDispatchResult) {
  await Promise.all(result.outboxJobIds.map((jobId) => enqueueCollaborationOutboxDispatch(jobId)));
}

export async function getAssetAssignments(actor: RequestActor, input: { datasetId: string; assetId: string }) {
  return runCollaborationTransaction(async (tx) => {
    await requireAssignmentRead(tx, actor, input.datasetId);
    await requireAsset(tx, input.datasetId, input.assetId);
    const [assignments, history] = await Promise.all([
      tx.assetAssignment.findMany({
        where: { datasetId: input.datasetId, assetId: input.assetId }, orderBy: { type: "asc" },
        select: { id: true, type: true, userId: true, assignedById: true, assignedAt: true, updatedAt: true, user: { select: { name: true, email: true } } },
      }),
      tx.assetAssignmentEvent.findMany({
        where: { datasetId: input.datasetId, assetId: input.assetId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
        select: { id: true, action: true, previousUserId: true, nextUserId: true, actorId: true, createdAt: true },
      }),
    ]);
    return { assignments, history };
  });
}

export async function upsertAssetAssignment(actor: RequestActor, input: { datasetId: string; assetId: string; type: AssetAssignmentType; userId: string }) {
  return runCollaborationTransaction(async (tx) => {
    await requireAssignmentManager(tx, actor, input.datasetId);
    const asset = await requireAsset(tx, input.datasetId, input.assetId);
    await requireEligibleTarget(tx, input.datasetId, input.userId, input.type);
    const existing = await tx.assetAssignment.findUnique({ where: { assetId_type: { assetId: input.assetId, type: input.type } }, select: { id: true, userId: true } });
    if (existing?.userId === input.userId) return { assignmentId: existing.id, type: input.type, userId: input.userId, reused: true, outboxJobIds: [] };
    const assignment = await tx.assetAssignment.upsert({
      where: { assetId_type: { assetId: input.assetId, type: input.type } },
      create: { datasetId: input.datasetId, assetId: input.assetId, userId: input.userId, type: input.type, assignedById: actor.id },
      update: { userId: input.userId, assignedById: actor.id },
      select: { id: true, userId: true, type: true },
    });
    if (input.type === AssetAssignmentType.ANNOTATION) {
      await tx.asset.update({ where: { id: asset.id }, data: { assignedToId: input.userId } });
    }
    const event = await tx.assetAssignmentEvent.create({
      data: {
        datasetId: input.datasetId, assetId: input.assetId, assignmentId: assignment.id,
        action: existing ? AssetAssignmentEventAction.REASSIGNED : AssetAssignmentEventAction.ASSIGNED,
        previousUserId: existing?.userId ?? null, nextUserId: input.userId, actorId: actor.id,
      }, select: { id: true },
    });
    const notification = await createDurableNotification(tx, {
      userId: input.userId, actorId: actor.id,
      type: input.type === AssetAssignmentType.ANNOTATION ? NotificationType.ASSET_ASSIGNED : NotificationType.REVIEW_ASSIGNED,
      datasetId: input.datasetId, assetId: input.assetId,
      title: input.type === AssetAssignmentType.ANNOTATION ? "Annotation assigned" : "Review assigned",
      body: input.type === AssetAssignmentType.ANNOTATION ? "You were assigned annotation work." : "You were assigned review work.",
      dedupeKey: `assignment-event:${event.id}:${input.userId}`,
    });
    const outboxJobIds = await assignmentOutbox(tx, {
      datasetId: input.datasetId, assetId: input.assetId, actorId: actor.id, recipientUserId: input.userId, eventId: event.id, type: input.type,
      notificationId: notification.kind === "stored" ? notification.notification.id : undefined,
    });
    return { assignmentId: assignment.id, type: assignment.type, userId: assignment.userId, reused: false, outboxJobIds };
  });
}

export async function removeAssetAssignment(actor: RequestActor, input: { datasetId: string; assetId: string; type: AssetAssignmentType }) {
  return runCollaborationTransaction(async (tx) => {
    await requireAssignmentManager(tx, actor, input.datasetId);
    const asset = await requireAsset(tx, input.datasetId, input.assetId);
    const existing = await tx.assetAssignment.findUnique({ where: { assetId_type: { assetId: input.assetId, type: input.type } }, select: { id: true, userId: true } });
    if (!existing) return { removed: false, reused: true, outboxJobIds: [] };
    await tx.assetAssignment.delete({ where: { id: existing.id } });
    if (input.type === AssetAssignmentType.ANNOTATION && asset.assignedToId === existing.userId) {
      await tx.asset.update({ where: { id: asset.id }, data: { assignedToId: null } });
    }
    const event = await tx.assetAssignmentEvent.create({
      data: { datasetId: input.datasetId, assetId: input.assetId, assignmentId: existing.id, action: AssetAssignmentEventAction.UNASSIGNED, previousUserId: existing.userId, actorId: actor.id },
      select: { id: true },
    });
    const outbox = await createOrReuseCollaborationOutboxEvent(tx, {
      datasetId: input.datasetId, assetId: input.assetId, actorId: actor.id, recipientUserId: existing.userId,
      type: CollaborationOutboxEventType.ASSIGNMENT_CHANGED, dedupeKey: `assignment-event:${event.id}`,
      payload: { event: "assignment_unassigned", assignmentType: input.type, assetId: input.assetId },
    });
    return { removed: true, reused: false, outboxJobIds: uniqueJobIds(outbox) };
  });
}
