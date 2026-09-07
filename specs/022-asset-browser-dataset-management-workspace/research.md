# Phase 0 Research: Asset Browser & Dataset Management Workspace

All items below were left open by the spec as explicit planning-phase decisions (Assumptions section) or surfaced during the Technical Context pass. Each is resolved here with rationale and rejected alternatives, grounded in a direct audit of the current codebase (see file references).

## 1. How the Assets tab fetches/paginates going forward

**Decision**: Keep the existing server-rendered, URL-search-param-driven model. Extend `readWorkspacePage()` ([workspace-read.ts](../../apps/web/src/lib/workspace/workspace-read.ts)) to accept `sort`, `order`, multiple `status` values, `labelId`, `createdFrom/To`, `updatedFrom/To` in addition to today's `q`/single `status`. Previous/Next continue to be plain links that change URL search params, exactly as [asset-navigator.tsx](../../apps/web/src/components/workspace/asset-navigator.tsx) already does.

**Rationale**: The spec's FR-006/FR-007 only require preserving today's 10-per-page, server-enforced Previous/Next behavior — not adding page-number jumping. The current RSC + URL-param pattern already satisfies "server-backed, no full dataset fetched to the client" (FR-001) for free, and every modality's tab (`image-properties-tabs.tsx`, `video-properties-tabs.tsx`, `placeholder-properties-tabs.tsx`) already renders `AssetNavigator` off page props from this one function, so extending it in place reuses one query path instead of adding a second, client-fetched one.

**Alternatives considered**: Switch the Assets tab to a client-fetched list against the existing (currently UI-unused) `GET /api/datasets/[datasetId]/assets` cursor route. Rejected as the primary browse path — it would duplicate the query logic `readWorkspacePage` already has, requires introducing client-side data-fetching/caching machinery the workspace doesn't otherwise use, and buys nothing the URL-param RSC model doesn't already provide for this feature's requirements. The cursor route is still valuable — see §4 — as the mechanism the *bulk resolver* uses server-side.

## 2. Selection state representation and lifecycle

**Decision**: A new client-side Zustand store (`asset-selection-store.ts`), scoped per `datasetId`, holding:

```text
mode: "NONE" | "EXPLICIT" | "FILTERED"
explicitIds: Set<string>              // when EXPLICIT
query: AssetListQuery | null           // when FILTERED — same shape as the list search params (q, status[], modality, labelId, date range) — sort/order intentionally excluded, see §3
```

Selecting "select all filtered" snapshots the *current* query (not sort/order) into the store. Explicit picks add/remove from `explicitIds`. The store is independent of Next.js router state, so page navigation (Previous/Next, changing a filter) does not itself clear it — reconciliation follows the exact per-mode rule the spec defines in FR-013.

**Rationale**: Matches the existing project convention (`dataset-labels-store.ts`, `image-annotation-store.ts`, `video-annotation-store.ts` are all Zustand stores already living in `apps/web/src/stores/`) — no new state-management library, no new pattern. Keeping selection out of the URL avoids polluting shareable/bookmarkable workspace URLs with potentially huge explicit-ID lists, and keeps `readWorkspacePage`'s query params exactly as clean as they are today.

**Alternatives considered**: Encode selection in the URL. Rejected — an explicit selection of hundreds of IDs would blow past reasonable URL length and get force-cleared by any unrelated navigation, in the exact "accidental selection loss" the spec's edge cases warn against.

## 3. Sort must never define selection membership

**Decision**: `AssetListQuery` used for a `FILTERED` selection snapshot excludes `sort`/`order` entirely — it only carries `q`, `status[]`, `modality`, `labelId`, `createdFrom/To`, `updatedFrom/To`. Sort/order are separate, page-local UI state that the selection resolver never sees.

**Rationale**: Directly implements FR-005/FR-013's requirement that changing sort alone must never alter selection membership. Structurally excluding sort from the query type the selection store persists makes this true by construction rather than by convention.

## 4. Resolving "select all filtered" without shipping every Asset to the client

**Decision**: The bulk-mutation endpoint (§5) resolves a `FILTERED` selection server-side by re-running the *same Prisma where-clause builder* `readWorkspacePage` uses (extracted into a shared, pure function in `workspace-assets.ts` so both the RSC page and the bulk endpoint build identical filters from identical input), then operates on it in bounded batches (e.g. Prisma `updateMany`/transactional chunked loop) without ever materializing full asset rows into an HTTP response. The existing cursor-based `GET /api/datasets/[datasetId]/assets` route ([route.ts](../../apps/web/src/app/api/datasets/[datasetId]/assets/route.ts)) is extended with the same new filter params so it can also serve as a legitimate "how many match" count / preview endpoint the client calls to show "2,438 assets" before commit — it still only returns bounded pages, never the full set.

**Rationale**: Satisfies FR-010/FR-029/SC-002 ("must never download all Assets to the frontend") while reusing rather than duplicating the query logic, per the plan's Section 1 requirement to reuse existing abstractions.

