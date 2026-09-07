import "server-only";

import { NotificationType, Prisma } from "@internal/db";

import type { SafeNotificationContext } from "@/types/collaboration";
import type { RequestActor } from "@/lib/auth";
import { runCollaborationTransaction } from "@/lib/collaboration/collaboration-outbox-service";

type TransactionClient = Prisma.TransactionClient;

export type CreateNotificationInput = SafeNotificationContext & {
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  dedupeKey: string;
};

/**
 * Creates recipient state inside the caller's accepted domain transaction.
 * The composite unique constraint is the retry/replay proof; the actor never
 * receives a noisy self-notification.
 */
export async function createDurableNotification(tx: TransactionClient, input: CreateNotificationInput) {
  if (input.actorId && input.actorId === input.userId) return { kind: "suppressed" as const };
  const notification = await tx.notification.upsert({
    where: { userId_dedupeKey: { userId: input.userId, dedupeKey: input.dedupeKey } },
    create: {
      userId: input.userId,
      actorId: input.actorId ?? null,
      type: input.type,
      datasetId: input.datasetId ?? null,
      assetId: input.assetId ?? null,
      commentId: input.commentId ?? null,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 2_000),
      dedupeKey: input.dedupeKey,
    },
    update: {},
    select: { id: true, createdAt: true },
  });
  return { kind: "stored" as const, notification };
}

/** A navigation pointer only; the workspace independently re-authorizes it. */
export function buildSafeNotificationHref(context: SafeNotificationContext) {
  if (!context.datasetId || !context.assetId) return null;
  const query = new URLSearchParams({ image: context.assetId });
  if (context.commentId) query.set("discussion", context.commentId);
  return `/workspace/${context.datasetId}?${query.toString()}`;
}

function safeNotification(notification: {
  id: string; type: NotificationType; title: string; body: string; datasetId: string | null; assetId: string | null; commentId: string | null; readAt: Date | null; createdAt: Date; contextUnavailableAt: Date | null;
}) {
  const unavailable = Boolean(notification.contextUnavailableAt);
  return {
    id: notification.id,
    type: notification.type,
    title: unavailable ? "Notification unavailable" : notification.title,
    body: unavailable ? "The related item is no longer available." : notification.body,
    datasetId: unavailable ? null : notification.datasetId,
    assetId: unavailable ? null : notification.assetId,
    commentId: unavailable ? null : notification.commentId,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
    unavailable,
  };
}

/** Recipient-only durable history. Context is redacted if current access is gone. */
export async function listNotifications(actor: RequestActor, input: { cursor?: string; limit: number; type?: NotificationType; unreadOnly?: boolean }) {
  return runCollaborationTransaction(async (tx) => {
    const notifications = await tx.notification.findMany({
      where: { userId: actor.id, ...(input.type ? { type: input.type } : {}), ...(input.unreadOnly ? { readAt: null } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: { id: true, type: true, title: true, body: true, datasetId: true, assetId: true, commentId: true, readAt: true, createdAt: true, contextUnavailableAt: true },
    });
    const page = notifications.slice(0, input.limit);
    const contextDatasetIds = [...new Set(page.map((item) => item.datasetId).filter((id): id is string => Boolean(id)))];
    const accessible = new Set((await tx.dataset.findMany({ where: { id: { in: contextDatasetIds }, deletedAt: null, archivedAt: null, OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }, select: { id: true } })).map((dataset) => dataset.id));
    return { items: page.map((item) => safeNotification({ ...item, contextUnavailableAt: item.contextUnavailableAt ?? (item.datasetId && !accessible.has(item.datasetId) ? new Date() : null) })), nextCursor: notifications.length > input.limit ? page.at(-1)?.id ?? null : null, unreadCount: await tx.notification.count({ where: { userId: actor.id, readAt: null } }) };
  });
}

export async function markNotificationRead(actor: RequestActor, notificationId: string) {
  return runCollaborationTransaction(async (tx) => {
    const updated = await tx.notification.updateMany({ where: { id: notificationId, userId: actor.id, readAt: null }, data: { readAt: new Date() } });
    const exists = updated.count === 1 || await tx.notification.findFirst({ where: { id: notificationId, userId: actor.id }, select: { id: true } });
    if (!exists) return null;
    return { id: notificationId, read: true };
  });
}

export async function markAllNotificationsRead(actor: RequestActor) {
  return runCollaborationTransaction(async (tx) => {
    const updated = await tx.notification.updateMany({ where: { userId: actor.id, readAt: null }, data: { readAt: new Date() } });
    return { count: updated.count };
  });
}
