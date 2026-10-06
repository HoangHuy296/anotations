# Phase 029 — Dataset and Asset writer inventory (T018 writer audit)

Method: source search of production TypeScript in `apps/web/src`, `apps/worker/src` and `packages/*/src` for Prisma `asset.create/createMany/upsert`, nested `assets:`/subtype creates, subtype `create/upsert`, and Asset updates that move `datasetId`. Pinned by the offline test `scripts/db-safety/tests/asset-writer-inventory.test.mjs`, which fails if any writer appears, disappears or changes count without updating this audit. This document is evidence of the audit, not a change to behavior.

## Production Asset creators

| File | Writes | Parent-modality guard |
| --- | --- | --- |
| `apps/web/src/lib/asset-upload.ts` (`publishUploadedAsset`) | 4 × `asset.create` (IMAGE/VIDEO/TEXT/AUDIO, each with its subtype in the same nested create), inside one transaction | `assertAssetModality(parent, verified)` inside the transaction; the same assertion on the outer replay and on the in-transaction duplicate branch |
| `apps/worker/src/jobs/repository-asset-upsert.ts` | 1 × `asset.create` (subtype nested, chosen from the verified modality) plus an exact-reuse branch | `assertAssetModality` on create/reuse; `reconcileMirroredRepositoryAsset` asserts it again on reconciliation |
| `apps/web/src/lib/dataset-import.ts` (`persistDatasetImport`) | `asset.upsert` with a hardcoded IMAGE subtype | **Dormant**: no production caller (pinned by the test). Guards an existing Dataset's modality and rejects non-IMAGE batches. Intentionally unmodified in this checkpoint |

The prepared (local-folder) item path creates no Asset itself: `lib/imports/complete-local-folder-item.ts` calls `publishUploadedAsset`; its completed-item replay compares the linked Asset's modality with the parent (`completedAsset.modality !== parent.modality`).

## Subtype upserts (rows for EXISTING Assets, never Asset creators)

| File | Upsert | Guard |
| --- | --- | --- |
| `apps/worker/src/jobs/text-source-prepare.processor.ts` | `textAsset.upsert` | Asset lookup filters `modality: "TEXT"` before and inside the transaction |
| `apps/worker/src/jobs/video-metadata.ts` | `videoAsset.upsert` | Asset lookup filters `modality: "VIDEO"` (twice, including the live re-check) |
| `apps/worker/src/jobs/audio-waveform.ts` | `audioAsset.upsert` | Asset lookup filters `modality: "AUDIO"` |
| `apps/worker/src/jobs/ai-video-prediction-writer.ts` | `videoAsset.upsert` | Task modality must be VIDEO and the per-Asset claim filters `modality: "VIDEO"` |

## Not present in production code
No `asset.createMany`; no Dataset→Assets nested create; no direct subtype `create`/`createMany`; no Asset update that changes `datasetId` (no reparent) and no restore/undelete writer (`packages/domain/src/asset-revival.ts` is a pure contract).

## Non-production writers (reported, not executed here)
`scripts/db-safety/runtime-e2e.mjs`, `apps/web/scripts/visualization-phase4-smoke.ts`, and 93 test files create Assets for fixtures. They are outside the production boundary; test fixtures run only through receipt-bound disposable infrastructure.

## Dataset and Asset update/delete writers (T018 completion, 2026-10-05)

Companion pin: `scripts/db-safety/tests/dataset-asset-writer-matrix.test.mjs` fails if any production `dataset.create/update/updateMany/upsert/delete`, `asset.update/updateMany/delete` or raw write (`$executeRaw*`) appears, disappears or changes count without updating this document. Production raw SQL (`$queryRaw`) exists only against `Job`/`JobEvent` tables (pinned: it never names `Dataset` or `Asset`).

Classes: **G** guarded and verified, **D** dormant/unreachable with evidence, **I** intentionally incompatible (fails closed by design), **U** unresolved blocker. **U is empty.**

### What the migration 24 triggers do to a writer (read from the frozen SQL, SHA-256 `13f0e977…`)
- `dataset_modality_insert_guard` (BEFORE INSERT on Dataset): `modality IS NULL` raises `DATASET_MODALITY_REQUIRED`.
- `dataset_modality_assignment_guard` (BEFORE UPDATE on Dataset): rejects a lowered content revision, any change of a non-null modality/receipt, and a NULL→value assignment while an Asset of a different modality exists. UPDATEs that touch no modality column pass for resolved and unresolved rows.
- `asset_modality_write_guard` (BEFORE INSERT/UPDATE/DELETE on Asset): an INSERT or any UPDATE that changes the evidence row (datasetId, modality, source identity, storage, mime/size, width/height/duration/textLength …) takes the parent fence (bumps `modalityContentRevision`) and rejects an unresolved parent for INSERT or for a datasetId/modality change, and a modality mismatch. An UPDATE of non-evidence columns (revision, status, description, assignee, deletedAt …) takes no parent write: it reads the parent modality and rejects only a mismatch. DELETE takes the fence; a cascade from a Dataset delete is allowed.

