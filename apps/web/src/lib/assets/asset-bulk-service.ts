import "server-only";

import { AssetStatus, type Prisma } from "@internal/db";

import { db } from "@/lib/db";
import { buildAssetListWhere } from "@/lib/workspace/workspace-assets";
import { BULK_SYNC_MAX_ASSETS, type AssetListQuery, type BulkOperationResult } from "@/types/workspace";

/**
 * The wire shape of a bulk request's `selection` field (matches
 * `bulkSelectionQuerySchema`/`assetBulkRequestSchema` exactly) -- distinct
 * from `types/workspace.ts`'s client-store-oriented `BulkSelection`, which
 * additionally tracks `datasetId` for the selection store's own bookkeeping.
 * `datasetId` is never read from the request body here; it is always the
 * caller's own server-verified URL parameter (022 §35).
 */
export type BulkSelectionInput = { mode: "EXPLICIT"; assetIds: string[] } | { mode: "FILTERED"; query: AssetListQuery };

export type ResolvedSelection =
  | { ok: true; assetIds: string[]; notFoundIds: string[] }
  | { ok: false; reason: "TOO_LARGE"; max: number; resolvedCount: number };

const workflowGovernedStatuses: AssetStatus[] = [AssetStatus.IN_PROGRESS, AssetStatus.NEEDS_REVIEW, AssetStatus.REVIEWED, AssetStatus.REJECTED];
export class WorkflowStatusRequiresTransitionError extends Error {
  constructor() { super("WORKFLOW_STATUS_REQUIRES_TRANSITION"); }
}

/**
 * Resolves a `BulkSelectionInput` to concrete Asset ids, entirely
 * server-side and scoped to `datasetId` -- a malicious client can never
 * manipulate Assets outside the Dataset/user scope this way (022 §35,
 * FR-021). For `FILTERED`, this reuses the exact same `buildAssetListWhere`
 * the Assets tab and the list API use, so "what matches this query" is
 * answered identically everywhere (research.md §1/§4). Never returns more
 * than `maxAssets` ids to the caller -- callers exceeding it get
 * `TOO_LARGE` instead, never a silently truncated batch (FR-026 "no
 * arbitrary take/limit").
 */
export async function resolveBulkSelection(datasetId: string, selection: BulkSelectionInput, maxAssets = BULK_SYNC_MAX_ASSETS): Promise<ResolvedSelection> {
  if (selection.mode === "EXPLICIT") {
    if (selection.assetIds.length > maxAssets) return { ok: false, reason: "TOO_LARGE", max: maxAssets, resolvedCount: selection.assetIds.length };
    const rows = await db.asset.findMany({ where: { id: { in: selection.assetIds }, datasetId, deletedAt: null }, select: { id: true } });
    const foundIds = new Set(rows.map((row) => row.id));
    return { ok: true, assetIds: [...foundIds], notFoundIds: selection.assetIds.filter((id) => !foundIds.has(id)) };
  }
  const where = buildAssetListWhere(datasetId, selection.query);
  const resolvedCount = await db.asset.count({ where });
  if (resolvedCount > maxAssets) return { ok: false, reason: "TOO_LARGE", max: maxAssets, resolvedCount };
  const rows = await db.asset.findMany({ where, select: { id: true }, take: maxAssets });
  return { ok: true, assetIds: rows.map((row) => row.id), notFoundIds: [] };
}

export type StrictResolvedSelection =
  | { ok: true; assetIds: string[] }
  | { ok: false; reason: "EMPTY" }
  | { ok: false; reason: "TOO_LARGE"; max: number }
  | { ok: false; reason: "MEMBER_NOT_FOUND" };

/**
 * All-or-nothing, ordered resolution for callers that must not act on a
 * partial target (AI acceptance, feature 026). The existing
 * `resolveBulkSelection` keeps its partial-skip semantics for the organize
 * actions; this is a separate mode, not a change to them.
 *
 * - EXPLICIT: ids are deduplicated before the limit check; every id must be a
 *   live, unarchived Asset of this dataset, otherwise the whole request is
 *   rejected (`MEMBER_NOT_FOUND`) without saying which id.
 * - FILTERED: one query reads `max + 1` rows so an over-limit match is
 *   rejected instead of silently truncated; membership is decided once, here.
 * - Both return ids ordered by `id ASC`, independent of any UI sort.
 * `client` may be a transaction client so resolution shares the acceptance
 * transaction's snapshot.
 */
export async function resolveBulkSelectionStrict(
  datasetId: string,
  selection: BulkSelectionInput,
  maxAssets: number,
  client: Pick<Prisma.TransactionClient, "asset"> = db,
): Promise<StrictResolvedSelection> {
  if (selection.mode === "EXPLICIT") {
    const unique = [...new Set(selection.assetIds)];
    if (unique.length === 0) return { ok: false, reason: "EMPTY" };
    if (unique.length > maxAssets) return { ok: false, reason: "TOO_LARGE", max: maxAssets };
    const rows = await client.asset.findMany({ where: { id: { in: unique }, datasetId, deletedAt: null, archivedAt: null }, select: { id: true }, orderBy: { id: "asc" } });
    if (rows.length !== unique.length) return { ok: false, reason: "MEMBER_NOT_FOUND" };
    return { ok: true, assetIds: rows.map((row) => row.id) };
  }
  const rows = await client.asset.findMany({ where: buildAssetListWhere(datasetId, selection.query), select: { id: true }, orderBy: { id: "asc" }, take: maxAssets + 1 });
  if (rows.length === 0) return { ok: false, reason: "EMPTY" };
  if (rows.length > maxAssets) return { ok: false, reason: "TOO_LARGE", max: maxAssets };
  return { ok: true, assetIds: rows.map((row) => row.id) };
}

