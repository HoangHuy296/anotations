import "server-only";

import type { Prisma } from "@internal/db";
import { AnnotationSource, AnnotationStatus, AnnotationType, Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { rejectTextCommand, runGuardedTextAssetCommand, type TextAssetCommandOutcome } from "@/lib/annotations/text-command-service";
import { readTextSource } from "@/lib/annotations/text-source-read-service";
import { recheckSourceIdentity, recheckPolicyRevision, resolveVerifiedSourceForCommand, type VerifiedTextSourceContext } from "@/lib/annotations/text-source-verification";
import { countCanonicalTextAnnotations, evaluateTextAnnotationCountAdmission } from "@/lib/annotations/text-annotation-count";
import { getTextSourceLimits } from "@/lib/config/text-source-limits";
import { dispatchAnnotationChangedOutboxEvent } from "@/lib/collaboration/collaboration-outbox-service";
import { createTextSpanSchema, updateTextSpanSchema, deleteTextAnnotationSchema, peekTextAnnotationCommandKind } from "@/lib/validation/text-span";
import { TEXT_ENTITY_LABEL_SCOPES } from "@/lib/annotations/text-policy-service";
import { createTextRelation, updateTextRelation, validateSpanRelationLabels } from "@/lib/annotations/text-relation-service";
import { replaceClassification } from "@/lib/annotations/text-classification-service";
import { serializeSafeTextAnnotation, textSpanGeometrySchema, TEXT_GEOMETRY_SCHEMA_VERSION, UTF16_CODE_UNIT, type SafeTextAnnotation, type TextSpanGeometry } from "@annotationplatform/domain/text-annotation-contract";
import { applyTextPropertyPatch, type TextProperties, type TextPropertyPatch } from "@annotationplatform/domain/text-properties-contract";

/**
 * Span (`text-span` / `NAMED_ENTITY_RECOGNITION`) commands (data-model.md
 * "Canonical annotation shapes", T070/T071). `createTextSpan` is the single
 * entry point the route (`/api/assets/{assetId}/text/annotations`) calls:
 * parse -> resolve verified source (I/O, outside the transaction) ->
 * `runGuardedTextAssetCommand` -> `applyCreateSpan` (the actual guarded
 * write, re-verifying everything I/O-derived against cheap in-transaction
 * reads). No other module should open a second write path for spans.
 */

function isBoundaryOffset(boundaryOffsets: readonly number[], offset: number): boolean {
  // Sorted, unique, safe-integer offsets (T026 loader's own invariant) --
  // binary search is safe and avoids an O(n) scan per endpoint.
  let low = 0;
  let high = boundaryOffsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = boundaryOffsets[mid]!;
    if (value === offset) return true;
    if (value < offset) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}

function validateSpanRange(verifiedSource: VerifiedTextSourceContext, startOffset: number, endOffset: number): void {
  if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)) rejectTextCommand("INVALID_RANGE");
  if (!(startOffset >= 0 && startOffset < endOffset && endOffset <= verifiedSource.sourceCodeUnitLength)) rejectTextCommand("INVALID_RANGE");
  if (!isBoundaryOffset(verifiedSource.boundaryOffsets, startOffset) || !isBoundaryOffset(verifiedSource.boundaryOffsets, endOffset)) rejectTextCommand("INVALID_RANGE");
}

async function validateEntityLabel(tx: Prisma.TransactionClient, datasetId: string, labelId: string | null): Promise<void> {
  if (labelId === null) return;
  // Same eligibility rule the policy read side resolves entityLabelIds with
  // (text-policy-service.ts) -- a dataset-wide OBJECT-scope label or an
  // explicit TEXT ENTITY label, never a CLASSIFICATION/SENTIMENT/INTENT/
  // RELATION-scoped one.
  const label = await tx.label.findFirst({ where: { id: labelId, datasetId, scope: { in: [...TEXT_ENTITY_LABEL_SCOPES] }, OR: [{ modality: null }, { modality: Modality.TEXT }] }, select: { id: true } });
  if (!label) rejectTextCommand("INVALID_REQUEST");
}