### Dataset writers
| Writer | Operation | Fields | Trigger consequence | Class and evidence |
| --- | --- | --- | --- | --- |
| `apps/web/src/app/api/datasets/route.ts` | INSERT | explicit `modality` + `modalityResolverSubject`, confirmed labels | accepted; trigger stamps `modalityResolvedAt` | **G** — `web:test:dataset-metadata`, T015 creation paths, G2 candidate DB test (NULL rejected) |
| `apps/web/src/lib/queue/enqueue-job.ts` | INSERT (repository start) | explicit modality | accepted | **G** — T015 creation paths |
| `apps/web/src/lib/imports/prepare-local-folder-import.ts` | INSERT (folder start); append path rejects an unresolved parent (`DATASET_MODALITY_UNRESOLVED`) | explicit modality | accepted | **G** — `web:test:local-folder-modality-idempotency`, T015 |
| `apps/web/src/lib/datasets/modality-backfill.ts` (T031, `applyBackfillManifest`) | UPDATE (fence claim, compare-and-swap on the manifest revision) + UPDATE (assignment of `modality` and the opaque `system:phase029-backfill:<run-token>` subject) | the trigger repeats the all-Asset equality check and stamps `modalityResolvedAt`; no actor authority, no route or job reaches it (pinned) | **G** — `release:phase029-backfill` PASS (14 DB-backed cases incl. stale fence, changed evidence, atomicity, interruption, concurrency, immutability); not executed on shared dev |
| `apps/web/src/lib/datasets/modality.ts` | UPDATE ×2 (fence bump, EMPTY assignment) | `modalityContentRevision`, `modality`, `modalityResolverSubject` | designed counterpart of the assignment guard | **G** — G2 candidate tests; G3 correctness/contention (disposable) |
| `apps/web/src/app/api/datasets/[datasetId]/route.ts` (PATCH, DELETE→archive) | UPDATE ×2 | strict schema: name/description/metadata/`primaryModality` (legacy), `archivedAt`; never `modality` | passes for resolved and unresolved parents | **G** — `web:test:dataset-patch-route`. Note: legacy `primaryModality` stays writable and is not authoritative |
| `apps/web/src/app/(app)/datasets/actions.ts` | UPDATE | `archivedAt` | passes | **G** |
| `apps/web/src/lib/workspace/label-management.ts` | UPDATE ×2 | `textPolicyRevision` | passes | **G** |
| `apps/web/src/lib/annotations/text-policy-write-service.ts` | UPDATE | `textPolicy`, `textPolicyRevision` | passes | **G** |
| `apps/web/src/lib/annotations/text-command-service.ts` | UPDATE (claim) | non-modality claim columns | passes | **G** |
| `apps/worker/src/jobs/visualization.processor.ts` | UPDATE, UPDATE (fence) | visualization generation/snapshot | passes | **G** |
| `apps/worker/src/queue/deleted-dataset-cleanup.ts` | hard DELETE (cascade) | — | Asset DELETE trigger tolerates the parent being deleted | **G** — G3 correctness "dataset hard-delete cascade with Assets and annotations" |
| `apps/web/src/lib/dataset-import.ts` (`persistDatasetImport`) | INSERT + UPDATE | no modality | would fail closed | **D** — no production caller (pinned); unmodified |

The only caller of `applyApprovedBackfill`/`buildBackfillManifest` is the maintenance child `apps/web/scripts/backfill-run.ts`, started only by `scripts/db-safety/backfill-launcher.mjs` (hash-bound, fenced, disposable targets only until a reviewed enablement); it is outside the application source roots and reachable from no route, action or job.

### Asset update writers (no production writer creates, reparents or deletes an Asset outside the creators above; `asset.delete*` and `datasetId` updates are absent and pinned)
| Class of write | Writers | Trigger path | Class and evidence |
| --- | --- | --- | --- |
| Non-evidence columns (revision, status, description, assignee, deletedAt) | `text-classification-service`, `text-relation-service`, `text-span-service` ×3, `asset-bulk-service` ×3, `asset-assignment-service` ×2, `dataset-membership-service`, `asset-workflow-service` ×2, `image-mutations`, `text-mutations`, `video-mutations`, worker `ai-prediction-writer`, worker `bulk-delete-assets` | cheap path: parent modality read, no parent write | **G** — G3 correctness "unchanged-modality metadata and cleanup allowed", "metadata/workflow preserve revision semantics", "different-Asset metadata writes skip parent fence and do not block each other" (disposable) |
| Evidence columns (`width`/`height`, `durationMs`) with datasetId and modality unchanged | `api/images/[imageId]/dimensions`, worker `video-metadata`, worker `audio-waveform`, worker `ai-video-prediction-writer` | parent fence taken (revision +1); an unresolved parent is accepted because datasetId/modality do not change | **G** — G3 correctness: a `width` update on an unresolved parent's Asset succeeds and the parent stays unresolved; identity-column transitions advance the fence. `durationMs` belongs to the same evidence row list (static read of the SQL) |

