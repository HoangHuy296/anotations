import "server-only";
import { AssetAssignmentType, DatasetMemberRole, UserRole } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";

export type DatasetPermission = "dataset.read" | "dataset.update" | "dataset.delete" | "member.manage" | "asset.upload" | "asset.delete" | "label.manage" | "annotation.create" | "annotation.updateOwn" | "annotation.updateAny" | "annotation.review" | "workflow.submit" | "workflow.review" | "repository.sync" | "job.createExport" | "job.cancel" | "job.retry";
export const DATASET_ROLE_PERMISSIONS: Record<DatasetMemberRole, readonly (DatasetPermission | "*")[]> = {
  OWNER: ["*"], MANAGER: ["dataset.read", "dataset.update", "member.manage", "asset.upload", "asset.delete", "label.manage", "annotation.create", "annotation.updateOwn", "annotation.updateAny", "annotation.review", "workflow.submit", "workflow.review", "repository.sync", "job.createExport", "job.cancel", "job.retry"], REVIEWER: ["dataset.read", "annotation.create", "annotation.updateOwn", "annotation.updateAny", "annotation.review", "workflow.review", "job.createExport"], LABELER: ["dataset.read", "annotation.create", "annotation.updateOwn", "workflow.submit"],
};
export function canCreateDataset(actor: RequestActor) { return actor.role === UserRole.ADMIN || actor.role === UserRole.MANAGER; }
export async function requireDatasetPermission(actor: RequestActor, datasetId: string, permission: DatasetPermission, client: Pick<typeof db, "dataset"> = db) {
  const isSystemAdmin = actor.role === UserRole.ADMIN;
  const dataset = await client.dataset.findFirst({ where: { id: datasetId, deletedAt: null, archivedAt: null, ...(isSystemAdmin ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }) }, select: { id: true, ownerId: true, members: { where: { userId: actor.id }, select: { role: true } } } });
  if (!dataset) return null;
  if (isSystemAdmin) return { dataset, role: DatasetMemberRole.OWNER, isSystemAdmin: true, forbidden: false } as const;
  const role = dataset.ownerId === actor.id ? DatasetMemberRole.OWNER : dataset.members[0]?.role;
  if (!role || !(DATASET_ROLE_PERMISSIONS[role].includes("*") || DATASET_ROLE_PERMISSIONS[role].includes(permission))) return { dataset: null, forbidden: true } as const;
  return { dataset, role, isSystemAdmin: false, forbidden: false } as const;
}
export async function assertAnnotationPermission(actor: RequestActor, datasetId: string, permission: "annotation.create" | "annotation.updateOwn" | "annotation.updateAny" | "annotation.review") {
  return requireDatasetPermission(actor, datasetId, permission);
}

/** Collaboration rules are additive helpers. They never relax the existing
 * DatasetPermission check used by current routes. */
export function isDatasetCollaborationManager(role: DatasetMemberRole) {
  return role === DatasetMemberRole.OWNER || role === DatasetMemberRole.MANAGER;
}

export function canManageDatasetMemberRole(actorRole: DatasetMemberRole, targetRole: DatasetMemberRole) {
  if (actorRole === DatasetMemberRole.OWNER) return targetRole !== DatasetMemberRole.OWNER;
  return actorRole === DatasetMemberRole.MANAGER && (targetRole === DatasetMemberRole.LABELER || targetRole === DatasetMemberRole.REVIEWER);
}

export function isEligibleAssignmentTarget(role: DatasetMemberRole, type: AssetAssignmentType) {
  return (type === AssetAssignmentType.ANNOTATION && role === DatasetMemberRole.LABELER)
    || (type === AssetAssignmentType.REVIEW && role === DatasetMemberRole.REVIEWER);
}

export async function requireDatasetCollaborationManager(actor: RequestActor, datasetId: string) {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return access;
  return isDatasetCollaborationManager(access.role) ? access : { dataset: null, forbidden: true } as const;
}

export async function requireEligibleDatasetAssignmentTarget(datasetId: string, userId: string, type: AssetAssignmentType) {
  const member = await db.datasetMember.findUnique({
    where: { datasetId_userId: { datasetId, userId } },
    select: { role: true },
  });
  return member && isEligibleAssignmentTarget(member.role, type) ? member : null;
}

export async function requireOwnedSourceConnection(actor: RequestActor, id: string) {
  return db.sourceConnection.findFirst({
    where: { id, ...(actor.role === UserRole.ADMIN ? {} : { userId: actor.id }), provider: "GITEA", status: "ACTIVE", revokedAt: null, OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: new Date() } }] },
    select: { id: true, userId: true, provider: true, baseUrl: true, tokenEncrypted: true, status: true, tokenExpiresAt: true },
  });
}

/** Resolves a connection selected by an already-authorized dataset without exposing it to a browser. */
export async function resolveDatasetSourceConnection(datasetId: string) {
  return db.dataset.findFirst({
    where: { id: datasetId, deletedAt: null, archivedAt: null },
    select: {
      sourceConnection: {
        where: { provider: "GITEA", status: "ACTIVE", revokedAt: null },
        select: { id: true, baseUrl: true, tokenEncrypted: true },
      },
    },
  });
}
export async function requireAssetInDataset(datasetId: string, assetId: string) { return db.asset.findFirst({ where: { id: assetId, datasetId, deletedAt: null } }); }
export async function validateAnnotationReferences(datasetId: string, assetId: string, assetVersionId?: string | null, labelId?: string | null) {
  const asset = await requireAssetInDataset(datasetId, assetId);
  if (!asset) return false;
  if (assetVersionId) {
    const version = await db.assetVersion.findFirst({ where: { id: assetVersionId, assetId, datasetId }, select: { id: true } });
    if (!version) return false;
  }
  if (labelId) {
    const label = await db.label.findFirst({ where: { id: labelId, datasetId }, select: { id: true } });
    if (!label) return false;
  }
  return true;
}