## 5. One bulk-mutation endpoint vs. one endpoint per action

**Decision**: One route, `POST /api/datasets/{datasetId}/assets/bulk`, discriminated by an `action` field (`ADD_LABEL | REMOVE_LABEL | CHANGE_STATUS | ASSIGN | DELETE | EXPORT_SELECTED`), taking a shared `selection` shape (`{mode:"EXPLICIT", assetIds} | {mode:"FILTERED", query}`) and an action-specific `payload`.

**Rationale**: This is the "one coherent bulk-operation boundary" the source plan explicitly asks for (its §34), avoids seven near-duplicate route handlers each re-implementing authorization/selection-resolution/result-shape, and gives every action the same processed/succeeded/failed/skipped response envelope (FR-035) for free from one shared executor.

**Alternatives considered**: Per-action REST routes (`POST .../assets/bulk-add-label`, etc.) — rejected as exactly the "unrelated endpoints implemented independently for every button" anti-pattern called out in the source plan.

## 6. Sync vs. background-Job execution threshold

**Decision**: A single server-side constant, `BULK_SYNC_MAX_ASSETS = 200`, applied uniformly to every action's *resolved* asset count (after resolving a `FILTERED` selection's matching count, not the client's claimed count). At or below the threshold: execute inside one Prisma transaction, respond synchronously with the result envelope. Above it: create a `Job` row (`BULK_DELETE_ASSETS` or `BULK_EXPORT_SELECTED` — organize actions like Add/Remove Label and Change Status are capped so they always run synchronously in this phase, since nothing in the spec requires background execution for them and it keeps their code path simple; see §7), then `enqueueExistingJob()` exactly as Dataset Export does today.

**Rationale**: The spec marks the exact threshold as "an implementation detail, not a user-facing requirement" (Assumptions). 200 is chosen as comfortably inside one Postgres transaction's normal latency budget for row-level updates, while still exercising the background path for realistic "thousands of assets" scenarios in tests. It is a named constant so it can be tuned without a spec change.

**Alternatives considered**: Per-action thresholds. Rejected for this phase as unnecessary complexity — organize actions (label/status/assign) are cheap row updates capped at the sync ceiling; only Delete and Export Selected have a background path at all, matching the source plan's own §16/§20 guidance ("small/normal bulk deletions may use a synchronous batch API," large ones use the Job system).

## 7. Which actions get a background-Job path at all

**Decision**: Only `DELETE` and `EXPORT_SELECTED` get a Job-backed path (new `JobType` values `BULK_DELETE_ASSETS`, `BULK_EXPORT_SELECTED`). `ADD_LABEL`, `REMOVE_LABEL`, `CHANGE_STATUS`, `ASSIGN` are synchronous-only, with their own resolved-count cap (reusing `BULK_SYNC_MAX_ASSETS`) — a "select all filtered" organize action against a set larger than the cap is rejected with a clear "narrow your selection" error rather than silently queued, since the spec doesn't require background execution for organize actions and adding it would be scope creep beyond what's specified.

**Rationale**: Matches the source plan's explicit action-to-mechanism table (§25: Add Label/Remove Label/Change Status/Archive/Restore → synchronous; large deletion, large export, binary-related → background Job) and keeps the number of new `JobType`/worker-processor pairs minimal (2, not 6).

## 8. `AssetLabel` data shape

**Decision**:

```prisma
model AssetLabel {
  id          String   @id @default(cuid())
  assetId     String
  labelId     String
  createdAt   DateTime @default(now())
  createdById String?
  asset       Asset    @relation(fields: [assetId], references: [id], onDelete: Cascade)
  label       Label    @relation(fields: [labelId], references: [id], onDelete: Cascade)
  createdBy   User?    @relation(fields: [createdById], references: [id])

  @@unique([assetId, labelId])
  @@index([labelId])
}
```

**Rationale**: Directly implements the spec's Key Entities invariant — `@@unique([assetId, labelId])` makes "at most once per Asset/Label pair" a database-level guarantee (also gives Add Label its idempotency for free per FR-019/SC-004-style retry safety: a duplicate insert attempt is a no-op via `skipDuplicates`/upsert, not an error). Same-dataset scoping (a Label may only attach to Assets in its own Dataset) is enforced in the service layer at write time (validate `label.datasetId === asset.datasetId` before insert) rather than as a composite FK, mirroring how `Label` itself is dataset-scoped today (unique on `[datasetId, normalizedName]`) without a composite-key `Asset`/`Label` relation that doesn't otherwise exist in the schema.

**Alternatives considered**: Storing label IDs in `Asset.metadata` (existing `Json` field). Rejected — unqueryable/unindexable for label-filtering (FR-002) without denormalization, and bypasses Prisma-level relational integrity the rest of the schema relies on (cf. AGENTS.md: use Prisma, not ad hoc JSON blobs, for structured relations).

