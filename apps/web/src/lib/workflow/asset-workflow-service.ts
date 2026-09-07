import "server-only";

import { AssetStatus, AssetWorkflowAction, CollaborationOutboxEventType, NotificationType, Prisma } from "@internal/db";
import { logAssetWorkflowEvent } from "@annotationplatform/domain";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission, type DatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { createOrReuseCollaborationOutboxEvent, enqueueCollaborationOutboxDispatch } from "@/lib/collaboration/collaboration-outbox-service";
import { createDurableNotification } from "@/lib/collaboration/notification-service";
import type { AssetWorkflowActionRequest } from "@/lib/validation/asset-workflow";

const assetSelect = { id: true, status: true, revision: true } as const;
const eventSelect = {
  id: true, action: true, fromStatus: true, toStatus: true, assetRevision: true, feedback: true, createdAt: true,
  actor: { select: { id: true, name: true, email: true } },
} as const;

export type SafeWorkflowAsset = { id: string; status: AssetStatus; revision: number };
export type WorkflowFailure =
  | { kind: "NOT_FOUND" }
  | { kind: "FORBIDDEN" }
  | { kind: "STALE_REVISION"; currentRevision: number }
  | { kind: "INVALID_TRANSITION" };

type Transition = { permission: DatasetPermission; from: readonly AssetStatus[]; to: AssetStatus | null };
const transitions: Record<AssetWorkflowAction, Transition> = {
  START: { permission: "workflow.submit", from: [AssetStatus.NEW, AssetStatus.READY], to: AssetStatus.IN_PROGRESS },
  SUBMIT: { permission: "workflow.submit", from: [AssetStatus.IN_PROGRESS], to: AssetStatus.NEEDS_REVIEW },
  RESUBMIT: { permission: "workflow.submit", from: [AssetStatus.IN_PROGRESS], to: AssetStatus.NEEDS_REVIEW },
  OPEN_REVIEW: { permission: "workflow.review", from: [AssetStatus.NEEDS_REVIEW], to: null },
  APPROVE: { permission: "workflow.review", from: [AssetStatus.NEEDS_REVIEW], to: AssetStatus.REVIEWED },
  REJECT: { permission: "workflow.review", from: [AssetStatus.NEEDS_REVIEW], to: AssetStatus.REJECTED },
  START_REWORK: { permission: "workflow.submit", from: [AssetStatus.REJECTED], to: AssetStatus.IN_PROGRESS },
};

async function createWorkflowNotificationIntents(tx: Prisma.TransactionClient, input: { datasetId: string; assetId: string; actorId: string; eventId: string; action: AssetWorkflowAction }) {
  if (input.action !== AssetWorkflowAction.SUBMIT && input.action !== AssetWorkflowAction.RESUBMIT && input.action !== AssetWorkflowAction.APPROVE && input.action !== AssetWorkflowAction.REJECT) return [];
  const assignmentType = input.action === AssetWorkflowAction.SUBMIT || input.action === AssetWorkflowAction.RESUBMIT ? "REVIEW" : "ANNOTATION";
  const assignments = await tx.assetAssignment.findMany({ where: { datasetId: input.datasetId, assetId: input.assetId, type: assignmentType }, select: { userId: true } });
  const fallback = assignments.length ? [] : await tx.datasetMember.findMany({ where: { datasetId: input.datasetId, role: assignmentType === "REVIEW" ? "REVIEWER" : "LABELER" }, select: { userId: true } });
  const type = input.action === AssetWorkflowAction.APPROVE ? NotificationType.REVIEW_APPROVED : input.action === AssetWorkflowAction.REJECT ? NotificationType.REVIEW_REJECTED : NotificationType.REVIEW_SUBMITTED;
  const title = type === NotificationType.REVIEW_SUBMITTED ? "Asset submitted for review" : type === NotificationType.REVIEW_APPROVED ? "Review approved" : "Review rejected";
  const jobs: string[] = [];
  for (const recipient of [...new Set([...assignments, ...fallback].map((item) => item.userId))]) {
    const notification = await createDurableNotification(tx, { userId: recipient, actorId: input.actorId, type, datasetId: input.datasetId, assetId: input.assetId, title, body: "Workflow activity requires your attention.", dedupeKey: `workflow:${input.eventId}:${recipient}` });
    if (notification.kind === "stored") jobs.push((await createOrReuseCollaborationOutboxEvent(tx, { datasetId: input.datasetId, assetId: input.assetId, actorId: input.actorId, recipientUserId: recipient, type: CollaborationOutboxEventType.NOTIFICATION_CREATED, dedupeKey: `notification:workflow:${input.eventId}:${recipient}`, payload: { notificationId: notification.notification.id } })).jobId);
  }
  return jobs;
}

export async function enqueueWorkflowDispatches(result: { outboxJobIds?: string[] }) {
  await Promise.all((result.outboxJobIds ?? []).map((jobId) => enqueueCollaborationOutboxDispatch(jobId)));
}

/**
 * Claims the parent content revision before an annotation writer touches a
 * child row. The caller must use this inside its existing transaction, so a
 * failed child optimistic-lock write also rolls back the parent increment.
 */