### Asset creators
Unchanged from the section above: `asset-upload.ts` (**G**: `g4-upload-publisher`, `verify:ingestion-replay-summary` 12/12, `web:test:local-folder-modality-idempotency`), worker `repository-asset-upsert.ts` (**G**: `worker:test:ingestion-replay-reuse` 4/4), `dataset-import.ts` (**D**).

### Non-production writers (operator scripts and fixtures; none is wired into a package script, the application or the worker)
| Writer | Effect after migration 24 | Class |
| --- | --- | --- |
| `prisma/review.seed.ts` (`dataset.create` without modality) | fails closed `DATASET_MODALITY_REQUIRED` | **I** — not referenced by any package script |
| `apps/web/scripts/visualization-phase4-smoke.ts` (Dataset create without modality, Asset create) | fails closed | **I** — manual smoke script documented in the Phase 4 report only |
| `scripts/027-verify-trigger.ts` (Dataset create without modality, raw Asset insert) | fails closed | **I** — Phase 027 verification script, unreferenced |
| `scripts/027-backfill-relative-path.ts` (raw `UPDATE "Asset" SET "relativePath"`) | evidence-column update, datasetId/modality unchanged: accepted; bumps the parent revision on resolved parents | **D** — operator-run Phase 027 script, unreferenced; trigger-compatible |
| `scripts/sync-dev-to-review.sh` (full dump/restore) | exits 1 on its fourth line (`DB_SAFETY_SYNC_DISABLED`) | **I** — disabled by the G1 safety work |
| `scripts/db-safety/runtime-e2e.mjs`, 93 test files | fixtures run only through receipt-bound disposable infrastructure; the G5 fixtures create modality-bearing rows | out of the production boundary |

### Disposition
No unresolved active writer. Every production writer is either guarded by an application-level modality guard and verified against the trigger semantics in disposable runs, or touches only columns the triggers do not constrain. Three operator scripts and one seed would fail closed after migration 24; they are not part of the rollout path and are recorded for a later, separately reviewed fix (do not weaken the triggers to accommodate them). Limits: this is static analysis plus disposable-database evidence of the trigger semantics; G5 (browser/runtime end-to-end) remains open, and no writer was exercised end-to-end against a migrated shared database.

### Appendix: audited writer files (pinned by the matrix test)
- `apps/web/src/app/api/datasets/route.ts`
- `apps/web/src/lib/queue/enqueue-job.ts`
- `apps/web/src/lib/imports/prepare-local-folder-import.ts`
- `apps/web/src/lib/datasets/modality.ts`
- `apps/web/src/lib/datasets/modality-backfill.ts`
- `apps/web/src/app/(app)/datasets/actions.ts`
- `apps/web/src/app/api/datasets/[datasetId]/route.ts`
- `apps/web/src/lib/workspace/label-management.ts`
- `apps/web/src/lib/annotations/text-policy-write-service.ts`
- `apps/web/src/lib/annotations/text-command-service.ts`
- `apps/worker/src/jobs/visualization.processor.ts`
- `apps/worker/src/queue/deleted-dataset-cleanup.ts`
- `apps/web/src/lib/dataset-import.ts`
- `apps/web/src/lib/annotations/text-classification-service.ts`
- `apps/web/src/lib/annotations/text-relation-service.ts`
- `apps/web/src/lib/annotations/text-span-service.ts`
- `apps/web/src/lib/assets/asset-bulk-service.ts`
- `apps/web/src/lib/collaboration/asset-assignment-service.ts`
- `apps/web/src/lib/collaboration/dataset-membership-service.ts`
- `apps/web/src/lib/workflow/asset-workflow-service.ts`
- `apps/web/src/lib/workspace/image-mutations.ts`
- `apps/web/src/lib/workspace/text-mutations.ts`
- `apps/web/src/lib/workspace/video-mutations.ts`
- `apps/worker/src/jobs/ai-prediction-writer.ts`
- `apps/worker/src/jobs/bulk-delete-assets.ts`
- `apps/web/src/app/api/images/[imageId]/dimensions/route.ts`
- `apps/worker/src/jobs/ai-video-prediction-writer.ts`
- `apps/worker/src/jobs/audio-waveform.ts`
- `apps/worker/src/jobs/video-metadata.ts`

## Database backstop
Migration 24 is now part of the canonical 25-migration active chain and passes the disposable release-chain proof (`release:phase029-chain`), but it is not applied to the shared dev database (ungranted gate). Until it is applied, the application-level guards above are the only enforcement on that database.
