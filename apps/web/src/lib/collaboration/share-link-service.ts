import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { CollaborationOutboxEventType, DatasetMemberRole, DatasetMembershipEventAction, NotificationType, Prisma } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { createOrReuseCollaborationOutboxEvent, runCollaborationTransaction } from "@/lib/collaboration/collaboration-outbox-service";
import { createMembershipOutbox, mergeJobIds, recordMembershipEvent } from "@/lib/collaboration/dataset-membership-service";
import { createDurableNotification } from "@/lib/collaboration/notification-service";

/** Safety cap so one dataset cannot accumulate unbounded live bearer links. */
export const MAX_ACTIVE_SHARE_LINKS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ShareLinkError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "FORBIDDEN" | "LIMIT" | "INVALID_LINK", message: string) {
    super(message);
  }
}

/** Only the hash is stored; the raw token is returned exactly once, at creation. */
export function hashShareToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type ShareLinkState = "ACTIVE" | "EXPIRED" | "REVOKED" | "EXHAUSTED";

export function shareLinkState(link: { revokedAt: Date | null; expiresAt: Date; maxUses: number | null; useCount: number }, now = new Date()): ShareLinkState {
  if (link.revokedAt) return "REVOKED";
  if (link.expiresAt <= now) return "EXPIRED";
  if (link.maxUses !== null && link.useCount >= link.maxUses) return "EXHAUSTED";
  return "ACTIVE";
}

const safeLinkSelect = { id: true, role: true, expiresAt: true, maxUses: true, useCount: true, revokedAt: true, createdAt: true, createdBy: { select: { name: true, email: true } } } as const;
type SafeLinkRow = Prisma.DatasetShareLinkGetPayload<{ select: typeof safeLinkSelect }>;

function toSafeLink(row: SafeLinkRow, now = new Date()) {
  return {
    id: row.id, role: row.role, expiresAt: row.expiresAt.toISOString(), maxUses: row.maxUses, useCount: row.useCount,
    revokedAt: row.revokedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), state: shareLinkState(row, now),
    createdByName: row.createdBy.name ?? row.createdBy.email,
  };
}

async function requireShareManager(actor: RequestActor, datasetId: string) {
  const access = await requireDatasetPermission(actor, datasetId, "member.manage");
  if (!access) throw new ShareLinkError("NOT_FOUND", "The dataset was not found.");
  if (access.forbidden) throw new ShareLinkError("FORBIDDEN", "You do not have permission to share this dataset.");
  return access;
}

export async function createDatasetShareLink(actor: RequestActor, input: { datasetId: string; expiresInDays: number; maxUses: number | null }) {
  await requireShareManager(actor, input.datasetId);
  const now = new Date();
  const active = await db.datasetShareLink.count({
    where: { datasetId: input.datasetId, revokedAt: null, expiresAt: { gt: now } },
  });
  if (active >= MAX_ACTIVE_SHARE_LINKS) throw new ShareLinkError("LIMIT", `A dataset can have at most ${MAX_ACTIVE_SHARE_LINKS} active share links. Revoke one first.`);
  const token = randomBytes(32).toString("base64url");
  const row = await db.datasetShareLink.create({
    data: {
      datasetId: input.datasetId, createdById: actor.id, role: DatasetMemberRole.LABELER, tokenHash: hashShareToken(token),
      expiresAt: new Date(now.getTime() + input.expiresInDays * DAY_MS), maxUses: input.maxUses,
    },
    select: safeLinkSelect,
  });
  return { link: toSafeLink(row, now), token };
}

export async function listDatasetShareLinks(actor: RequestActor, datasetId: string) {
  await requireShareManager(actor, datasetId);
  const now = new Date();
  const rows = await db.datasetShareLink.findMany({
    where: { datasetId, OR: [{ revokedAt: null }, { createdAt: { gt: new Date(now.getTime() - 30 * DAY_MS) } }] },
    orderBy: { createdAt: "desc" }, take: 25, select: safeLinkSelect,
  });
  return rows.map((row) => toSafeLink(row, now));
}

