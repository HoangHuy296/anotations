# T029 / T031 — evidence-bound SINGLE-modality backfill: implementation and disposable results

**Status: BUILT and disposable-verified. Not executed on shared dev. No shared-dev migration or backfill is authorized.** This is a library plus a receipt-bound rehearsal; the maintenance-window launcher is not built (see "Not built").

## Implementation (SHA-256 of the files rehearsed)
| File | SHA-256 |
| --- | --- |
| `apps/web/src/lib/datasets/modality-backfill-evidence.ts` (pure rules: classification, digest, manifest, subject, accounting) | `3a13b73efa84740600aefa721f8e2c5ebf3cf90b6d777d140274a58effde7a8c` |
| `apps/web/src/lib/datasets/modality-backfill.ts` (T029 `buildBackfillManifest`, T031 `applyBackfillManifest`) | `054f897334c149d079c875d44f08f0e1c0f8e79e2fa349c49140c3479003333c` |
| `apps/web/src/lib/datasets/modality-backfill-evidence.test.ts` (offline, DB-free, 10 tests; beside its module because every file under `apps/*/tests` must be receipt-gated) | `b610ba30b397b5bea66f7804009ff9b3c4ecd72b3875f53c253d00cc7eaf967e` |
| `apps/web/tests/dataset-modality/backfill-baseline.test.ts` (historical-style seed on the 23-migration baseline) | `5ca5368a1d74a6c7b989ba5d244eef3f83d7de458dbce333ff57864602f95150` |
| `apps/web/tests/dataset-modality/backfill-rehearsal.test.ts` (14 DB-backed tests) | `d140c1afad142af2c77800a0b8f3dedfa0a1e65cc7305935effd2578ad1d9067` |
| `scripts/db-safety/disposable-test.mjs` (new fixed plan `release:phase029-backfill`) | `99629e8b91acce96776fc17cacab25d1845b6568f35d5d9f50ae3834d610a024` |
| `scripts/db-safety/commands.json` (two internal catalog entries) | `401548f0b53d4c2370e4e18cfdf169802c4c4cf3b3a9eef2ce9fabac48395a88` |

No schema, migration or generated-client change; no new package; no raw SQL.

## T029 — manifest (select-only)
`buildBackfillManifest({ statObject, expectedBucket })` reads every Dataset with `findMany/findUnique/count` only (a source test pins that no write call or raw SQL exists in it), one RepeatableRead snapshot per Dataset, then classifies from the Dataset's own Asset rows and checks object metadata through the injected `statObject` (a HEAD/stat-style read; no object bytes). The rehearsal proves a full run changes no Dataset, Asset, Job, import or label row.

**Eligibility rules (a Dataset is a candidate only if all hold, checked in this order):**
1. live (not archived, not deleted) — else `DATASET_NOT_LIVE`; `modality` still NULL — else `DATASET_ALREADY_RESOLVED`;
2. it has Assets — else `EMPTY_DATASET`; exactly one Asset modality across **all** its Asset rows — else `MIXED_MODALITY`;
3. no non-terminal Job (QUEUED/RUNNING/RETRYING/CANCELING) and no PREPARING import — else `INFLIGHT_WORK_PRESENT`;
4. no soft-deleted Asset — else `SOFT_DELETED_ASSET_PRESENT`;
5. every Asset has exactly one subtype row and it matches the Asset modality — else `ASSET_SUBTYPE_MISSING` / `ASSET_SUBTYPE_MISMATCH`;
6. every Asset is `MINIO` with a bucket and key — else `STORAGE_REFERENCE_UNSUPPORTED`; bucket equals the configured bucket — else `BUCKET_NOT_APPROVED` (rejected **before any storage read**); `sizeBytes` recorded — else `SIZE_UNRECORDED`;
7. object metadata: the object exists (`OBJECT_MISSING`), its size equals `Asset.sizeBytes` (`SIZE_MISMATCH`), and, **only when the Asset records `sourceEtag`**, the observed ETag matches after normalizing quotes/weak prefix/case (`ETAG_MISMATCH`). No ETag or version requirement is invented for rows that record none; no full-byte read.
The proposed modality is that single Asset modality. `primaryModality` appears in no type and is never read.

**Manifest binds (per candidate):** Dataset id, modality, `datasetRevision` (the fence value read), Asset count, a deterministic SHA-256 digest over every Asset row (all trigger-evidence columns, soft-delete state and subtype presence, in id order) and the observed object size/ETag per Asset. The manifest has `manifestSha256` over policy + candidates and `approvedIdsDigest` over the sorted ids, is sorted and duplicate-free, and is verified (strict schema, hashes, order) before T031 touches the database. The `rejected` list is informational and not part of the approved hash.

