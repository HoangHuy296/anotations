import "server-only";

import { JobStage, type Prisma } from "@internal/db";
import { aggregateImportItems, type ImportItemAggregate } from "@annotationplatform/domain/import-item-accounting";

import type { db } from "@/lib/db";

type Client = Prisma.TransactionClient | typeof db;
const ITEM_EVENTS = ["IMPORT_ITEM_SUCCEEDED", "IMPORT_ITEM_REJECTED", "IMPORT_ITEM_RETRYABLE"];
const NON_TERMINAL = ["PENDING", "SEALED", "VERIFIED"] as const;

/**
 * Folder item accounting from durable facts only, through the single pure aggregator shared with the worker publisher. An item with a NON-terminal media verification is
 * `verifying`: it is not accepted, rejected, retryable or unprocessed (contract sections 5.3 and 9).
 */
export async function computeFolderAggregate(client: Client, preparedImportId: string, jobId: string, total: number): Promise<ImportItemAggregate> {
  const [linked, events, verifying] = await Promise.all([
    client.preparedImportItem.findMany({ where: { preparedImportId, assetId: { not: null } }, select: { id: true } }),
    client.jobEvent.findMany({ where: { jobId, message: { in: ITEM_EVENTS } }, select: { message: true, data: true } }),
    client.mediaVerification.findMany({ where: { status: { in: [...NON_TERMINAL] }, preparedImportItem: { preparedImportId } }, select: { preparedImportItemId: true } }),
  ]);
  return aggregateImportItems({
    total,
    linkedItemIds: linked.map((row) => row.id),
    events,
    verifyingItemIds: verifying.map((row) => row.preparedImportItemId).filter((id): id is string => id !== null),
  });
}

/** Persists the aggregate on the folder's receipt Job. `incomplete` forces the legacy failure-path summary outcome. */
export async function persistFolderAggregate(client: Client, jobId: string, total: number, aggregate: ImportItemAggregate, options: { incomplete?: boolean } = {}) {
  const processed = Math.min(total, aggregate.completed + aggregate.rejected + aggregate.retryable);
  const incomplete = aggregate.rejected > 0 || aggregate.retryable > 0;
  await client.job.update({
    where: { id: jobId },
    data: {
      stage: JobStage.WRITING_ASSETS, processedItems: processed, successItems: aggregate.completed, failedItems: aggregate.rejected + aggregate.retryable,
      ...(options.incomplete ? {} : { progress: total ? Math.floor((processed / total) * 100) : 0 }),
      errorCode: incomplete ? "IMPORT_INCOMPLETE" : null,
      summary: { outcome: options.incomplete || incomplete ? "incomplete" : "processing", accepted: aggregate.accepted, unchanged: aggregate.unchanged, rejected: aggregate.rejected, retryable: aggregate.retryable, unprocessed: aggregate.unprocessed, verifying: aggregate.verifying },
    },
  });
}

/** The counts every completion/commit response reports. */
export const folderCounts = (aggregate: ImportItemAggregate) => ({ accepted: aggregate.accepted, unchanged: aggregate.unchanged, rejected: aggregate.rejected, retryable: aggregate.retryable, unprocessed: aggregate.unprocessed, verifying: aggregate.verifying });
