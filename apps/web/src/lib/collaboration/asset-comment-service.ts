import "server-only";

import { createHash } from "node:crypto";

import {
  CollaborationOutboxEventType,
  DatasetMemberRole,
  NotificationType,
  Prisma,
  UserRole,
} from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import {
  createOrReuseCollaborationOutboxEvent,
  enqueueCollaborationOutboxDispatch,
  runCollaborationTransaction,
} from "@/lib/collaboration/collaboration-outbox-service";
import { createDurableNotification } from "@/lib/collaboration/notification-service";

type TransactionClient = Prisma.TransactionClient;
type CommentErrorCode = "NOT_FOUND" | "FORBIDDEN" | "DEPTH";
type CommentMutationResult = { commentId: string; outboxJobIds: string[] };
type CommentTarget = { id: string; datasetId: string; assetId: string; authorId: string; parentId: string | null };

export class AssetCommentError extends Error {
  constructor(public readonly code: CommentErrorCode, message: string) {
    super(message);
  }
}

/** Enqueue only after the collaboration transaction has committed. */
export async function enqueueCommentDispatches(result: CommentMutationResult) {
  await Promise.all(result.outboxJobIds.map((jobId) => enqueueCollaborationOutboxDispatch(jobId)));
}

function extractMentionEmails(body: string) {
  return [...new Set([...body.matchAll(/@([\w.+-]+@[\w.-]+)/g)].map((match) => match[1]!.toLowerCase()))];
}

function contentKey(body: string) {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

async function requireDatasetAccess(tx: TransactionClient, actor: RequestActor, datasetId: string) {
  const dataset = await tx.dataset.findFirst({
    where: {
      id: datasetId,
      deletedAt: null,
      archivedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }),
    },
    select: { id: true, ownerId: true, members: { where: { userId: actor.id }, select: { role: true } } },
  });
  if (!dataset) throw new AssetCommentError("NOT_FOUND", "The dataset was not found.");
  const role = actor.role === UserRole.ADMIN || dataset.ownerId === actor.id ? DatasetMemberRole.OWNER : dataset.members[0]?.role;
  if (!role) throw new AssetCommentError("FORBIDDEN", "You do not have permission for this discussion action.");
  return { dataset, role };
}

async function requireAsset(tx: TransactionClient, datasetId: string, assetId: string) {
  const asset = await tx.asset.findFirst({ where: { id: assetId, datasetId, deletedAt: null, archivedAt: null }, select: { id: true } });
  if (!asset) throw new AssetCommentError("NOT_FOUND", "The asset was not found.");
}

async function createCommentOutbox(tx: TransactionClient, input: {
  datasetId: string; assetId: string; actorId: string; commentId: string;
  event: "created" | "updated" | "deleted" | "resolved" | "reopened"; version?: string;
}) {
  const eventKey = input.version ? `${input.event}:${input.version}` : input.event;
  const outbox = await createOrReuseCollaborationOutboxEvent(tx, {
    datasetId: input.datasetId,
    assetId: input.assetId,
    actorId: input.actorId,
    type: CollaborationOutboxEventType.COMMENT_CHANGED,
    dedupeKey: `comment:${input.commentId}:${eventKey}`,
    payload: { event: input.event, commentId: input.commentId },
  });
  return outbox.jobId;
}

async function findValidMentionUserIds(tx: TransactionClient, datasetId: string, emails: string[]) {
  if (emails.length === 0) return [];
  const dataset = await tx.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { ownerId: true } });
  const [members, owner] = await Promise.all([
    tx.datasetMember.findMany({ where: { datasetId, user: { email: { in: emails, mode: "insensitive" } } }, select: { userId: true } }),
    tx.user.findFirst({ where: { id: dataset.ownerId, email: { in: emails, mode: "insensitive" } }, select: { id: true } }),
  ]);
  return [...new Set([...members.map((member) => member.userId), owner?.id].filter(Boolean))] as string[];
}

async function createMentionNotification(tx: TransactionClient, input: {
  datasetId: string; assetId: string; commentId: string; actorId: string; userId: string;
}) {
  const notification = await createDurableNotification(tx, {
    userId: input.userId, actorId: input.actorId, type: NotificationType.MENTIONED,
    datasetId: input.datasetId, assetId: input.assetId, commentId: input.commentId,
    title: "You were mentioned", body: "You were mentioned in a discussion.",
    dedupeKey: `mention:${input.commentId}:${input.userId}`,
  });
  if (notification.kind !== "stored") return null;
  const outbox = await createOrReuseCollaborationOutboxEvent(tx, {
    datasetId: input.datasetId, assetId: input.assetId, actorId: input.actorId,
    recipientUserId: input.userId, type: CollaborationOutboxEventType.NOTIFICATION_CREATED,
    dedupeKey: `notification:mention:${input.commentId}:${input.userId}`,
    payload: { notificationId: notification.notification.id },
  });
  return outbox.jobId;
}

