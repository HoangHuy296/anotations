/**
 * Deterministic local-folder item accounting (contract sections 5.3, 9). One pure implementation shared by the web completion/commit
 * services and the worker publisher so the same inputs can never produce two different aggregates.
 *
 * Inputs are durable facts only: which items are linked to an Asset, the stable per-item JobEvents (`IMPORT_ITEM_SUCCEEDED` with a
 * disposition, `IMPORT_ITEM_REJECTED`, `IMPORT_ITEM_RETRYABLE`) and which items currently have a NON-TERMINAL media verification.
 * A verifying item is never reported as accepted/unchanged/rejected/retryable and is never "unprocessed": it is `verifying`.
 */
export type ImportItemEvent = { message: string; data?: unknown };

export type ImportItemAggregate = {
  accepted: number; unchanged: number; rejected: number; retryable: number; verifying: number; unprocessed: number; completed: number; total: number;
};

const itemIdOf = (event: ImportItemEvent): string | null => {
  const id = (event.data as { itemId?: unknown } | null | undefined)?.itemId;
  return typeof id === "string" ? id : null;
};

export function aggregateImportItems(input: {
  total: number;
  linkedItemIds: Iterable<string>;
  events: Iterable<ImportItemEvent>;
  verifyingItemIds?: Iterable<string>;
}): ImportItemAggregate {
  const linked = new Set(input.linkedItemIds);
  const events = [...input.events];
  const verifying = new Set([...(input.verifyingItemIds ?? [])].filter((id) => !linked.has(id)));
  const accepted = new Set(events
    .filter((event) => event.message === "IMPORT_ITEM_SUCCEEDED" && (event.data as { disposition?: unknown } | null | undefined)?.disposition === "accepted")
    .map(itemIdOf).filter((id): id is string => id !== null && linked.has(id))).size;
  const unchanged = Math.max(0, linked.size - accepted);
  const rejectedIds = new Set(events.filter((event) => event.message === "IMPORT_ITEM_REJECTED").map(itemIdOf).filter((id): id is string => id !== null && !linked.has(id) && !verifying.has(id)));
  const retryableIds = new Set(events.filter((event) => event.message === "IMPORT_ITEM_RETRYABLE").map(itemIdOf).filter((id): id is string => id !== null && !linked.has(id) && !rejectedIds.has(id) && !verifying.has(id)));
  const rejected = rejectedIds.size, retryable = retryableIds.size;
  const unprocessed = Math.max(0, input.total - linked.size - rejected - retryable - verifying.size);
  return { accepted, unchanged, rejected, retryable, verifying: verifying.size, unprocessed, completed: linked.size, total: input.total };
}
