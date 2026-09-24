import "server-only";

import { z } from "zod";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { runGuardedTextDatasetCommand, rejectTextCommand, type TextCommandFailure } from "@/lib/annotations/text-command-service";
import { dispatchTextPolicyChangedOutboxEvent, enqueueCollaborationOutboxDispatch } from "@/lib/collaboration/collaboration-outbox-service";
import {
  textPolicySchema,
  resolveTextPolicy,
  isTextEligibleLabel,
  TEXT_ENTITY_LABEL_SCOPES,
  TEXT_DOCUMENT_LABEL_SCOPES,
  TEXT_RELATION_LABEL_SCOPES,
  type TextPolicy,
  type EligibleLabelRow,
} from "@/lib/annotations/text-policy-service";

/**
 * The canonical PolicyWrite input — `{expectedRevision, policy}` — unchanged
 * from HTTP through this service (T042/T043). `expectedRevision` compares
 * against `Dataset.textPolicyRevision`, the durable configuration revision;
 * it is a distinct command domain from an annotation command's own
 * `expectedPolicyRevision` reference (research.md "Follow-up decisions for
 * implementation readiness").
 */
export const policyWriteSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  policy: textPolicySchema,
}).strict();
export type PolicyWriteInput = z.infer<typeof policyWriteSchema>;

export type TextPolicyWriteFailure = TextCommandFailure;
export type TextPolicyWriteResult =
  | { ok: true; policy: TextPolicy; revision: number }
  | { ok: false; reason: TextPolicyWriteFailure };

/**
 * Every label id referenced anywhere in the policy must belong to this
 * dataset, have `modality` null or TEXT, and an eligible scope matching its
 * role: classification-group members need a document scope
 * (CLASSIFICATION/SENTIMENT/INTENT), a relation type's own label needs
 * RELATION, and its allowed endpoint label ids need ENTITY. No invented
 * labels/types (data-model.md "Dataset taxonomy policy").
 */
function validatePolicyReferences(policy: TextPolicy, labelsById: Map<string, EligibleLabelRow>): boolean {
  for (const group of policy.classificationGroups) {
    for (const labelId of group.memberLabelIds) {
      const label = labelsById.get(labelId);
      if (!label || !isTextEligibleLabel(label, TEXT_DOCUMENT_LABEL_SCOPES)) return false;
    }
  }
  for (const relationType of policy.relationTypes) {
    const relationLabel = labelsById.get(relationType.relationLabelId);
    if (!relationLabel || !isTextEligibleLabel(relationLabel, TEXT_RELATION_LABEL_SCOPES)) return false;
    for (const labelId of [...relationType.allowedSourceLabelIds, ...relationType.allowedTargetLabelIds]) {
      const label = labelsById.get(labelId);
      if (!label || !isTextEligibleLabel(label, TEXT_ENTITY_LABEL_SCOPES)) return false;
    }
  }
  return true;
}

export async function writeTextPolicy(actor: RequestActor, datasetId: string, rawInput: unknown): Promise<TextPolicyWriteResult> {
  const parsed = policyWriteSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };

  const outcome = await runGuardedTextDatasetCommand(actor, { datasetId, permission: "label.manage" }, async (tx, ctx) => {
    const dataset = await tx.dataset.findFirst({ where: { id: ctx.datasetId, deletedAt: null, archivedAt: null }, select: { textPolicyRevision: true } });
    if (!dataset) rejectTextCommand("NOT_FOUND");
    if (dataset.textPolicyRevision !== parsed.data.expectedRevision) rejectTextCommand("REVISION_STALE");

    const referencedLabelIds = new Set<string>();
    for (const group of parsed.data.policy.classificationGroups) for (const id of group.memberLabelIds) referencedLabelIds.add(id);
    for (const relationType of parsed.data.policy.relationTypes) {
      referencedLabelIds.add(relationType.relationLabelId);
      for (const id of relationType.allowedSourceLabelIds) referencedLabelIds.add(id);
      for (const id of relationType.allowedTargetLabelIds) referencedLabelIds.add(id);
    }
    const labels = referencedLabelIds.size
      ? await tx.label.findMany({ where: { id: { in: [...referencedLabelIds] }, datasetId: ctx.datasetId }, select: { id: true, modality: true, scope: true } })
      : [];
    if (labels.length !== referencedLabelIds.size) rejectTextCommand("INVALID_REQUEST");
    const labelsById = new Map(labels.map((label) => [label.id, label]));
    if (!validatePolicyReferences(parsed.data.policy, labelsById)) rejectTextCommand("INVALID_REQUEST");

    // Reject a reconfiguration that would invalidate an existing document
    // classification or relation rather than silently orphaning it. Cheap
    // today (no classification/relation commands exist yet to have created
    // any), correct once they do (US3/US4) without revisiting this file.
    const allLabels = await tx.label.findMany({ where: { datasetId: ctx.datasetId }, select: { id: true, modality: true, scope: true } });
    const resolved = resolveTextPolicy({ policy: parsed.data.policy, labels: allLabels });
    const groupedLabelIds = new Set(resolved.classificationGroups.flatMap((group) => group.memberLabelIds));
    const relationTypeLabelIds = new Set(resolved.relationTypes.map((relationType) => relationType.relationLabelId));
    const [orphanedClassifications, orphanedRelations] = await Promise.all([
      tx.annotation.count({ where: { datasetId: ctx.datasetId, type: "TEXT_CLASSIFICATION", labelId: { not: null, notIn: groupedLabelIds.size ? [...groupedLabelIds] : ["__none__"] } } }),
      tx.annotation.count({ where: { datasetId: ctx.datasetId, type: "TEXT_RELATION", labelId: { not: null, notIn: relationTypeLabelIds.size ? [...relationTypeLabelIds] : ["__none__"] } } }),
    ]);
    if (orphanedClassifications > 0 || orphanedRelations > 0) rejectTextCommand("CONFLICT");

    const updated = await tx.dataset.update({ where: { id: ctx.datasetId }, data: { textPolicy: parsed.data.policy, textPolicyRevision: { increment: 1 } }, select: { textPolicyRevision: true } });
    const dispatched = await dispatchTextPolicyChangedOutboxEvent(tx, { datasetId: ctx.datasetId, actorId: ctx.actorId, policyRevision: updated.textPolicyRevision });
    return { policy: parsed.data.policy, revision: updated.textPolicyRevision, outboxJobId: dispatched.jobId };
  });

  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  await enqueueCollaborationOutboxDispatch(outcome.result.outboxJobId);
  return { ok: true, policy: outcome.result.policy, revision: outcome.result.revision };
}

/** Read-side used by the GET route: current policy/revision plus resolved eligible labels/groups/relation-types. */
export async function readTextPolicy(datasetId: string) {
  const [dataset, labels] = await Promise.all([
    db.dataset.findFirst({ where: { id: datasetId, deletedAt: null, archivedAt: null }, select: { textPolicy: true, textPolicyRevision: true } }),
    db.label.findMany({ where: { datasetId }, select: { id: true, modality: true, scope: true } }),
  ]);
  return { dataset, labels };
}
