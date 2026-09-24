import "server-only";

import type { Prisma } from "@internal/db";
import { AnnotationSource, AnnotationStatus, AnnotationType, Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { rejectTextCommand, runGuardedTextAssetCommand, type TextAssetCommandOutcome } from "@/lib/annotations/text-command-service";
import { recheckSourceIdentity, recheckPolicyRevision, resolveVerifiedSourceForCommand, type VerifiedTextSourceContext } from "@/lib/annotations/text-source-verification";
import { countCanonicalTextAnnotations, evaluateTextAnnotationCountAdmission } from "@/lib/annotations/text-annotation-count";
import { getTextSourceLimits } from "@/lib/config/text-source-limits";
import { dispatchAnnotationChangedOutboxEvent } from "@/lib/collaboration/collaboration-outbox-service";
import { readTextPolicy } from "@/lib/annotations/text-policy-write-service";
import { parseTextPolicy, resolveTextPolicy, findTextRelationType, isCompatibleTextRelationEndpoints, type TextRelationType } from "@/lib/annotations/text-policy-service";
import { createTextRelationSchema, updateTextRelationSchema } from "@/lib/validation/text-relation";
import { serializeSafeTextAnnotation, textRelationGeometrySchema, TEXT_GEOMETRY_SCHEMA_VERSION, type SafeTextAnnotation, type TextRelationGeometry } from "@annotationplatform/domain/text-annotation-contract";

/**
 * Relation (`text-relation` / `TEXT_RELATION`) commands (data-model.md
 * "Canonical annotation shapes", US4). Structurally mirrors
 * `text-span-service.ts`'s `createTextSpan`: parse -> resolve verified
 * source + relation-type policy (I/O, outside the transaction) ->
 * `runGuardedTextAssetCommand` -> `applyCreateRelation` (the guarded write,
 * re-verifying source identity and policy revision against cheap
 * in-transaction reads, exactly as span commands do). A relation always
 * connects two existing spans (`NAMED_ENTITY_RECOGNITION`) on the same
 * asset; it never targets another relation or a classification.
 */

function buildRelationGeometry(sourceIdentity: string): TextRelationGeometry {
  const geometry = { schemaVersion: TEXT_GEOMETRY_SCHEMA_VERSION, kind: "text-relation" as const, sourceIdentity };
  const parsed = textRelationGeometrySchema.safeParse(geometry);
  if (!parsed.success) rejectTextCommand("INVALID_REQUEST");
  return parsed.data;
}

async function loadRelationEndpointSpan(tx: Prisma.TransactionClient, ctx: { assetId: string; datasetId: string }, annotationId: string) {
  const span = await tx.annotation.findFirst({
    where: { id: annotationId, assetId: ctx.assetId, datasetId: ctx.datasetId, modality: Modality.TEXT, type: AnnotationType.NAMED_ENTITY_RECOGNITION },
    select: { id: true, labelId: true },
  });
  if (!span) rejectTextCommand("NOT_FOUND");
  return span;
}

async function findExactDuplicateRelation(tx: Prisma.TransactionClient, assetId: string, labelId: string, fromAnnotationId: string, toAnnotationId: string) {
  return tx.annotation.findFirst({
    where: { assetId, modality: Modality.TEXT, type: AnnotationType.TEXT_RELATION, labelId, fromAnnotationId, toAnnotationId },
    select: { id: true },
  });
}

async function applyCreateRelation(
  tx: Prisma.TransactionClient,
  ctx: { assetId: string; datasetId: string; actorId: string; actor: RequestActor },
  verifiedSource: VerifiedTextSourceContext,
  relationType: TextRelationType,
  command: { operationId: string; expectedPolicyRevision: number; relationLabelId: string; fromAnnotationId: string; toAnnotationId: string },
): Promise<SafeTextAnnotation> {
  const permission = await requireDatasetPermission(ctx.actor, ctx.datasetId, "annotation.create", tx);
  if (!permission || permission.forbidden) rejectTextCommand("FORBIDDEN");

  await recheckSourceIdentity(tx, ctx.assetId, verifiedSource);
  // Guarantees the `relationType` resolved outside this transaction (from
  // `readTextPolicy`, an uncommitted-read I/O call) is still exactly the
  // policy the client targeted -- `Dataset.textPolicyRevision` only changes
  // on a policy write, so an unchanged revision means unchanged content.
  await recheckPolicyRevision(tx, ctx.datasetId, command.expectedPolicyRevision);

  const [fromSpan, toSpan] = await Promise.all([
    loadRelationEndpointSpan(tx, ctx, command.fromAnnotationId),
    loadRelationEndpointSpan(tx, ctx, command.toAnnotationId),
  ]);
  if (!isCompatibleTextRelationEndpoints(relationType, { sourceLabelId: fromSpan.labelId, targetLabelId: toSpan.labelId })) rejectTextCommand("INVALID_REQUEST");

  const duplicate = await findExactDuplicateRelation(tx, ctx.assetId, command.relationLabelId, command.fromAnnotationId, command.toAnnotationId);
  if (duplicate) rejectTextCommand("DUPLICATE_RELATION");

  const limits = getTextSourceLimits();
  const currentCount = await countCanonicalTextAnnotations(tx, ctx.assetId);
  const admission = evaluateTextAnnotationCountAdmission({ currentCount, finalCount: currentCount + 1, limit: limits.maxAnnotations });
  if (!admission.ok) rejectTextCommand("LIMIT_EXCEEDED");

  const claimed = await tx.asset.updateMany({ where: { id: ctx.assetId, datasetId: ctx.datasetId }, data: { revision: { increment: 1 } } });
  if (claimed.count !== 1) rejectTextCommand("NOT_FOUND");

  const geometry = buildRelationGeometry(verifiedSource.sourceIdentity);
  const created = await tx.annotation.create({
    data: {
      datasetId: ctx.datasetId, assetId: ctx.assetId, labelId: command.relationLabelId, createdById: ctx.actorId,
      modality: Modality.TEXT, type: AnnotationType.TEXT_RELATION, source: AnnotationSource.MANUAL,
      fromAnnotationId: command.fromAnnotationId, toAnnotationId: command.toAnnotationId,
      geometry, properties: { custom: {} }, status: AnnotationStatus.DRAFT,
    },
    select: { id: true, assetId: true, datasetId: true, labelId: true, status: true, revision: true, geometry: true, properties: true, fromAnnotationId: true, toAnnotationId: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true },
  });

  await dispatchAnnotationChangedOutboxEvent(tx, { datasetId: ctx.datasetId, assetId: ctx.assetId, actorId: ctx.actorId, operationId: command.operationId, parentRevision: null });
  return serializeSafeTextAnnotation(created);
}

export async function createTextRelation(actor: RequestActor, assetId: string, rawInput: unknown): Promise<TextAssetCommandOutcome<SafeTextAnnotation>> {
  const parsed = createTextRelationSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const input = parsed.data;

  const resolved = await resolveVerifiedSourceForCommand(actor, assetId, input.sourceIdentity);
  if (!resolved.ok) return resolved;

  // Resolved against the *current* policy (outside the transaction, same as
  // the source-readiness I/O above) -- `applyCreateRelation` re-checks
  // `expectedPolicyRevision` inside the transaction before trusting it.
  const { dataset, labels } = await readTextPolicy(resolved.datasetId);
  if (!dataset) return { ok: false, reason: "NOT_FOUND" };
  const policyResolved = resolveTextPolicy({ policy: parseTextPolicy(dataset.textPolicy), labels });
  const relationType = findTextRelationType(policyResolved, input.command.relationLabelId);
  if (!relationType) return { ok: false, reason: "INVALID_REQUEST" };

  return runGuardedTextAssetCommand(
    actor,
    {
      datasetId: resolved.datasetId,
      assetId,
      operationId: input.operationId,
      hash: { commandKind: "createRelation", sourceIdentity: input.sourceIdentity, expectedPolicyRevision: input.expectedPolicyRevision, data: input.command },
    },
    (tx, ctx) => applyCreateRelation(tx, ctx, resolved.verifiedSource, relationType, { operationId: input.operationId, expectedPolicyRevision: input.expectedPolicyRevision, relationLabelId: input.command.relationLabelId, fromAnnotationId: input.command.fromAnnotationId, toAnnotationId: input.command.toAnnotationId }),
  );
}

/** Resolve taxonomy inside the guarded transaction for label/endpoint mutations. */
async function transactionRelationPolicy(tx: Prisma.TransactionClient, datasetId: string) {
  const [dataset, labels] = await Promise.all([
    tx.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { textPolicy: true } }),
    tx.label.findMany({ where: { datasetId }, select: { id: true, modality: true, scope: true } }),
  ]);
  return resolveTextPolicy({ policy: parseTextPolicy(dataset.textPolicy), labels });
}

