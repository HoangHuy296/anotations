import "server-only";

import { z } from "zod";
import { serializeSafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";
import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireDatasetPermission } from "@/lib/authorization";
import { getTextSourceLimits } from "@/lib/config/text-source-limits";
import { TEXT_ENTITY_LABEL_SCOPES } from "@/lib/annotations/text-policy-service";

const cursorSchema = z.object({ after: z.string().min(1), revision: z.number().int().positive() }).strict();

export async function readTextAnnotationPage(actor: RequestActor, assetId: string, cursor?: string | null) {
  let position: z.infer<typeof cursorSchema> | null = null;
  if (cursor) {
    try { position = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
    catch { return { ok: false as const, reason: "INVALID_REQUEST" as const }; }
  }
  const limits = getTextSourceLimits();
  return db.$transaction(async (tx) => {
    const asset = await tx.asset.findFirst({ where: { id: assetId, modality: "TEXT", deletedAt: null, archivedAt: null }, select: { datasetId: true, revision: true, status: true, textAsset: { select: { sourceIdentity: true } } } });
    if (!asset) return { ok: false as const, reason: "NOT_FOUND" as const };
    const access = await requireDatasetPermission(actor, asset.datasetId, "dataset.read", tx);
    if (!access || access.forbidden) return { ok: false as const, reason: "NOT_FOUND" as const };
    if (position && position.revision !== asset.revision) return { ok: false as const, reason: "REVISION_STALE" as const };
    const createAccess = await requireDatasetPermission(actor, asset.datasetId, "annotation.create", tx);
    const [rows, count, policy, entityLabels] = await Promise.all([
      tx.annotation.findMany({ where: { assetId, modality: "TEXT", ...(position ? { id: { gt: position.after } } : {}) }, orderBy: { id: "asc" }, take: 201 }),
      tx.annotation.count({ where: { assetId, modality: "TEXT" } }),
      tx.dataset.findUniqueOrThrow({ where: { id: asset.datasetId }, select: { textPolicyRevision: true } }),
      tx.label.findMany({ where: { datasetId: asset.datasetId, scope: { in: [...TEXT_ENTITY_LABEL_SCOPES] }, OR: [{ modality: "TEXT" }, { modality: null }] }, orderBy: { name: "asc" }, select: { id: true, name: true, color: true } }),
    ]);
    const page = rows.slice(0, 200);
    return { ok: true as const, data: {
      assetRevision: asset.revision, sourceIdentity: asset.textAsset?.sourceIdentity ?? null, policyRevision: policy.textPolicyRevision,
      canCreate: Boolean(createAccess && !createAccess.forbidden) && !["NEEDS_REVIEW", "REVIEWED", "REJECTED"].includes(asset.status) && count < limits.maxAnnotations,
      entityLabels,
      annotations: page.map(serializeSafeTextAnnotation),
      nextCursor: rows.length > 200 ? Buffer.from(JSON.stringify({ after: page[page.length - 1].id, revision: asset.revision })).toString("base64url") : null,
      total: count,
    } };
  }, { isolationLevel: "RepeatableRead" });
}
