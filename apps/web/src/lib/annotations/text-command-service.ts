import "server-only";

import { Prisma } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission, type DatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { claimEditableAssetContent } from "@/lib/workflow/asset-workflow-service";
import { computeTextCommandRequestHash, recordTextMutationReceipt, resolveTextReceiptReplay, type TextCommandHashInput } from "@/lib/annotations/text-mutation-receipt";

/**
 * The single guarded transaction orchestrator every TEXT mutation uses
 * (data-model.md "Atomic command algorithm"). No story should introduce a
 * second write path. Two entry points:
 *
 * - `runGuardedTextAssetCommand`: annotation commands (span/classification/
 *   relation). Claims the dataset mutation guard, resolves receipt replay,
 *   then claims the editable-asset content guard (rejecting frozen
 *   NEEDS_REVIEW/REVIEWED/REJECTED workflow states) before calling `apply`.
 * - `runGuardedTextDatasetCommand`: policy writes. Claims only the dataset
 *   mutation guard — policy configuration is not an editable-asset claim
 *   and must never require one.
 *
 * `apply` performs the actual command-specific validation and writes; it
 * must throw `TextCommandError` (via `rejectTextCommand`) for any domain
 * rejection so the parent guard claim rolls back with it.
 */

export type TextCommandFailure = "NOT_FOUND" | "FORBIDDEN" | "WORKFLOW_LOCKED" | "DATASET_LOCKED" | "RECEIPT_CONFLICT" | "CONFLICT" | "INVALID_REQUEST";

export class TextCommandError extends Error {
  constructor(readonly reason: TextCommandFailure) {
    super(reason);
    this.name = "TextCommandError";
  }
}

export function rejectTextCommand(reason: TextCommandFailure): never {
  throw new TextCommandError(reason);
}

const TEXT_COMMAND_TRANSACTION_ATTEMPTS = 3;

function isRetryableTextCommandDatabaseError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");
}

/** Serializes all TEXT-sensitive writes for one dataset (annotation and taxonomy alike) behind one guarded counter. */
async function claimDatasetTextMutationGuard(tx: Prisma.TransactionClient, datasetId: string): Promise<boolean> {
  const claimed = await tx.dataset.updateMany({
    where: { id: datasetId, deletedAt: null, archivedAt: null },
    data: { textMutationRevision: { increment: 1 } },
  });
  return claimed.count === 1;
}

async function withRetryableTextTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEXT_COMMAND_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (!isRetryableTextCommandDatabaseError(error) || attempt === TEXT_COMMAND_TRANSACTION_ATTEMPTS - 1) throw error;
    }
  }
  throw lastError;
}

export type TextAssetCommandOutcome<T> =
  | { ok: true; replayed: false; result: T }
  | { ok: true; replayed: true; result: unknown }
  | { ok: false; reason: TextCommandFailure };

export interface RunGuardedTextAssetCommandInput {
  datasetId: string;
  assetId: string;
  operationId: string;
  hash: TextCommandHashInput;
}

export async function runGuardedTextAssetCommand<T>(
  actor: RequestActor,
  input: RunGuardedTextAssetCommandInput,
  apply: (tx: Prisma.TransactionClient, ctx: { assetId: string; datasetId: string; actorId: string }) => Promise<T>,
): Promise<TextAssetCommandOutcome<T>> {
  // Step 1: authenticate/authorize before opening the transaction; rechecked
  // again inside it against current membership/scope.
  const access = await requireDatasetPermission(actor, input.datasetId, "dataset.read");
  if (!access || access.forbidden) return { ok: false, reason: "NOT_FOUND" };

  const requestHash = computeTextCommandRequestHash(input.hash);

  try {
    return await withRetryableTextTransaction(async (tx) => {
      const asset = await tx.asset.findFirst({ where: { id: input.assetId, datasetId: input.datasetId, deletedAt: null, archivedAt: null }, select: { id: true } });
      if (!asset) rejectTextCommand("NOT_FOUND");

      // Step 2: claim the Dataset guard, then check an existing receipt
      // *before* claiming the editable-asset guard or advancing any revision.
      if (!(await claimDatasetTextMutationGuard(tx, input.datasetId))) rejectTextCommand("DATASET_LOCKED");

      const replay = await resolveTextReceiptReplay(tx, { assetId: input.assetId, actorId: actor.id, operationId: input.operationId, requestHash });
      if (replay.kind === "conflict") rejectTextCommand("RECEIPT_CONFLICT");
      if (replay.kind === "hit") return { ok: true as const, replayed: true as const, result: replay.result };

      // New command: claim the editable-asset guard (rejects frozen workflow states).
      if (!(await claimEditableAssetContent(tx, input.assetId, input.datasetId))) rejectTextCommand("WORKFLOW_LOCKED");

      // Steps 3-4: command-specific validation/writes.
      const result = await apply(tx, { assetId: input.assetId, datasetId: input.datasetId, actorId: actor.id });

      // Step 5: receipt commit. The ANNOTATION_CHANGED outbox dispatch is the
      // command's own responsibility (it knows the parent revision), called
      // from inside the same `apply` callback/transaction.
      await recordTextMutationReceipt(tx, { assetId: input.assetId, actorId: actor.id, operationId: input.operationId, requestHash, result: result as Prisma.InputJsonValue });

      return { ok: true as const, replayed: false as const, result };
    });
  } catch (error) {
    if (error instanceof TextCommandError) return { ok: false, reason: error.reason };
    throw error;
  }
}

export type TextDatasetCommandOutcome<T> = { ok: true; result: T } | { ok: false; reason: TextCommandFailure };

export interface RunGuardedTextDatasetCommandInput {
  datasetId: string;
  permission: DatasetPermission;
}

/** Policy writes: dataset-only guard, no editable-asset claim, no receipt replay (policy commands are optimistic-revision-checked by the caller, not operation-id-replayed). */
export async function runGuardedTextDatasetCommand<T>(
  actor: RequestActor,
  input: RunGuardedTextDatasetCommandInput,
  apply: (tx: Prisma.TransactionClient, ctx: { datasetId: string; actorId: string }) => Promise<T>,
): Promise<TextDatasetCommandOutcome<T>> {
  const access = await requireDatasetPermission(actor, input.datasetId, input.permission);
  if (!access) return { ok: false, reason: "NOT_FOUND" };
  if (access.forbidden) return { ok: false, reason: "FORBIDDEN" };

  try {
    return await withRetryableTextTransaction(async (tx) => {
      if (!(await claimDatasetTextMutationGuard(tx, input.datasetId))) rejectTextCommand("DATASET_LOCKED");
      const result = await apply(tx, { datasetId: input.datasetId, actorId: actor.id });
      return { ok: true as const, result };
    });
  } catch (error) {
    if (error instanceof TextCommandError) return { ok: false, reason: error.reason };
    throw error;
  }
}