/** Synchronizes the durable recipient map; only newly-added valid mentions notify. */
async function synchronizeMentions(tx: TransactionClient, input: {
  datasetId: string; assetId: string; commentId: string; actorId: string; body: string; notifyNewMentions: boolean;
}) {
  const mentionedUserIds = await findValidMentionUserIds(tx, input.datasetId, extractMentionEmails(input.body));
  const desiredUserIds = mentionedUserIds.filter((userId) => userId !== input.actorId);
  const existing = await tx.commentMention.findMany({ where: { commentId: input.commentId }, select: { userId: true } });
  const existingUserIds = new Set(existing.map((mention) => mention.userId));
  if (desiredUserIds.length === 0) {
    await tx.commentMention.deleteMany({ where: { commentId: input.commentId } });
  } else {
    await tx.commentMention.deleteMany({ where: { commentId: input.commentId, userId: { notIn: desiredUserIds } } });
  }
  const addedUserIds = desiredUserIds.filter((userId) => !existingUserIds.has(userId));
  if (addedUserIds.length) {
    await tx.commentMention.createMany({ data: addedUserIds.map((userId) => ({ commentId: input.commentId, userId })), skipDuplicates: true });
  }
  if (!input.notifyNewMentions) return { mentionedUserIds, outboxJobIds: [] as string[] };
  const notificationJobs = await Promise.all(addedUserIds.map((userId) => createMentionNotification(tx, { ...input, userId })));
  return { mentionedUserIds, outboxJobIds: notificationJobs.filter((jobId): jobId is string => Boolean(jobId)) };
}

function assertMayModerateOrOwn(actorId: string, authorId: string, role: DatasetMemberRole) {
  if (actorId !== authorId && role !== DatasetMemberRole.OWNER && role !== DatasetMemberRole.MANAGER) {
    throw new AssetCommentError("FORBIDDEN", "You may only modify your own comment.");
  }
}

async function requireComment(tx: TransactionClient, commentId: string): Promise<CommentTarget> {
  const comment = await tx.assetComment.findUnique({
    where: { id: commentId },
    select: { id: true, datasetId: true, assetId: true, authorId: true, parentId: true },
  });
  if (!comment) throw new AssetCommentError("NOT_FOUND", "The comment was not found.");
  return comment;
}

export async function listAssetComments(actor: RequestActor, datasetId: string, assetId: string) {
  return runCollaborationTransaction(async (tx) => {
    await requireDatasetAccess(tx, actor, datasetId);
    await requireAsset(tx, datasetId, assetId);
    return tx.assetComment.findMany({
      where: { datasetId, assetId, parentId: null }, orderBy: { createdAt: "asc" },
      select: {
        id: true, body: true, authorId: true, createdAt: true, updatedAt: true, deletedAt: true, resolvedAt: true, resolvedById: true,
        author: { select: { name: true, email: true } },
        replies: { orderBy: { createdAt: "asc" }, select: { id: true, body: true, authorId: true, createdAt: true, updatedAt: true, deletedAt: true, author: { select: { name: true, email: true } } } },
      },
    });
  });
}

