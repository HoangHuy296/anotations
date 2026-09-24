import "server-only";

import { LabelScope, Modality, Prisma } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { labelMetadataSelect } from "@/lib/dataset-metadata";
import { normalizeLabelName, type TextEligibilityField } from "@/lib/validation/label";
import { runGuardedTextDatasetCommand, rejectTextCommand, type TextCommandFailure } from "@/lib/annotations/text-command-service";
import { dispatchTextPolicyChangedOutboxEvent, enqueueCollaborationOutboxDispatch } from "@/lib/collaboration/collaboration-outbox-service";

const DEFAULT_IMAGE_LABELS = [
  { name: "object", color: "#0EA5E9" },
  { name: "person", color: "#8B5CF6" },
  { name: "vehicle", color: "#F59E0B" },
  { name: "animal", color: "#10B981" },
  { name: "text", color: "#E11D48" },
  { name: "aidetect", color: "#ff99fc" },
] as const;

export async function ensureDefaultImageLabels(actor: RequestActor, datasetId: string) {
  // A dataset's baseline taxonomy is reference data, not a label-management
  // mutation requested by the user. Any authorized reader must be able to
  // see the same defaults in `/labels` and the workspace Labels tab; creation
  // remains dataset-scoped and idempotent.
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access) return { ok: false as const, status: 404 as const };
  if (access.forbidden) return { ok: false as const, status: 403 as const };
  const created = await db.label.createMany({
    data: DEFAULT_IMAGE_LABELS.map((label) => ({ datasetId, modality: Modality.IMAGE, name: label.name, normalizedName: normalizeLabelName(label.name), color: label.color })),
    skipDuplicates: true,
  });
  return { ok: true as const, created: created.count };
}

export async function deleteUnreferencedLabel(actor: RequestActor, labelId: string) {
  const label = await db.label.findFirst({ where: { id: labelId }, select: { id: true, datasetId: true, _count: { select: { annotations: true } } } });
  if (!label) return { ok: false as const, status: 404 as const };
  const access = await requireDatasetPermission(actor, label.datasetId, "label.manage");
  if (!access) return { ok: false as const, status: 404 as const };
  if (access.forbidden) return { ok: false as const, status: 403 as const };
  if (label._count.annotations > 0) return { ok: false as const, status: 409 as const };
  const deleted = await db.label.deleteMany({ where: { id: label.id, annotations: { none: {} } } });
  return deleted.count === 1 ? { ok: true as const } : { ok: false as const, status: 409 as const };
}

export { DEFAULT_IMAGE_LABELS };

/**
 * TEXT eligibility scope (025-text-workspace-engine, T040/T041): the single
 * write path every label-mutation entry point (the generic `/api/labels/
 * [labelId]` PATCH, the generic `/api/datasets/[datasetId]/labels` POST, and
 * the `/labels` page's server actions) uses, so eligibility validation and
 * the dataset-only guard live in exactly one place. Reuses the existing
 * generic `Label.modality`/`Label.scope` columns — no new schema.
 */

type SafeLabel = Prisma.LabelGetPayload<{ select: typeof labelMetadataSelect }>;
export type LabelWriteFailure = TextCommandFailure;
export type LabelWriteResult = { ok: true; label: SafeLabel } | { ok: false; reason: LabelWriteFailure };

/** `undefined`/`""` = no change requested; "NONE" = explicit clear back to the universal default. */
function resolveTextEligibilityTarget(eligibility: TextEligibilityField): { modality: Modality | null; scope: LabelScope } | null {
  if (eligibility === undefined || eligibility === "") return null;
  if (eligibility === "NONE") return { modality: null, scope: LabelScope.OBJECT };
  return { modality: Modality.TEXT, scope: eligibility as LabelScope };
}

