import { aggregateImportItems } from "@annotationplatform/domain/import-item-accounting";

import type { Prisma, PrismaClient } from "../../../../lib/generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;
const ITEM_EVENTS = ["IMPORT_ITEM_SUCCEEDED", "IMPORT_ITEM_REJECTED", "IMPORT_ITEM_RETRYABLE"];

/** Stable per-item event ids (identical to the web completion service's), so a replay can never inflate a count. */
export const itemEventId = (outcome: "success" | "rejected" | "retryable", itemId: string) => (outcome === "success" ? `phase029_import_success_${itemId}` : `phase029_${outcome}_${itemId}`);

/** Recomputes and persists the folder import Job's aggregate from durable facts only. Verifying items are reported as `verifying`, never as unprocessed or accepted. */
export async function recomputeFolderAccounting(db: Db, preparedImportId: string) {
  const preparation = await db.preparedImport.findUnique({ where: { id: preparedImportId }, select: { id: true, jobId: true, expectedItemCount: true } });
  if (!preparation) return null;
  const [linked, events, verifying] = await Promise.all([
    db.preparedImportItem.findMany({ where: { preparedImportId, assetId: { not: null } }, select: { id: true } }),
    db.jobEvent.findMany({ where: { jobId: preparation.jobId, message: { in: ITEM_EVENTS } }, select: { message: true, data: true } }),
    db.mediaVerification.findMany({ where: { status: { in: ["PENDING", "SEALED", "VERIFIED"] }, preparedImportItem: { preparedImportId } }, select: { preparedImportItemId: true } }),
  ]);
  const aggregate = aggregateImportItems({
    total: preparation.expectedItemCount,
    linkedItemIds: linked.map((row) => row.id),
    events,
    verifyingItemIds: verifying.map((row) => row.preparedImportItemId).filter((id): id is string => id !== null),
  });
  const processed = aggregate.completed + aggregate.rejected + aggregate.retryable;
  await db.job.updateMany({
    where: { id: preparation.jobId, status: { in: ["RUNNING", "RETRYING"] } },
    data: {
      stage: "WRITING_ASSETS",
      processedItems: Math.min(preparation.expectedItemCount, processed),
      successItems: aggregate.completed,
      failedItems: aggregate.rejected + aggregate.retryable,
      progress: preparation.expectedItemCount ? Math.floor((Math.min(preparation.expectedItemCount, processed) / preparation.expectedItemCount) * 100) : 0,
      errorCode: aggregate.rejected || aggregate.retryable ? "IMPORT_INCOMPLETE" : null,
      summary: { outcome: aggregate.rejected || aggregate.retryable ? "incomplete" : "processing", accepted: aggregate.accepted, unchanged: aggregate.unchanged, rejected: aggregate.rejected, retryable: aggregate.retryable, unprocessed: aggregate.unprocessed, verifying: aggregate.verifying },
    },
  });
  return aggregate;
}

/** One stable, durable disposition per item (skipDuplicates makes a replay a no-op). */
export async function writeItemEvent(db: Db, jobId: string, outcome: "rejected" | "retryable", itemId: string, code: string) {
  await db.jobEvent.createMany({
    data: [{ id: itemEventId(outcome, itemId), jobId, level: outcome === "rejected" ? "WARN" : "INFO", message: outcome === "rejected" ? "IMPORT_ITEM_REJECTED" : "IMPORT_ITEM_RETRYABLE", data: { itemId, code } }],
    skipDuplicates: true,
  });
}