/** A span relabel cannot silently invalidate existing relation endpoints. */
export async function validateSpanRelationLabels(tx: Prisma.TransactionClient, ctx: { assetId: string; datasetId: string }, spanId: string, labelId: string | null) {
  const relations = await tx.annotation.findMany({ where: { assetId: ctx.assetId, datasetId: ctx.datasetId, type: "TEXT_RELATION", OR: [{ fromAnnotationId: spanId }, { toAnnotationId: spanId }] }, select: { labelId: true, fromAnnotationId: true, toAnnotationId: true } });
  if (!relations.length) return;
  const policy = await transactionRelationPolicy(tx, ctx.datasetId);
  for (const relation of relations) {
    const relationType = relation.labelId ? findTextRelationType(policy, relation.labelId) : null;
    if (!relationType || !relation.fromAnnotationId || !relation.toAnnotationId) rejectTextCommand("INVALID_REQUEST");
    const from = await loadRelationEndpointSpan(tx, ctx, relation.fromAnnotationId);
    const to = await loadRelationEndpointSpan(tx, ctx, relation.toAnnotationId);
    if (!isCompatibleTextRelationEndpoints(relationType, { sourceLabelId: from.id === spanId ? labelId : from.labelId, targetLabelId: to.id === spanId ? labelId : to.labelId })) rejectTextCommand("REFERENCED_SCOPE_LOCKED");
  }
}