function buildSpanGeometry(sourceIdentity: string, startOffset: number, endOffset: number): TextSpanGeometry {
  const geometry = { schemaVersion: TEXT_GEOMETRY_SCHEMA_VERSION, kind: "text-span" as const, sourceIdentity, offsetUnit: UTF16_CODE_UNIT, startOffset, endOffset };
  const parsed = textSpanGeometrySchema.safeParse(geometry);
  if (!parsed.success) rejectTextCommand("INVALID_RANGE");
  return parsed.data;
}

async function findExactDuplicateSpan(tx: Prisma.TransactionClient, assetId: string, geometry: TextSpanGeometry, labelId: string | null) {
  const candidates = await tx.annotation.findMany({
    where: { assetId, modality: Modality.TEXT, type: AnnotationType.NAMED_ENTITY_RECOGNITION, labelId },
    select: { id: true, geometry: true },
  });
  return candidates.find((row) => {
    const existing = row.geometry as unknown as TextSpanGeometry;
    return existing?.kind === "text-span" && existing.startOffset === geometry.startOffset && existing.endOffset === geometry.endOffset;
  }) ?? null;
}

async function applyCreateSpan(
  tx: Prisma.TransactionClient,
  ctx: { assetId: string; datasetId: string; actorId: string; actor: RequestActor },
  verifiedSource: VerifiedTextSourceContext,
  command: { operationId: string; expectedPolicyRevision: number; labelId: string | null; startOffset: number; endOffset: number; properties?: TextProperties },
): Promise<SafeTextAnnotation> {
  const permission = await requireDatasetPermission(ctx.actor, ctx.datasetId, "annotation.create", tx);
  if (!permission || permission.forbidden) rejectTextCommand("FORBIDDEN");

  await recheckSourceIdentity(tx, ctx.assetId, verifiedSource);
  await recheckPolicyRevision(tx, ctx.datasetId, command.expectedPolicyRevision);
  validateSpanRange(verifiedSource, command.startOffset, command.endOffset);
  await validateEntityLabel(tx, ctx.datasetId, command.labelId);

  const geometry = buildSpanGeometry(verifiedSource.sourceIdentity, command.startOffset, command.endOffset);

  // Reject/reconcile duplicates (data-model.md "Canonical annotation
  // shapes"): an exact same asset/source/range/label span already existing
  // here is a genuine duplicate, never a replay -- replay is already
  // resolved by `runGuardedTextAssetCommand` before `apply` runs, so by
  // construction this is always a fresh operation id.
  const duplicate = await findExactDuplicateSpan(tx, ctx.assetId, geometry, command.labelId);
  if (duplicate) rejectTextCommand("DUPLICATE_SPAN");

  const limits = getTextSourceLimits();
  const currentCount = await countCanonicalTextAnnotations(tx, ctx.assetId);
  const admission = evaluateTextAnnotationCountAdmission({ currentCount, finalCount: currentCount + 1, limit: limits.maxAnnotations });
  if (!admission.ok) rejectTextCommand("LIMIT_EXCEEDED");

  const claimed = await tx.asset.updateMany({ where: { id: ctx.assetId, datasetId: ctx.datasetId }, data: { revision: { increment: 1 } } });
  if (claimed.count !== 1) rejectTextCommand("NOT_FOUND");

  const created = await tx.annotation.create({
    data: {
      datasetId: ctx.datasetId, assetId: ctx.assetId, labelId: command.labelId, createdById: ctx.actorId,
      modality: Modality.TEXT, type: AnnotationType.NAMED_ENTITY_RECOGNITION, source: AnnotationSource.MANUAL,
      geometry, properties: command.properties ?? { custom: {} }, status: AnnotationStatus.DRAFT,
    },
    select: { id: true, assetId: true, datasetId: true, labelId: true, status: true, revision: true, geometry: true, properties: true, fromAnnotationId: true, toAnnotationId: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true },
  });

  await dispatchAnnotationChangedOutboxEvent(tx, { datasetId: ctx.datasetId, assetId: ctx.assetId, actorId: ctx.actorId, operationId: command.operationId, parentRevision: null });
  return serializeSafeTextAnnotation(created);
}