export async function claimEditableAssetContent(tx: Prisma.TransactionClient, assetId: string, datasetId: string) {
  const claimed = await tx.asset.updateMany({
    where: {
      id: assetId,
      datasetId,
      deletedAt: null,
      archivedAt: null,
      status: { notIn: [AssetStatus.NEEDS_REVIEW, AssetStatus.REVIEWED, AssetStatus.REJECTED] },
    },
    data: { revision: { increment: 1 } },
  });
  return claimed.count === 1;
}

/** Signals a rejected editable-content transaction without committing its parent revision claim. */
export class AssetContentWriteConflict extends Error {
  constructor() { super("ASSET_CONTENT_WRITE_CONFLICT"); }
}

export function isAssetContentWriteConflict(error: unknown): error is AssetContentWriteConflict {
  return error instanceof AssetContentWriteConflict;
}

/**
 * The only transaction wrapper annotation writers should use when they need
 * to invalidate review content. A failed child optimistic-lock condition must
 * throw `AssetContentWriteConflict`, which rolls back the preceding Asset
 * revision claim as part of this same transaction.
 */
export async function mutateEditableAssetContent<T>(assetId: string, datasetId: string, mutation: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async (tx) => {
    if (!(await claimEditableAssetContent(tx, assetId, datasetId))) throw new AssetContentWriteConflict();
    return mutation(tx);
  });
}

export async function getAssetWorkflow(actor: RequestActor, datasetId: string, assetId: string) {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access) return { ok: false as const, failure: { kind: "NOT_FOUND" } as const };
  if (access.forbidden) return { ok: false as const, failure: { kind: "FORBIDDEN" } as const };

  const asset = await db.asset.findFirst({ where: { id: assetId, datasetId, deletedAt: null }, select: assetSelect });
  if (!asset) return { ok: false as const, failure: { kind: "NOT_FOUND" } as const };
  const history = await db.assetWorkflowEvent.findMany({ where: { assetId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: eventSelect });
  return { ok: true as const, asset, history };
}

/**
 * Applies exactly one server-derived transition. The conditional Asset update
 * is the concurrency boundary: a stale reviewer cannot create an event.
 */
export async function applyAssetWorkflowAction(actor: RequestActor, datasetId: string, assetId: string, input: AssetWorkflowActionRequest) {
  const transition = transitions[input.action];
  const access = await requireDatasetPermission(actor, datasetId, transition.permission);
  if (!access) return { ok: false as const, failure: { kind: "NOT_FOUND" } as const };
  if (access.forbidden) return { ok: false as const, failure: { kind: "FORBIDDEN" } as const };

  const result = await db.$transaction(async (tx) => {
    const asset = await tx.asset.findFirst({ where: { id: assetId, datasetId, deletedAt: null }, select: assetSelect });
    if (!asset) return { ok: false as const, failure: { kind: "NOT_FOUND" } as const };

    // Revision wins over source-state validation: this keeps stale decisions
    // unambiguously stale even if another transition changed the status too.
    if (input.action !== AssetWorkflowAction.OPEN_REVIEW && asset.revision !== input.expectedRevision) {
      return { ok: false as const, failure: { kind: "STALE_REVISION", currentRevision: asset.revision } as const };
    }
    if (!transition.from.includes(asset.status)) return { ok: false as const, failure: { kind: "INVALID_TRANSITION" } as const };

    if (transition.to === null) {
      const event = await tx.assetWorkflowEvent.create({
        data: { assetId, actorId: actor.id, action: input.action, fromStatus: asset.status, toStatus: null, assetRevision: asset.revision },
        select: eventSelect,
      });
      return { ok: true as const, asset, event, outboxJobIds: [] };
    }

    const updated = await tx.asset.updateMany({
      where: { id: assetId, datasetId, deletedAt: null, status: asset.status, revision: input.expectedRevision },
      data: { status: transition.to, revision: { increment: 1 } },
    });
    if (updated.count !== 1) {
      const current = await tx.asset.findFirst({ where: { id: assetId, datasetId, deletedAt: null }, select: assetSelect });
      if (!current) return { ok: false as const, failure: { kind: "NOT_FOUND" } as const };
      if (current.revision !== input.expectedRevision) return { ok: false as const, failure: { kind: "STALE_REVISION", currentRevision: current.revision } as const };
      return { ok: false as const, failure: { kind: "INVALID_TRANSITION" } as const };
    }

    const nextAsset: SafeWorkflowAsset = { id: asset.id, status: transition.to, revision: asset.revision + 1 };
    const event = await tx.assetWorkflowEvent.create({
      data: { assetId, actorId: actor.id, action: input.action, fromStatus: asset.status, toStatus: transition.to, assetRevision: nextAsset.revision, feedback: input.action === AssetWorkflowAction.REJECT ? input.feedback : null },
      select: eventSelect,
    });
    return { ok: true as const, asset: nextAsset, event, outboxJobIds: await createWorkflowNotificationIntents(tx, { datasetId, assetId, actorId: actor.id, eventId: event.id, action: input.action }) };
  });
  if (result.ok) {
    logAssetWorkflowEvent("asset_workflow_action", {
      actorId: actor.id,
      datasetId,
      assetId,
      action: result.event.action,
      fromStatus: result.event.fromStatus,
      toStatus: result.event.toStatus,
      assetRevision: result.event.assetRevision,
    });
  }
  return result;
}
