import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@internal/db";

/**
 * Canonical request hashing and receipt replay (data-model.md "Mutation
 * receipts"). Distinguishes omitted (`undefined`, stripped from the hash
 * input entirely by the caller's own command schema) from explicit `null`
 * (hashed as the literal JSON `null`) because the schema — not this
 * function — decides which is which; this function only needs a stable,
 * deterministic serialization of whatever it is given.
 */

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export interface TextCommandHashInput {
  commandKind: string;
  sourceIdentity?: string | null;
  expectedPolicyRevision?: number | null;
  expectedRevisions?: Record<string, number>;
  data: unknown;
}

/** Same logical input always hashes identically; any different input (including a changed property patch) hashes differently. */
export function computeTextCommandRequestHash(input: TextCommandHashInput): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export type TextReceiptReplayOutcome =
  | { kind: "none" }
  | { kind: "hit"; result: unknown }
  | { kind: "conflict" };

/**
 * A client generates one opaque operation id per new user intent and reuses
 * it only for transport retries of that exact same intent. Identical replay
 * returns the committed outcome without advancing any revision or emitting
 * another event; changed payload under the same operation id conflicts.
 */
export async function resolveTextReceiptReplay(
  tx: Prisma.TransactionClient,
  input: { assetId: string; actorId: string; operationId: string; requestHash: string },
): Promise<TextReceiptReplayOutcome> {
  const existing = await tx.annotationMutationReceipt.findUnique({
    where: { assetId_actorId_operationId: { assetId: input.assetId, actorId: input.actorId, operationId: input.operationId } },
    select: { requestHash: true, result: true },
  });
  if (!existing) return { kind: "none" };
  if (existing.requestHash !== input.requestHash) return { kind: "conflict" };
  return { kind: "hit", result: existing.result };
}

/** Receipts outlive the annotation they describe (no FK to a live row) so replay history survives deletion. */
export async function recordTextMutationReceipt(
  tx: Prisma.TransactionClient,
  input: { assetId: string; actorId: string; operationId: string; requestHash: string; result: Prisma.InputJsonValue },
) {
  return tx.annotationMutationReceipt.create({
    data: { assetId: input.assetId, actorId: input.actorId, operationId: input.operationId, requestHash: input.requestHash, result: input.result },
  });
}