export async function createLabelWithTextEligibility(actor: RequestActor, input: {
  datasetId: string; name: string; color: string; description: string | null; hotkey: string | null; textEligibility: TextEligibilityField;
}): Promise<LabelWriteResult> {
  const access = await requireDatasetPermission(actor, input.datasetId, "label.manage");
  if (!access) return { ok: false, reason: "NOT_FOUND" };
  if (access.forbidden) return { ok: false, reason: "FORBIDDEN" };

  const target = resolveTextEligibilityTarget(input.textEligibility) ?? { modality: null, scope: LabelScope.OBJECT };
  const data = { datasetId: input.datasetId, name: input.name, normalizedName: normalizeLabelName(input.name), color: input.color, description: input.description, hotkey: input.hotkey, modality: target.modality, scope: target.scope };

  // A plain (non-TEXT) create never claims the TEXT dataset guard, so
  // ordinary IMAGE/VIDEO/AUDIO label creation is never serialized against it.
  if (input.textEligibility === undefined || input.textEligibility === "NONE") {
    try {
      return { ok: true, label: await db.label.create({ data, select: labelMetadataSelect }) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { ok: false, reason: "DUPLICATE_NAME" };
      throw error;
    }
  }

  const outcome = await runGuardedTextDatasetCommand(actor, { datasetId: input.datasetId, permission: "label.manage" }, async (tx, ctx) => {
    let label: SafeLabel;
    try {
      label = await tx.label.create({ data, select: labelMetadataSelect });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") rejectTextCommand("DUPLICATE_NAME");
      throw error;
    }
    const dataset = await tx.dataset.update({ where: { id: ctx.datasetId }, data: { textPolicyRevision: { increment: 1 } }, select: { textPolicyRevision: true } });
    const dispatched = await dispatchTextPolicyChangedOutboxEvent(tx, { datasetId: ctx.datasetId, actorId: ctx.actorId, policyRevision: dataset.textPolicyRevision });
    return { label, outboxJobId: dispatched.jobId };
  });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  await enqueueCollaborationOutboxDispatch(outcome.result.outboxJobId);
  return { ok: true, label: outcome.result.label };
}

export async function updateLabelWithTextEligibility(actor: RequestActor, input: {
  labelId: string; datasetId: string; name: string; color: string; description: string | null; hotkey: string | null; textEligibility: TextEligibilityField;
}): Promise<LabelWriteResult> {
  const current = await db.label.findFirst({ where: { id: input.labelId, datasetId: input.datasetId }, select: { id: true, modality: true, scope: true, _count: { select: { annotations: true } } } });
  if (!current) return { ok: false, reason: "NOT_FOUND" };
  const access = await requireDatasetPermission(actor, input.datasetId, "label.manage");
  if (!access) return { ok: false, reason: "NOT_FOUND" };
  if (access.forbidden) return { ok: false, reason: "FORBIDDEN" };

  const target = resolveTextEligibilityTarget(input.textEligibility);
  const changesScope = target !== null && (target.modality !== current.modality || target.scope !== current.scope);
  // Block deletion or ineligible scope changes of referenced labels
  // (data-model.md "Dataset taxonomy policy"): a label already used by any
  // annotation is locked to its current modality/scope.
  if (changesScope && current._count.annotations > 0) return { ok: false, reason: "REFERENCED_SCOPE_LOCKED" };

  const data = {
    name: input.name, normalizedName: normalizeLabelName(input.name), color: input.color, description: input.description, hotkey: input.hotkey,
    ...(target ? { modality: target.modality, scope: target.scope } : {}),
  };

  if (!changesScope) {
    try {
      const updated = await db.label.updateMany({ where: { id: input.labelId, datasetId: input.datasetId }, data });
      if (updated.count !== 1) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, label: await db.label.findUniqueOrThrow({ where: { id: input.labelId }, select: labelMetadataSelect }) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { ok: false, reason: "DUPLICATE_NAME" };
      throw error;
    }
  }

  const outcome = await runGuardedTextDatasetCommand(actor, { datasetId: input.datasetId, permission: "label.manage" }, async (tx, ctx) => {
    let updated;
    try {
      updated = await tx.label.updateMany({ where: { id: input.labelId, datasetId: ctx.datasetId }, data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") rejectTextCommand("DUPLICATE_NAME");
      throw error;
    }
    if (updated.count !== 1) rejectTextCommand("NOT_FOUND");
    const label = await tx.label.findUniqueOrThrow({ where: { id: input.labelId }, select: labelMetadataSelect });
    const dataset = await tx.dataset.update({ where: { id: ctx.datasetId }, data: { textPolicyRevision: { increment: 1 } }, select: { textPolicyRevision: true } });
    const dispatched = await dispatchTextPolicyChangedOutboxEvent(tx, { datasetId: ctx.datasetId, actorId: ctx.actorId, policyRevision: dataset.textPolicyRevision });
    return { label, outboxJobId: dispatched.jobId };
  });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  await enqueueCollaborationOutboxDispatch(outcome.result.outboxJobId);
  return { ok: true, label: outcome.result.label };
}