async function applyUpdateSpan(
  tx: Prisma.TransactionClient,
  ctx: { assetId: string; datasetId: string; actorId: string; actor: RequestActor },
  verifiedSource: VerifiedTextSourceContext,
  command: { operationId: string; expectedPolicyRevision: number; annotationId: string; expectedRevision: number; startOffset?: number; endOffset?: number; labelId?: string | null; propertyPatch?: TextPropertyPatch },
): Promise<SafeTextAnnotation> {
  const existing = await tx.annotation.findFirst({
    where: { id: command.annotationId, datasetId: ctx.datasetId, assetId: ctx.assetId, modality: Modality.TEXT, type: AnnotationType.NAMED_ENTITY_RECOGNITION },
    select: { id: true, createdById: true, geometry: true, labelId: true, properties: true },
  });
  if (!existing) rejectTextCommand("NOT_FOUND");

  const permission = await requireDatasetPermission(ctx.actor, ctx.datasetId, existing.createdById === ctx.actorId ? "annotation.updateOwn" : "annotation.updateAny", tx);
  if (!permission || permission.forbidden) rejectTextCommand("FORBIDDEN");

  await recheckSourceIdentity(tx, ctx.assetId, verifiedSource);
  await recheckPolicyRevision(tx, ctx.datasetId, command.expectedPolicyRevision);

  const currentGeometry = existing.geometry as unknown as TextSpanGeometry;
  if (!currentGeometry || currentGeometry.kind !== "text-span") rejectTextCommand("INVALID_REQUEST");
  // Geometry patches cannot change source identity or annotation kind
  // (data-model.md "Canonical annotation shapes"): both are fixed at
  // creation and carried forward as-is; only range/label may change.
  const nextStart = command.startOffset ?? currentGeometry.startOffset;
  const nextEnd = command.endOffset ?? currentGeometry.endOffset;
  const geometryChanged = nextStart !== currentGeometry.startOffset || nextEnd !== currentGeometry.endOffset;
  if (geometryChanged) validateSpanRange(verifiedSource, nextStart, nextEnd);

  const nextLabelId = command.labelId;
  if (nextLabelId !== undefined) {
    await validateEntityLabel(tx, ctx.datasetId, nextLabelId);
    await validateSpanRelationLabels(tx, ctx, existing.id, nextLabelId);
  }

  const geometry = geometryChanged ? buildSpanGeometry(verifiedSource.sourceIdentity, nextStart, nextEnd) : currentGeometry;
  if (geometryChanged || nextLabelId !== undefined) {
    const duplicate = await findExactDuplicateSpan(tx, ctx.assetId, geometry, nextLabelId !== undefined ? nextLabelId : existing.labelId);
    if (duplicate && duplicate.id !== existing.id) rejectTextCommand("DUPLICATE_SPAN");
  }

  // A property patch never affects geometry/label duplicate detection above
  // -- it is validated and merged independently, and (unlike geometry/label)
  // never participates in the exact-duplicate-span check.
  const nextProperties = command.propertyPatch
    ? applyTextPropertyPatch((existing.properties ?? { custom: {} }) as Record<string, unknown>, command.propertyPatch)
    : undefined;

  const claimed = await tx.asset.updateMany({ where: { id: ctx.assetId, datasetId: ctx.datasetId }, data: { revision: { increment: 1 } } });
  if (claimed.count !== 1) rejectTextCommand("NOT_FOUND");

  const updateData: Prisma.AnnotationUncheckedUpdateManyInput = { updatedById: ctx.actorId, revision: { increment: 1 } };
  if (geometryChanged) updateData.geometry = geometry;
  if (nextLabelId !== undefined) updateData.labelId = nextLabelId;
  if (nextProperties) updateData.properties = nextProperties as Prisma.InputJsonValue;
  const changed = await tx.annotation.updateMany({ where: { id: existing.id, revision: command.expectedRevision }, data: updateData });
  if (changed.count !== 1) rejectTextCommand("REVISION_STALE");

  const updated = await tx.annotation.findUniqueOrThrow({
    where: { id: existing.id },
    select: { id: true, assetId: true, datasetId: true, labelId: true, status: true, revision: true, geometry: true, properties: true, fromAnnotationId: true, toAnnotationId: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true },
  });
  await dispatchAnnotationChangedOutboxEvent(tx, { datasetId: ctx.datasetId, assetId: ctx.assetId, actorId: ctx.actorId, operationId: command.operationId, parentRevision: null });
  return serializeSafeTextAnnotation(updated);
}

