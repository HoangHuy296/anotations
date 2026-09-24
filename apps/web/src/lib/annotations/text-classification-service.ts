import "server-only";

import type { Prisma } from "@internal/db";
import { AnnotationSource, AnnotationStatus, AnnotationType, LabelScope, Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { rejectTextCommand, runGuardedTextAssetCommand, type TextAssetCommandOutcome } from "@/lib/annotations/text-command-service";
import { recheckSourceIdentity, recheckPolicyRevision, resolveVerifiedSourceForCommand, type VerifiedTextSourceContext } from "@/lib/annotations/text-source-verification";
import { countCanonicalTextAnnotations, evaluateTextAnnotationCountAdmission } from "@/lib/annotations/text-annotation-count";
import { getTextSourceLimits } from "@/lib/config/text-source-limits";
import { dispatchAnnotationChangedOutboxEvent } from "@/lib/collaboration/collaboration-outbox-service";
import { parseTextPolicy, resolveTextPolicy } from "@/lib/annotations/text-policy-service";
import { replaceClassificationSchema } from "@/lib/validation/text-classification";
import { serializeSafeTextAnnotation, textDocumentGeometrySchema, TEXT_GEOMETRY_SCHEMA_VERSION, type SafeTextAnnotation, type TextDocumentGeometry } from "@annotationplatform/domain/text-annotation-contract";

/**
 * Document classification (`text-document` geometry; `TEXT_CLASSIFICATION`/
 * `SENTIMENT`/`INTENT` depending on the member label's scope) commands
 * (data-model.md "Canonical annotation shapes", US3). Structurally mirrors
 * `text-relation-service.ts`: no dependency on `text-span-service.ts`,
 * same-asset/policy verification, same guarded-transaction shape. One
 * command, `replaceClassification`, covers both SINGLE and MULTI groups --
 * see `text-classification.ts`'s validation module doc for why there is no
 * separate incremental `updateClassification`.
 */

const CLASSIFICATION_TYPES = [AnnotationType.TEXT_CLASSIFICATION, AnnotationType.SENTIMENT, AnnotationType.INTENT] as const;

function annotationTypeForLabelScope(scope: LabelScope) {
  if (scope === LabelScope.SENTIMENT) return AnnotationType.SENTIMENT;
  if (scope === LabelScope.INTENT) return AnnotationType.INTENT;
  return AnnotationType.TEXT_CLASSIFICATION;
}

function buildDocumentGeometry(sourceIdentity: string): TextDocumentGeometry {
  const geometry = { schemaVersion: TEXT_GEOMETRY_SCHEMA_VERSION, kind: "text-document" as const, sourceIdentity };
  const parsed = textDocumentGeometrySchema.safeParse(geometry);
  if (!parsed.success) rejectTextCommand("INVALID_REQUEST");
  return parsed.data;
}

/** Resolve taxonomy inside the guarded transaction -- never trust a policy resolved outside it for a write this consequential. */
async function transactionClassificationPolicy(tx: Prisma.TransactionClient, datasetId: string) {
  const [dataset, labels] = await Promise.all([
    tx.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { textPolicy: true } }),
    tx.label.findMany({ where: { datasetId }, select: { id: true, modality: true, scope: true } }),
  ]);
  return { resolved: resolveTextPolicy({ policy: parseTextPolicy(dataset.textPolicy), labels }), labels };
}

const annotationSelect = { id: true, assetId: true, datasetId: true, labelId: true, status: true, revision: true, geometry: true, properties: true, fromAnnotationId: true, toAnnotationId: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true } satisfies Prisma.AnnotationSelect;

