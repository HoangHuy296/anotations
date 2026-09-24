import "server-only";

import type { Prisma } from "@internal/db";
import { Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { rejectTextCommand } from "@/lib/annotations/text-command-service";
import { readTextSource } from "@/lib/annotations/text-source-read-service";

/**
 * Shared precondition checks every TEXT annotation command needs, regardless
 * of what kind of `Annotation` row it writes (span, relation, classification
 * to come) -- pulled out of `text-span-service.ts` so `text-relation-service.ts`
 * can reuse the identical source/policy-revision guarding without either
 * service importing the other (avoids a span<->relation service cycle).
 */

export interface VerifiedTextSourceContext {
  sourceIdentity: string;
  sourceCodeUnitLength: number;
  boundaryOffsets: readonly number[];
}

export async function recheckSourceIdentity(tx: Prisma.TransactionClient, assetId: string, verifiedSource: VerifiedTextSourceContext): Promise<void> {
  const current = await tx.textAsset.findUnique({ where: { assetId }, select: { sourceIdentity: true } });
  if (!current || current.sourceIdentity !== verifiedSource.sourceIdentity) rejectTextCommand("SOURCE_MISMATCH");
}

export async function recheckPolicyRevision(tx: Prisma.TransactionClient, datasetId: string, expectedPolicyRevision: number): Promise<void> {
  const dataset = await tx.dataset.findUnique({ where: { id: datasetId }, select: { textPolicyRevision: true } });
  if (!dataset || dataset.textPolicyRevision !== expectedPolicyRevision) rejectTextCommand("POLICY_STALE");
}

/**
 * Resolves the datasetId + verified (I/O-checked, outside-transaction)
 * source context for a fresh command, against the `sourceIdentity` the
 * client's command envelope claims. Every command re-verifies this claim
 * again inside its transaction via `recheckSourceIdentity` -- this call is
 * the expensive read (`readTextSource`), the in-transaction recheck is the
 * cheap one.
 */
export async function resolveVerifiedSourceForCommand(actor: RequestActor, assetId: string, sourceIdentity: string): Promise<{ ok: true; datasetId: string; verifiedSource: VerifiedTextSourceContext } | { ok: false; reason: "NOT_FOUND" | "SOURCE_NOT_READY" | "SOURCE_MISMATCH" }> {
  const asset = await db.asset.findFirst({ where: { id: assetId, modality: Modality.TEXT, deletedAt: null, archivedAt: null }, select: { datasetId: true } });
  if (!asset) return { ok: false, reason: "NOT_FOUND" };

  const sourceOutcome = await readTextSource(actor, assetId);
  if (!sourceOutcome.ok) return { ok: false, reason: "NOT_FOUND" };
  if (sourceOutcome.readiness !== "READY") return { ok: false, reason: "SOURCE_NOT_READY" };
  if (sourceOutcome.sourceIdentity !== sourceIdentity) return { ok: false, reason: "SOURCE_MISMATCH" };

  return {
    ok: true,
    datasetId: asset.datasetId,
    verifiedSource: { sourceIdentity: sourceOutcome.sourceIdentity, sourceCodeUnitLength: sourceOutcome.sourceCodeUnitLength, boundaryOffsets: sourceOutcome.boundaryOffsets },
  };
}