## 9. Assignment boundary data shape

**Decision**: A single nullable `Asset.assignedToId String?` scalar with a relation to `User`, validated at write time to be a current `DatasetMember` of the Asset's Dataset (any role, not restricted to `LABELER`, since the spec doesn't scope who may be assigned). No new `Assignment` table, no history, no notifications.

**Rationale**: The spec (FR-004, FR-018) asks only for a UI/API *entry point* extendable by a future Collaboration phase, explicitly forbidding a full assignment system here. A direct FK is the minimal boundary that supports "assign," "filter by assignee," and "see who's assigned" without inventing lifecycle/audit machinery a later phase would likely redesign anyway.

**Alternatives considered**: A separate `AssetAssignment` join/history table. Rejected as premature — nothing in this phase's requirements needs assignment history or multiple simultaneous assignees, and the source plan explicitly warns against building unrelated Collaboration architecture early (§39).

## 10. Review-status filtering

**Decision**: No new enum. "Review status" filtering/display is implemented as a UI-level grouping over existing `AssetStatus` values (`NEEDS_REVIEW`, `REVIEWED`, `REJECTED`) — the API filter param is still just `status` (now accepting multiple values), the UI groups them under a "Review status" filter section.

**Rationale**: `AssetStatus` ([schema.prisma:789](../../prisma/schema.prisma)) already contains exactly these three review-shaped values; introducing a parallel `ReviewStatus` enum would violate AGENTS.md's "do not introduce duplicate status fields" and the spec's own FR-003/FR-017/Assumptions.

## 11. Audio/Text details — no schema change needed

**Decision**: Populate the existing dynamic header in [placeholder-properties-tabs.tsx](../../apps/web/src/components/workspace/placeholder-properties-tabs.tsx) with fields already present on `AudioAsset` (`sampleRate`, `channels`, `codec`, `bitRate`, `waveformKey` presence) and `TextAsset` (`language`, `content` length, `metadata`), plus base `Asset` scalars already available (`sizeBytes`, `mimeType`, `durationMs`, `textLength`, `createdAt`/`updatedAt`). Disabled sub-tab labels (`Segments`/`Properties`/`Annotations`) are left exactly as-is.

**Rationale**: Confirmed via schema read ([schema.prisma:628-653](../../prisma/schema.prisma)) that both modality-extension tables already carry real descriptive fields — this is a pure read/render task, zero migration.

## 12. Export Selected output shape and mechanism

**Decision**: Reuse the exact Dataset-Export mechanism ([export-service.ts](../../apps/web/src/lib/exports/export-service.ts), [export-dataset.ts](../../apps/worker/src/jobs/export-dataset.ts)) shape — a manifest JSON uploaded to MinIO with a checksum, `Job.resultStorageKey`/`resultFilename` set, downloaded via a short-lived presigned URL — but scoped to the resolved selection instead of the whole dataset, under a distinct storage prefix (e.g. `exports/{datasetId}/selected/{jobId}/manifest-v1.json`) and a distinct deterministic idempotency key (`fieldframe:export-selected:v1:{datasetId}:{selectionFingerprint}`) so it never collides with or supersedes the dataset's canonical export idempotency key.

**Rationale**: FR-027 requires Export Selected to be presented and behave as distinct from, and never affect, the existing Dataset Export — reusing the mechanism but namespacing storage key + idempotency key keeps them fully independent while reusing 100% of the proven manifest/checksum/presigned-URL pattern (no new export machinery invented).

## 13. Dataset Health signal set (this phase)

**Decision**: Health checks limited strictly to data-integrity/operational signals already derivable from existing fields, matching the source plan's explicit list: assets with a `NULL`/missing `storageKey` while `status` implies they should have one, `cacheStatus IN (CONFLICT, UNKNOWN)`, recent `Job` rows for this dataset with `status = FAILED`, and `PreparedImportItem`s stuck incomplete past their grace period (reusing the exact reference-checking posture already established by the Phase 21 [minio-orphan-scanner.ts](../../apps/worker/src/queue/minio-orphan-scanner.ts)). No annotator/agreement/accuracy metric is computed or stored by this feature.

**Rationale**: FR-034/SC-009-adjacent requirement and the spec's explicit "never combined with annotation-quality-style metrics" boundary; reuses fields and posture Phase 21 already established rather than inventing a second integrity-checking mechanism.

## Summary of new schema surface

- `AssetLabel` (new model)
- `Asset.assignedToId` (new nullable scalar + relation)
- `JobType` += `BULK_DELETE_ASSETS`, `BULK_EXPORT_SELECTED`
- `JobStage` += stage values for the two new job types (mirroring the granularity of existing `EXPORTING_DATASET`-style stages)
- `packages/queue/src/job-contract.ts` `supportedQueueJobTypes` += the same two types

No other model changes. All Technical Context unknowns are resolved — nothing carries a `NEEDS CLARIFICATION` marker into Phase 1.