## T031 — assignment
Fence semantics are in `t031-fence-semantics.md`. One Serializable transaction per Dataset, in manifest order, stopping at the first failure:
1. refuse a tampered manifest (`MANIFEST_INVALID`) or a malformed run token (`RUN_TOKEN_INVALID`) before any database access; subject `system:phase029-backfill:<run-token>`;
2. idempotent replay: the same subject and modality already stored → `COMMITTED_REPLAY`; any other resolution → `DATASET_ALREADY_RESOLVED`;
3. object metadata re-verified outside the transaction and compared with the manifest;
4. **compare-and-swap claim** of the fence against the manifest revision (`WHERE modality IS NULL AND live AND modalityContentRevision = <manifest value>`; zero rows → `STALE_DATASET_FENCE`/`DATASET_ALREADY_RESOLVED`/`DATASET_NOT_LIVE`); no `+1` arithmetic is assumed, the `+1` is the claim's own write;
5. all Asset rows re-read under the row lock: count and digest must equal the manifest (`ASSET_EVIDENCE_CHANGED`), the classification must still be the same SINGLE modality, in-flight work re-checked;
6. assign `modality` and the subject (the trigger repeats the all-Asset equality check and stamps `modalityResolvedAt`), read the receipt back.
Any stop rolls back that Dataset entirely (claim included). It reuses only `retryModalityTransaction`/`isModalityTransactionConflict` and the database guard; it never calls `resolveEmptyDataset`, `canResolveEmptyDataset` or any permission check (a source test pins that), because the authority is evidence, not a person.

**Accounting:** outcomes are in manifest order: `COMMITTED`, `COMMITTED_REPLAY`, at most one `STOPPED` (with a code), then `NOT_ATTEMPTED`; counts always add up (`ACCOUNTING_INCONSISTENT` otherwise); `COMPLETED` only when nothing was stopped or left. An `AbortSignal` between Datasets leaves the rest `NOT_ATTEMPTED`. **Receipt:** the immutable Dataset columns (`modality`, `modalityResolvedAt`, subject) plus `revisionBefore`/`revisionAfter` in the run outcome; the run result JSON (including `manifestSha256`) is the per-run evidence.

## Disposable results (canonical 25-migration chain, fresh containers, receipt-bound)
Plan `release:phase029-backfill`: baseline 23 → baseline client generated → seed of 39 historical-style Datasets (+1 user) → M24 → M25 → rehearsal → drift/status check → primary and independent cleanup.
- **PASS `focused-runs/20261006T065713Z-2ff097fa`** and, after restoring the source following the mutation check, **PASS `focused-runs/20261006T070008Z-15b5db36`**: 14/14 DB-backed tests, history 25 with the exact frozen checksums (`13f0e977…`, `a8ffbc84…`), schema entries 1829 → 1841 → 1842 → 1842 (the rehearsal changes no schema or history), all historical Datasets unresolved after M24 and M25, `g2:compatibility` (no drift, 25 migrations up to date), independent cleanup exit 0.
- **Sensitivity check:** with the fence compare-and-swap condition and the digest comparison deliberately removed (`…T065845Z-fcebe7c1`, FAIL), tests 6 (stale fence), 7 (changed Asset evidence) and 14 (final accounting) failed and the rest passed; the source was restored and re-run (the second PASS).
- Cases covered: IMAGE/VIDEO/AUDIO/TEXT SINGLE; ETag recorded and matching; conflicting and agreeing legacy `primaryModality` (the Dataset gets the Asset modality, the legacy value is unchanged); EMPTY, EMPTY with a legacy value, EMPTY already resolved by its owner; MIXED (also with a legacy value); missing subtype; subtype mismatch; no storage key; external storage; unrecorded size; size mismatch; missing object; ETag mismatch; foreign bucket; soft-deleted Asset; in-flight Job; archived; deleted; stale fence (an evidence write and its revert still move the fence); changed Asset evidence without a fence move; changed object metadata after approval (size, then missing); atomicity (failure after the claim and before the assignment, both rolled back, later runs succeed); interruption by storage failure with idempotent re-run; interruption by abort; two concurrent runs (no double assignment, one fence increment, exactly one receipt owner); an evidence writer racing the assignment (waits for the row lock; claim and the writer's own increment both counted); receipt immutability (modality, subject, fence rewind, mismatched Asset all rejected by the database); non-approved Datasets and every legacy `primaryModality` unchanged; the EMPTY human path still works afterwards.
- Offline: evidence rules 10/10; runner plan tests 71/71; full `scripts/db-safety` suite listed in the commit report.

## Cohort-A eligibility from fresh read-only database evidence (2026-10-06T06:57Z, shared dev, no object read)
Applying rules 1–6 to the 67 single-modality Datasets gives **28** candidates (24 IMAGE, 4 VIDEO), 189 → 188 Assets. The earlier proposed 29 included the single TEXT Dataset `cmrono652000d10va60fr6prt` (no annotations), now excluded: its only Asset has no `sizeBytes` and its bucket is `test`, not `annotation-assets` (`SIZE_UNRECORDED`, `BUCKET_NOT_APPROVED`). Rule 7 (the objects exist, sizes match) cannot be evaluated without a storage read and is decided only by the window-time T029 run. The other 38 single-modality Datasets are Cohort B (6, in-flight work), C (22, missing subtype/storage metadata) and D (10, not live); none enters Cohort A.

## Not built / not claimed
- **No shared-dev launcher.** Executing T029/T031 against the shared database needs a receipt-bound maintenance runner (identity pinning to the application system identifier, the approved-manifest hash in the receipt, web and worker stopped, evidence directory) and a storage adapter that implements `StatObject` with the server-side MinIO client. That is the next scoped design and a G-DATA gate.
- Real MinIO was not used: object metadata was an in-memory map behind `statObject`. Production-scale timing and storage failures other than missing/size/ETag/exception were not exercised.
- Cohort B/C/D, EMPTY and MIXED were not touched and no shared-dev value was read or written by the rehearsal.