export async function revokeDatasetShareLink(actor: RequestActor, input: { datasetId: string; linkId: string }) {
  await requireShareManager(actor, input.datasetId);
  const revoked = await db.datasetShareLink.updateMany({ where: { id: input.linkId, datasetId: input.datasetId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (revoked.count === 0) {
    const exists = await db.datasetShareLink.findFirst({ where: { id: input.linkId, datasetId: input.datasetId }, select: { id: true } });
    if (!exists) throw new ShareLinkError("NOT_FOUND", "The share link was not found.");
  }
  return { revoked: true as const };
}

/**
 * Read-only description of what a token would join, for the join page. Unknown, expired, revoked
 * and exhausted links all collapse into the same `null` so the page cannot be used to probe tokens.
 */
export async function previewShareLink(actor: RequestActor, token: string) {
  const link = await db.datasetShareLink.findUnique({
    where: { tokenHash: hashShareToken(token) },
    select: { id: true, role: true, expiresAt: true, maxUses: true, useCount: true, revokedAt: true, dataset: { select: { id: true, name: true, ownerId: true, deletedAt: true, archivedAt: true, owner: { select: { name: true, email: true } }, members: { where: { userId: actor.id }, select: { id: true } } } } },
  });
  if (!link || link.dataset.deletedAt || link.dataset.archivedAt || shareLinkState(link) !== "ACTIVE") return null;
  const alreadyMember = link.dataset.ownerId === actor.id || link.dataset.members.length > 0;
  return { datasetId: link.dataset.id, datasetName: link.dataset.name, ownerName: link.dataset.owner.name ?? link.dataset.owner.email, role: link.role, alreadyMember };
}

/**
 * Joins `actor` to the link's dataset. Idempotent for someone who is already a member or the owner
 * (no use is consumed and no role is ever changed). The use counter is claimed with a compare-and-swap on
 * `useCount`, so concurrent joins can never exceed `maxUses`.
 */
export async function acceptShareLink(actor: RequestActor, token: string) {
  const outcome = await runCollaborationTransaction(async (tx) => {
    const link = await tx.datasetShareLink.findUnique({
      where: { tokenHash: hashShareToken(token) },
      select: { id: true, datasetId: true, createdById: true, role: true, expiresAt: true, maxUses: true, useCount: true, revokedAt: true, dataset: { select: { name: true, ownerId: true, deletedAt: true, archivedAt: true } } },
    });
    if (!link || link.dataset.deletedAt || link.dataset.archivedAt) throw new ShareLinkError("INVALID_LINK", "This share link is not valid.");
    const alreadyMember = link.dataset.ownerId === actor.id
      || Boolean(await tx.datasetMember.findUnique({ where: { datasetId_userId: { datasetId: link.datasetId, userId: actor.id } }, select: { id: true } }));
    if (alreadyMember) return { datasetId: link.datasetId, alreadyMember: true as const, outboxJobIds: [] as string[] };
    if (shareLinkState(link) !== "ACTIVE") throw new ShareLinkError("INVALID_LINK", "This share link is not valid.");
    const claimed = await tx.datasetShareLink.updateMany({ where: { id: link.id, revokedAt: null, useCount: link.useCount }, data: { useCount: { increment: 1 } } });
    if (claimed.count !== 1) throw new ShareLinkError("INVALID_LINK", "This share link is not valid.");
    // A link can only ever grant LABELER, whatever the row says.
    const role = DatasetMemberRole.LABELER;
    await tx.datasetMember.create({ data: { datasetId: link.datasetId, userId: actor.id, role } });
    await recordMembershipEvent(tx, { datasetId: link.datasetId, memberUserId: actor.id, actorId: actor.id, action: DatasetMembershipEventAction.ACCEPTED, nextRole: role });
    const notification = await createDurableNotification(tx, {
      userId: link.createdById, actorId: actor.id, type: NotificationType.DATASET_INVITE, datasetId: link.datasetId,
      title: "Joined via share link", body: `${actor.name || actor.email} joined "${link.dataset.name}" as a labeler.`.slice(0, 500),
      dedupeKey: `share-link:${link.id}:joined:${actor.id}`,
    });
    const membershipOutbox = await createMembershipOutbox(tx, { datasetId: link.datasetId, actorId: actor.id, memberUserId: actor.id, event: "accepted" });
    const notificationOutbox = notification.kind === "stored" ? await createOrReuseCollaborationOutboxEvent(tx, {
      datasetId: link.datasetId, actorId: actor.id, recipientUserId: link.createdById, type: CollaborationOutboxEventType.NOTIFICATION_CREATED,
      dedupeKey: `notification:share-link:${link.id}:joined:${actor.id}`, payload: { notificationId: notification.notification.id },
    }) : undefined;
    return { datasetId: link.datasetId, alreadyMember: false as const, outboxJobIds: mergeJobIds(membershipOutbox, notificationOutbox) };
  });
  return outcome;
}

