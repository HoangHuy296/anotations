# Dataset resolution and fence semantics — as they are today (read before T031)

Source of truth: the frozen migration 24 SQL (SHA-256 `13f0e977…`, `prisma/migrations/20260930030000_dataset_modality_g2/migration.sql`) and `apps/web/src/lib/datasets/modality.ts` (`resolveEmptyDataset`). Nothing here is assumed; every statement cites a line of one of them. T031 does not change either.

## The counter: `Dataset.modalityContentRevision`
- `BIGINT NOT NULL DEFAULT 0`; every existing Dataset starts at 0 (the migration adds the column with a constant default).
- It is a **monotonic fence**, not a count of Assets. `phase029_guard_dataset_assignment()` rejects any UPDATE that lowers it (`DATASET_MODALITY_FENCE_REWIND`, migration lines 34–36).
- Who increments it (exactly +1 each time):
  1. `phase029_guard_asset_write()` — on every Asset INSERT, every Asset DELETE and every Asset UPDATE whose **evidence row** changed (datasetId, modality, sourceMode, storageProvider/Bucket/Key, checksum, externalRepositoryId, sourceProvider/Ref/Revision/Path, relativePath, sourceFileSha, sourceBlobSha, sourceLfsOid, sourceEtag, sourceUrl, sourceFingerprint, currentVersionId, mimeType, sizeBytes, width, height, durationMs, textLength — lines 72–86). For old and new parent, in sorted id order (lines 100–103). A non-evidence UPDATE (revision, status, description, assignee, deletedAt …) takes no parent write (lines 88–98).
  2. `resolveEmptyDataset` — an explicit `UPDATE … SET modalityContentRevision = modalityContentRevision + 1` before it counts Assets (`modality.ts`, the "approved parent fence" statement).
- The Asset trigger's parent `UPDATE` takes the Dataset **row lock**, so evidence-changing Asset writers and a resolver serialize on that row.
- The assignment UPDATE itself (NULL → modality) does **not** touch the counter (migration lines 43–48 only compare Assets and stamp `modalityResolvedAt`). So after `resolveEmptyDataset` the counter equals (value before) + 1, where the +1 is the resolver's own explicit fence statement.

## The assignment guard (NULL → modality)
`phase029_guard_dataset_assignment()` runs BEFORE UPDATE on `Dataset` (lines 32–53):
- Lowered counter → rejected.
- If `OLD.modality` is set: modality, `modalityResolvedAt` and `modalityResolverSubject` are immutable (`DATASET_MODALITY_IMMUTABLE`).
- If `OLD.modality` is NULL and `NEW.modality` is set: rejected (`ASSET_MODALITY_MISMATCH`) if **any** Asset of the Dataset — including soft-deleted rows — has a different modality; otherwise `modalityResolvedAt := transaction_timestamp()`.
- The CHECK `dataset_modality_resolution_shape` additionally requires modality, resolvedAt and subject to be all NULL or all set, with the subject 1–128 characters.
- Consequence: the database already refuses to assign a modality that contradicts any existing Asset row, but it does **not** check subtype rows, storage references, objects, in-flight work, or that the Dataset is live. Those checks belong to T029/T031.

## The existing human path and why it is separate
`resolveEmptyDataset` is authority-bound to `canResolveEmptyDataset` (the owner or a current system ADMIN, re-read in the transaction), refuses a Dataset with any Asset (`DATASET_NOT_EMPTY`), uses a Serializable transaction wrapped in `retryModalityTransaction` (three attempts, only for P2034/40001/40P01), and records the **actor's user id** as the subject. It is the EMPTY path (decision D-7) and stays untouched. The historical SINGLE backfill is a different authority: no actor, an evidence manifest, and an opaque `system:phase029-backfill:<run-token>` subject (decision D-6). The two share only the database guard and the retry helper.

## T031 protocol derived from the above (no `dry-run counter + 1` assumption)
Inside one Serializable transaction per approved Dataset:
1. **Compare-and-swap claim:** `UPDATE "Dataset" SET modalityContentRevision = modalityContentRevision + 1 WHERE id = $1 AND modality IS NULL AND deletedAt IS NULL AND archivedAt IS NULL AND modalityContentRevision = $manifestRevision`. Exactly one row must change; zero means the fence moved, the Dataset was resolved, or it is no longer live → stop with `STALE_DATASET_FENCE`/`DATASET_NOT_ELIGIBLE`. The equality is against the **manifest value**, so no arithmetic about a future value is assumed. The `+ 1` is only the claim's own write, taken so the row lock is held and a concurrent evidence writer must wait or fail.
2. **Evidence re-read under the lock:** read every Asset row (including soft-deleted) with the same select as T029, recompute the digest, and require equality with the manifest digest, plus the same single modality and the same subtype/storage conditions → otherwise stop with `ASSET_EVIDENCE_CHANGED`.
3. **In-flight re-check** (non-terminal Job or PREPARING import for the Dataset) → stop `INFLIGHT_WORK_PRESENT`.
4. **Assignment:** `UPDATE … SET modality, modalityResolverSubject` (the trigger repeats the all-Asset equality check and stamps `modalityResolvedAt`).
5. Read the receipt back inside the transaction. Any thrown rejection rolls back the claim as well as the assignment (atomic).
Object metadata (existence, size, and the recorded ETag where one is recorded) is re-checked **before** opening the transaction, outside any database lock, because database locks do not freeze object storage. A failure there stops the run with no write for that Dataset.

## Accounting (deterministic, no silent partial success)
Datasets are processed in the manifest's order (ascending Dataset id). Each ends as exactly one of: `COMMITTED` (assigned by this run), `COMMITTED_REPLAY` (already assigned by this exact run token and modality, so a re-run after an interruption is idempotent), `STOPPED` (the first failing Dataset, with a code), or `NOT_ATTEMPTED` (everything after the stop). The run result is `COMPLETED` only when every candidate is COMMITTED or COMMITTED_REPLAY; otherwise `STOPPED`, with `committed + stopped + notAttempted = candidates`. Committed assignments are never undone (they are immutable by trigger); a stop leaves the remaining Datasets unresolved, which is the safe state.