async function applyDeleteSpan(
  tx: Prisma.TransactionClient,
  ctx: { assetId: string; datasetId: string; actorId: string; actor: RequestActor },
  verifiedSource: VerifiedTextSourceContext,
  command: { operationId: string; expectedPolicyRevision: number; annotationId: string; expectedRevision: number },
): Promise<{ deletedId: string }> {
  const existing = await tx.annotation.findFirst({
    where: { id: command.annotationId, datasetId: ctx.datasetId, assetId: ctx.assetId, modality: Modality.TEXT },
    select: { id: true, createdById: true },
  });
  if (!existing) rejectTextCommand("NOT_FOUND");

  const permission = await requireDatasetPermission(ctx.actor, ctx.datasetId, existing.createdById === ctx.actorId ? "annotation.updateOwn" : "annotation.updateAny", tx);
  if (!permission || permission.forbidden) rejectTextCommand("FORBIDDEN");

  await recheckSourceIdentity(tx, ctx.assetId, verifiedSource);
  await recheckPolicyRevision(tx, ctx.datasetId, command.expectedPolicyRevision);

  const claimed = await tx.asset.updateMany({ where: { id: ctx.assetId, datasetId: ctx.datasetId }, data: { revision: { increment: 1 } } });
  if (claimed.count !== 1) rejectTextCommand("NOT_FOUND");

  let removed: { count: number };
  try {
    removed = await tx.annotation.deleteMany({ where: { id: existing.id, revision: command.expectedRevision } });
  } catch {
    // A referenced span's restrictive FK (T013) rejects the delete at the
    // database level until any relation referencing it is explicitly
    // removed first (relations arrive in US4).
    rejectTextCommand("REFERENCED_SCOPE_LOCKED");
  }
  if (removed.count !== 1) rejectTextCommand("REVISION_STALE");

  await dispatchAnnotationChangedOutboxEvent(tx, { datasetId: ctx.datasetId, assetId: ctx.assetId, actorId: ctx.actorId, operationId: command.operationId, parentRevision: null });
  return { deletedId: existing.id };
}

export async function updateTextSpan(actor: RequestActor, assetId: string, rawInput: unknown): Promise<TextAssetCommandOutcome<SafeTextAnnotation>> {
  const parsed = updateTextSpanSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const input = parsed.data;

  const resolved = await resolveVerifiedSourceForCommand(actor, assetId, input.sourceIdentity);
  if (!resolved.ok) return resolved;

  return runGuardedTextAssetCommand(
    actor,
    {
      datasetId: resolved.datasetId,
      assetId,
      operationId: input.operationId,
      hash: { commandKind: "updateSpan", sourceIdentity: input.sourceIdentity, expectedPolicyRevision: input.expectedPolicyRevision, data: input.command },
    },
    (tx, ctx) => applyUpdateSpan(tx, ctx, resolved.verifiedSource, { operationId: input.operationId, expectedPolicyRevision: input.expectedPolicyRevision, annotationId: input.command.annotationId, expectedRevision: input.command.expectedRevision, startOffset: input.command.startOffset, endOffset: input.command.endOffset, labelId: input.command.labelId, propertyPatch: input.command.propertyPatch }),
  );
}