function baseResult(assetIds: string[], notFoundIds: string[]): BulkOperationResult {
  return {
    processed: assetIds.length + notFoundIds.length,
    succeeded: 0,
    failed: 0,
    skipped: notFoundIds.length,
    failures: notFoundIds.map((assetId) => ({ assetId, reason: "not_in_dataset" })),
  };
}

/** Idempotent: an asset that already has the label is reported skipped, never failed or duplicated (FR-019/FR-014). */
export async function addLabelBulk(assetIds: string[], notFoundIds: string[], labelId: string, createdById: string): Promise<BulkOperationResult> {
  const result = baseResult(assetIds, notFoundIds);
  const already = await db.assetLabel.findMany({ where: { assetId: { in: assetIds }, labelId }, select: { assetId: true } });
  const alreadySet = new Set(already.map((row) => row.assetId));
  const toCreate = assetIds.filter((id) => !alreadySet.has(id));
  if (toCreate.length > 0) {
    await db.assetLabel.createMany({ data: toCreate.map((assetId) => ({ assetId, labelId, createdById })), skipDuplicates: true });
  }
  result.succeeded = toCreate.length;
  result.skipped += alreadySet.size;
  result.failures = [...(result.failures ?? []), ...[...alreadySet].map((assetId) => ({ assetId, reason: "already_labeled" }))];
  return result;
}

/** Idempotent: an asset without the label is reported skipped, never failed (FR-019/FR-015). Never touches Annotation rows. */
export async function removeLabelBulk(assetIds: string[], notFoundIds: string[], labelId: string): Promise<BulkOperationResult> {
  const result = baseResult(assetIds, notFoundIds);
  const existing = await db.assetLabel.findMany({ where: { assetId: { in: assetIds }, labelId }, select: { assetId: true } });
  const existingIds = existing.map((row) => row.assetId);
  if (existingIds.length > 0) await db.assetLabel.deleteMany({ where: { assetId: { in: existingIds }, labelId } });
  const notLabeled = assetIds.filter((id) => !existingIds.includes(id));
  result.succeeded = existingIds.length;
  result.skipped += notLabeled.length;
  result.failures = [...(result.failures ?? []), ...notLabeled.map((assetId) => ({ assetId, reason: "not_labeled" }))];
  return result;
}

/** Asset status only -- never touches Annotation/Job/AI task status (FR-017). Setting the current status is a genuine no-op success, not a skip (Edge Cases). */
export async function changeStatusBulk(datasetId: string, assetIds: string[], notFoundIds: string[], status: AssetStatus): Promise<BulkOperationResult> {
  if (workflowGovernedStatuses.includes(status)) throw new WorkflowStatusRequiresTransitionError();
  const protectedCount = await db.asset.count({ where: { id: { in: assetIds }, datasetId, status: { in: workflowGovernedStatuses } } });
  if (protectedCount) throw new WorkflowStatusRequiresTransitionError();
  const result = baseResult(assetIds, notFoundIds);
  const updated = await db.asset.updateMany({ where: { id: { in: assetIds }, datasetId }, data: { status } });
  result.succeeded = updated.count;
  return result;
}

/**
 * Soft-deletes (`Asset.deletedAt`) every selected asset -- never a hard
 * delete, and never a synchronous MinIO call (FR-020-023). Storage cleanup
 * is left entirely to the existing Phase 21 GC path (the periodic orphan
 * scanner already treats a soft-deleted Asset's `storageKey` as
 * unreferenced and reclaims it on its normal cadence); this function's job
 * ends at the database boundary, so PostgreSQL deletion never depends on
 * MinIO availability. Idempotent: an asset already deleted (by a prior call
 * or a concurrent one) simply doesn't match `deletedAt: null` any more, so
 * it's reported skipped, never failed, on retry.
 */
export async function deleteAssetsBulk(datasetId: string, assetIds: string[], notFoundIds: string[]): Promise<BulkOperationResult> {
  const result = baseResult(assetIds, notFoundIds);
  const deleted = await db.asset.updateMany({ where: { id: { in: assetIds }, datasetId, deletedAt: null }, data: { deletedAt: new Date() } });
  result.succeeded = deleted.count;
  const alreadyDeletedCount = assetIds.length - deleted.count;
  result.skipped += alreadyDeletedCount;
  return result;
}

/** `assignedToId`, when non-null, must already be a DatasetMember of this dataset -- the 022 assignment boundary (FR-018), not a full collaboration system. */
export async function assignBulk(datasetId: string, assetIds: string[], notFoundIds: string[], assignedToId: string | null): Promise<{ ok: true; result: BulkOperationResult } | { ok: false; reason: "INVALID_ASSIGNEE" }> {
  if (assignedToId) {
    const member = await db.datasetMember.findFirst({ where: { datasetId, userId: assignedToId }, select: { id: true } });
    if (!member) return { ok: false, reason: "INVALID_ASSIGNEE" };
  }
  const result = baseResult(assetIds, notFoundIds);
  const updated = await db.asset.updateMany({ where: { id: { in: assetIds }, datasetId }, data: { assignedToId } });
  result.succeeded = updated.count;
  return { ok: true, result };
}