export async function updateTextRelation(actor: RequestActor, assetId: string, rawInput: unknown): Promise<TextAssetCommandOutcome<SafeTextAnnotation>> {
  const parsed = updateTextRelationSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const input = parsed.data;
  const resolved = await resolveVerifiedSourceForCommand(actor, assetId, input.sourceIdentity);
  if (!resolved.ok) return resolved;
  return runGuardedTextAssetCommand(actor, {
    datasetId: resolved.datasetId, assetId, operationId: input.operationId,
    hash: { commandKind: "updateRelation", sourceIdentity: input.sourceIdentity, expectedPolicyRevision: input.expectedPolicyRevision, data: input.command },
  }, async (tx, ctx) => {
    const existing = await tx.annotation.findFirst({ where: { id: input.command.annotationId, datasetId: ctx.datasetId, assetId, modality: "TEXT", type: "TEXT_RELATION" } });
    if (!existing) rejectTextCommand("NOT_FOUND");
    const permission = await requireDatasetPermission(actor, ctx.datasetId, existing.createdById === actor.id ? "annotation.updateOwn" : "annotation.updateAny", tx);
    if (!permission || permission.forbidden) rejectTextCommand("FORBIDDEN");
    if (existing.revision !== input.command.expectedRevision) rejectTextCommand("REVISION_STALE");
    await recheckSourceIdentity(tx, assetId, resolved.verifiedSource);
    await recheckPolicyRevision(tx, ctx.datasetId, input.expectedPolicyRevision);
    const labelId = input.command.relationLabelId ?? existing.labelId;
    const fromAnnotationId = input.command.fromAnnotationId ?? existing.fromAnnotationId;
    const toAnnotationId = input.command.toAnnotationId ?? existing.toAnnotationId;
    if (!labelId || !fromAnnotationId || !toAnnotationId || fromAnnotationId === toAnnotationId) rejectTextCommand("INVALID_REQUEST");
    const policy = await transactionRelationPolicy(tx, ctx.datasetId);
    const relationType = findTextRelationType(policy, labelId);
    if (!relationType) rejectTextCommand("INVALID_REQUEST");
    const from = await loadRelationEndpointSpan(tx, ctx, fromAnnotationId);
    const to = await loadRelationEndpointSpan(tx, ctx, toAnnotationId);
    if (!isCompatibleTextRelationEndpoints(relationType, { sourceLabelId: from.labelId, targetLabelId: to.labelId })) rejectTextCommand("INVALID_REQUEST");
    const duplicate = await tx.annotation.findFirst({ where: { id: { not: existing.id }, assetId, modality: "TEXT", type: "TEXT_RELATION", labelId, fromAnnotationId, toAnnotationId }, select: { id: true } });
    if (duplicate) rejectTextCommand("DUPLICATE_RELATION");
    const changed = await tx.annotation.updateMany({ where: { id: existing.id, revision: input.command.expectedRevision }, data: { labelId, fromAnnotationId, toAnnotationId, updatedById: actor.id, revision: { increment: 1 } } });
    if (changed.count !== 1) rejectTextCommand("REVISION_STALE");
    const updated = await tx.annotation.findUniqueOrThrow({ where: { id: existing.id } });
    await dispatchAnnotationChangedOutboxEvent(tx, { datasetId: ctx.datasetId, assetId, actorId: actor.id, operationId: input.operationId, parentRevision: null });
    return serializeSafeTextAnnotation(updated);
  });
}