export async function deleteTextAnnotation(actor: RequestActor, assetId: string, rawInput: unknown): Promise<TextAssetCommandOutcome<{ deletedId: string }>> {
  const parsed = deleteTextAnnotationSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const input = parsed.data;

  const resolved = await resolveVerifiedSourceForCommand(actor, assetId, input.sourceIdentity);
  if (!resolved.ok) return resolved;

  return runGuardedTextAssetCommand(
    actor,
    {
      datasetId: resolved.datasetId,
      assetId,
      operationId: input.operationId,
      hash: { commandKind: "deleteAnnotation", sourceIdentity: input.sourceIdentity, expectedPolicyRevision: input.expectedPolicyRevision, data: input.command },
    },
    (tx, ctx) => applyDeleteSpan(tx, ctx, resolved.verifiedSource, { operationId: input.operationId, expectedPolicyRevision: input.expectedPolicyRevision, annotationId: input.command.annotationId, expectedRevision: input.command.expectedRevision }),
  );
}

/**
 * Single dispatch entry point the route calls: peeks `command.kind` (cheap,
 * non-throwing) to pick which strict schema/handler applies, so the route
 * itself never branches on command shape. An unrecognized/missing kind is
 * `INVALID_REQUEST`, not a 500 -- this is public-request input.
 */
export async function submitTextAnnotationCommand(actor: RequestActor, assetId: string, rawInput: unknown): Promise<TextAssetCommandOutcome<SafeTextAnnotation | SafeTextAnnotation[] | { deletedId: string }>> {
  const kind = peekTextAnnotationCommandKind(rawInput);
  if (kind === "createSpan") return createTextSpan(actor, assetId, rawInput);
  if (kind === "updateSpan") return updateTextSpan(actor, assetId, rawInput);
  if (kind === "deleteAnnotation") return deleteTextAnnotation(actor, assetId, rawInput);
  if (kind === "updateRelation") return updateTextRelation(actor, assetId, rawInput);
  if (kind === "createRelation") return createTextRelation(actor, assetId, rawInput);
  if (kind === "replaceClassification") return replaceClassification(actor, assetId, rawInput);
  return { ok: false, reason: "INVALID_REQUEST" };
}

export async function createTextSpan(actor: RequestActor, assetId: string, rawInput: unknown): Promise<TextAssetCommandOutcome<SafeTextAnnotation>> {
  const parsed = createTextSpanSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const input = parsed.data;

  const asset = await db.asset.findFirst({ where: { id: assetId, modality: Modality.TEXT, deletedAt: null, archivedAt: null }, select: { datasetId: true } });
  if (!asset) return { ok: false, reason: "NOT_FOUND" };

  const sourceOutcome = await readTextSource(actor, assetId);
  if (!sourceOutcome.ok) return { ok: false, reason: "NOT_FOUND" };
  if (sourceOutcome.readiness !== "READY") return { ok: false, reason: "SOURCE_NOT_READY" };
  if (sourceOutcome.sourceIdentity !== input.sourceIdentity) return { ok: false, reason: "SOURCE_MISMATCH" };

  const verifiedSource: VerifiedTextSourceContext = {
    sourceIdentity: sourceOutcome.sourceIdentity,
    sourceCodeUnitLength: sourceOutcome.sourceCodeUnitLength,
    boundaryOffsets: sourceOutcome.boundaryOffsets,
  };

  return runGuardedTextAssetCommand(
    actor,
    {
      datasetId: asset.datasetId,
      assetId,
      operationId: input.operationId,
      hash: { commandKind: "createSpan", sourceIdentity: input.sourceIdentity, expectedPolicyRevision: input.expectedPolicyRevision, data: input.command },
    },
    (tx, ctx) => applyCreateSpan(tx, ctx, verifiedSource, { operationId: input.operationId, expectedPolicyRevision: input.expectedPolicyRevision, labelId: input.command.labelId, startOffset: input.command.startOffset, endOffset: input.command.endOffset, properties: input.command.properties }),
  );
}
