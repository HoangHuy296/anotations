import "server-only";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";

export type ActivityItem = { id: string; kind: "DISCUSSION" | "ASSIGNMENT" | "WORKFLOW"; action: string; actor: string | null; createdAt: string };

/** Read-only projection, deliberately not a new audit source or persistence model. */
export async function readAssetActivity(actor: RequestActor, datasetId: string, assetId: string): Promise<ActivityItem[] | null> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const asset = await db.asset.findFirst({ where: { id: assetId, datasetId, deletedAt: null, archivedAt: null }, select: { id: true } });
  if (!asset) return null;
  const [comments, assignments, workflow] = await Promise.all([
    db.assetComment.findMany({ where: { datasetId, assetId }, select: { id: true, createdAt: true, deletedAt: true, resolvedAt: true, author: { select: { name: true, email: true } } } }),
    db.assetAssignmentEvent.findMany({ where: { datasetId, assetId }, select: { id: true, action: true, createdAt: true, actor: { select: { name: true, email: true } } } }),
    db.assetWorkflowEvent.findMany({ where: { assetId }, select: { id: true, action: true, createdAt: true, actor: { select: { name: true, email: true } } } }),
  ]);
  return [
    ...comments.map((comment) => ({ id: `comment:${comment.id}`, kind: "DISCUSSION" as const, action: comment.deletedAt ? "COMMENT_DELETED" : comment.resolvedAt ? "THREAD_RESOLVED" : "COMMENT_CREATED", actor: comment.author.name ?? comment.author.email, createdAt: comment.createdAt.toISOString() })),
    ...assignments.map((event) => ({ id: `assignment:${event.id}`, kind: "ASSIGNMENT" as const, action: event.action, actor: event.actor ? event.actor.name ?? event.actor.email : null, createdAt: event.createdAt.toISOString() })),
    ...workflow.map((event) => ({ id: `workflow:${event.id}`, kind: "WORKFLOW" as const, action: event.action, actor: event.actor.name ?? event.actor.email, createdAt: event.createdAt.toISOString() })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}