async function applyReplaceClassification(
  tx: Prisma.TransactionClient,
  ctx: { assetId: string; datasetId: string; actorId: string; actor: RequestActor },
  verifiedSource: VerifiedTextSourceContext,
  command: { operationId: string; expectedPolicyRevision: number; groupId: string; memberLabelIds: string[]; expectedMembers: { id: string; revision: number }[] },
): Promise<SafeTextAnnotation[]> {
  const permission = await requireDatasetPermission(ctx.actor, ctx.datasetId, "annotation.create", tx);
  if (!permission || permission.forbidden) rejectTextCommand("FORBIDDEN");

  await recheckSourceIdentity(tx, ctx.assetId, verifiedSource);
  await recheckPolicyRevision(tx, ctx.datasetId, command.expectedPolicyRevision);

  const { resolved, labels } = await transactionClassificationPolicy(tx, ctx.datasetId);
  const group = resolved.classificationGroups.find((candidate) => candidate.id === command.groupId);
  if (!group) rejectTextCommand("INVALID_REQUEST");

  const requestedIds = [...new Set(command.memberLabelIds)];
  if (requestedIds.length !== command.memberLabelIds.length) rejectTextCommand("INVALID_REQUEST"); // duplicate category membership rejected (T101)
  if (!requestedIds.every((id) => group.memberLabelIds.includes(id))) rejectTextCommand("INVALID_REQUEST");
  if (group.cardinality === "SINGLE" && requestedIds.length > 1) rejectTextCommand("INVALID_REQUEST");

  const groupLabelIds = new Set(group.memberLabelIds);
  const current = await tx.annotation.findMany({
    where: { assetId: ctx.assetId, datasetId: ctx.datasetId, modality: Modality.TEXT, type: { in: [...CLASSIFICATION_TYPES] }, labelId: { in: [...groupLabelIds] } },
    select: { id: true, labelId: true, revision: true },
  });

  // Atomic single-label replacement requires the caller's complete current
  // membership set to match reality exactly -- a stale replacement (built
  // against an outdated membership) can never silently remove a category
  // added since (data-model.md D4, T100).
  const currentById = new Map(current.map((row) => [row.id, row.revision] as const));
  const expectedById = new Map(command.expectedMembers.map((row) => [row.id, row.revision] as const));
  if (currentById.size !== expectedById.size || [...currentById].some(([id, revision]) => expectedById.get(id) !== revision)) {
    rejectTextCommand("REVISION_STALE");
  }

  const toRemove = current.filter((row) => !requestedIds.includes(row.labelId!));
  const currentLabelIds = new Set(current.map((row) => row.labelId));
  const toCreateLabelIds = requestedIds.filter((id) => !currentLabelIds.has(id));
  const survivingIds = current.filter((row) => requestedIds.includes(row.labelId!)).map((row) => row.id);

  const limits = getTextSourceLimits();
  const currentCount = await countCanonicalTextAnnotations(tx, ctx.assetId);
  const finalCount = currentCount - toRemove.length + toCreateLabelIds.length;
  const admission = evaluateTextAnnotationCountAdmission({ currentCount, finalCount, limit: limits.maxAnnotations });
  if (!admission.ok) rejectTextCommand("LIMIT_EXCEEDED");

  const claimed = await tx.asset.updateMany({ where: { id: ctx.assetId, datasetId: ctx.datasetId }, data: { revision: { increment: 1 } } });
  if (claimed.count !== 1) rejectTextCommand("NOT_FOUND");

  // Reads above already ran inside this Serializable transaction -- a
  // concurrent conflicting write would abort this transaction at commit
  // (caught and retried by `runGuardedTextAssetCommand`), so no further
  // per-row revision recheck is needed on these writes.
  if (toRemove.length) await tx.annotation.deleteMany({ where: { id: { in: toRemove.map((row) => row.id) } } });

  const geometry = buildDocumentGeometry(verifiedSource.sourceIdentity);
  const created = [];
  for (const labelId of toCreateLabelIds) {
    const label = labels.find((row) => row.id === labelId);
    if (!label) rejectTextCommand("INVALID_REQUEST");
    const row = await tx.annotation.create({
      data: { datasetId: ctx.datasetId, assetId: ctx.assetId, labelId, createdById: ctx.actorId, modality: Modality.TEXT, type: annotationTypeForLabelScope(label.scope), source: AnnotationSource.MANUAL, geometry, properties: { custom: {} }, status: AnnotationStatus.DRAFT },
      select: annotationSelect,
    });
    created.push(row);
  }
  const surviving = survivingIds.length ? await tx.annotation.findMany({ where: { id: { in: survivingIds } }, select: annotationSelect }) : [];

  await dispatchAnnotationChangedOutboxEvent(tx, { datasetId: ctx.datasetId, assetId: ctx.assetId, actorId: ctx.actorId, operationId: command.operationId, parentRevision: null });
  return [...surviving, ...created].map(serializeSafeTextAnnotation);
}

export async function replaceClassification(actor: RequestActor, assetId: string, rawInput: unknown): Promise<TextAssetCommandOutcome<SafeTextAnnotation[]>> {
  const parsed = replaceClassificationSchema.safeParse(rawInput);
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
      hash: { commandKind: "replaceClassification", sourceIdentity: input.sourceIdentity, expectedPolicyRevision: input.expectedPolicyRevision, data: input.command },
    },
    (tx, ctx) => applyReplaceClassification(tx, ctx, resolved.verifiedSource, { operationId: input.operationId, expectedPolicyRevision: input.expectedPolicyRevision, groupId: input.command.groupId, memberLabelIds: input.command.memberLabelIds, expectedMembers: input.command.expectedMembers }),
  );
}
