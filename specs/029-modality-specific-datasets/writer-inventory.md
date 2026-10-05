# Phase 029 — Asset writer inventory (T018, source audit)

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

## Database backstop
Migration 24 (proposal) installs the Asset/Dataset modality triggers; they are not applied to the shared dev database (ungranted gate). Application-level guards above are therefore the only enforcement on that database today.