export async function createAssetComment(actor: RequestActor, input: { datasetId: string; assetId: string; body: string; parentId?: string }): Promise<CommentMutationResult> {
  return runCollaborationTransaction(async (tx) => {
    await requireDatasetAccess(tx, actor, input.datasetId);
    await requireAsset(tx, input.datasetId, input.assetId);
    let parent: Pick<CommentTarget, "id" | "authorId" | "parentId"> | null = null;
    if (input.parentId) {
      parent = await tx.assetComment.findFirst({ where: { id: input.parentId, datasetId: input.datasetId, assetId: input.assetId }, select: { id: true, authorId: true, parentId: true } });
      if (!parent) throw new AssetCommentError("NOT_FOUND", "The parent comment was not found.");
      if (parent.parentId) throw new AssetCommentError("DEPTH", "Replies can only target a root thread.");
    }
    const comment = await tx.assetComment.create({ data: { datasetId: input.datasetId, assetId: input.assetId, authorId: actor.id, parentId: parent?.id, body: input.body }, select: { id: true } });
    const mentions = await synchronizeMentions(tx, { ...input, commentId: comment.id, actorId: actor.id, notifyNewMentions: true });
    const jobs = [await createCommentOutbox(tx, { datasetId: input.datasetId, assetId: input.assetId, actorId: actor.id, commentId: comment.id, event: "created" }), ...mentions.outboxJobIds];
    if (parent && parent.authorId !== actor.id && !mentions.mentionedUserIds.includes(parent.authorId)) {
      const notification = await createDurableNotification(tx, {
        userId: parent.authorId, actorId: actor.id, type: NotificationType.COMMENT_REPLY,
        datasetId: input.datasetId, assetId: input.assetId, commentId: comment.id,
        title: "New discussion reply", body: "A discussion thread received a reply.",
        dedupeKey: `reply:${comment.id}:${parent.authorId}`,
      });
      if (notification.kind === "stored") {
        const outbox = await createOrReuseCollaborationOutboxEvent(tx, {
          datasetId: input.datasetId, assetId: input.assetId, actorId: actor.id, recipientUserId: parent.authorId,
          type: CollaborationOutboxEventType.NOTIFICATION_CREATED, dedupeKey: `notification:reply:${comment.id}:${parent.authorId}`,
          payload: { notificationId: notification.notification.id },
        });
        jobs.push(outbox.jobId);
      }
    }
    return { commentId: comment.id, outboxJobIds: [...new Set(jobs)] };
  });
}

export async function updateAssetComment(actor: RequestActor, commentId: string, body: string): Promise<CommentMutationResult> {
  return runCollaborationTransaction(async (tx) => {
    const comment = await requireComment(tx, commentId);
    const { role } = await requireDatasetAccess(tx, actor, comment.datasetId);
    assertMayModerateOrOwn(actor.id, comment.authorId, role);
    await tx.assetComment.update({ where: { id: comment.id }, data: { body } });
    const mentions = await synchronizeMentions(tx, { datasetId: comment.datasetId, assetId: comment.assetId, commentId: comment.id, actorId: actor.id, body, notifyNewMentions: true });
    return { commentId: comment.id, outboxJobIds: [await createCommentOutbox(tx, { datasetId: comment.datasetId, assetId: comment.assetId, actorId: actor.id, commentId: comment.id, event: "updated", version: contentKey(body) }), ...mentions.outboxJobIds] };
  });
}

export async function deleteAssetComment(actor: RequestActor, commentId: string): Promise<CommentMutationResult> {
  return runCollaborationTransaction(async (tx) => {
    const comment = await requireComment(tx, commentId);
    const { role } = await requireDatasetAccess(tx, actor, comment.datasetId);
    assertMayModerateOrOwn(actor.id, comment.authorId, role);
    await tx.assetComment.update({ where: { id: comment.id }, data: { deletedAt: new Date(), body: "" } });
    return { commentId: comment.id, outboxJobIds: [await createCommentOutbox(tx, { datasetId: comment.datasetId, assetId: comment.assetId, actorId: actor.id, commentId: comment.id, event: "deleted" })] };
  });
}

export async function resolveAssetComment(actor: RequestActor, commentId: string, resolved: boolean): Promise<CommentMutationResult> {
  return runCollaborationTransaction(async (tx) => {
    const comment = await requireComment(tx, commentId);
    const { role } = await requireDatasetAccess(tx, actor, comment.datasetId);
    const root = comment.parentId ? await tx.assetComment.findUnique({ where: { id: comment.parentId }, select: { id: true, authorId: true } }) : { id: comment.id, authorId: comment.authorId };
    if (!root) throw new AssetCommentError("NOT_FOUND", "The root discussion thread was not found.");
    if (actor.id !== comment.authorId && actor.id !== root.authorId && role !== DatasetMemberRole.OWNER && role !== DatasetMemberRole.MANAGER) {
      throw new AssetCommentError("FORBIDDEN", "You may not resolve this thread.");
    }
    await tx.assetComment.update({ where: { id: root.id }, data: resolved ? { resolvedAt: new Date(), resolvedById: actor.id } : { resolvedAt: null, resolvedById: null } });
    return { commentId: root.id, outboxJobIds: [await createCommentOutbox(tx, { datasetId: comment.datasetId, assetId: comment.assetId, actorId: actor.id, commentId: root.id, event: resolved ? "resolved" : "reopened" })] };
  });
}
