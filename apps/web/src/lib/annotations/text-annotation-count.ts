import "server-only";

import type { Prisma } from "@internal/db";
import { Modality } from "@internal/db";

/**
 * Transaction-scoped count admission (data-model.md "Transactional count
 * admission and legacy reads"). Called by text-command-service.ts after
 * receipt replay and the dataset/asset guards, never before — a replay must
 * never recount as a new admission, and no slot is reserved outside the
 * transaction.
 */

export async function countCanonicalTextAnnotations(tx: Prisma.TransactionClient, assetId: string): Promise<number> {
  return tx.annotation.count({ where: { assetId, modality: Modality.TEXT } });
}

export type TextAnnotationCountAdmission =
  | { ok: true }
  | { ok: false; reason: "LIMIT_EXCEEDED"; currentCount: number; limit: number };

/**
 * `finalCount` is the semantic command's resulting count (e.g. current + 1
 * for a standalone create, or current - removed + added for an atomic
 * classification replacement). `delta <= 0` is always permitted — even for
 * an asset already over a since-lowered limit — so shrinking/updating never
 * gets blocked by admission; only a positive delta is checked against the
 * limit, so swapping at exactly the limit is allowed but growing past it
 * never is.
 */
export function evaluateTextAnnotationCountAdmission(input: { currentCount: number; finalCount: number; limit: number }): TextAnnotationCountAdmission {
  const delta = input.finalCount - input.currentCount;
  if (delta <= 0) return { ok: true };
  if (input.finalCount <= input.limit) return { ok: true };
  return { ok: false, reason: "LIMIT_EXCEEDED", currentCount: input.currentCount, limit: input.limit };
}
