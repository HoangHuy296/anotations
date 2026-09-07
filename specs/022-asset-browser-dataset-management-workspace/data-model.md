# Phase 1 Data Model: Asset Browser & Dataset Management Workspace

Only net-new or changed structures are detailed with full fields; unchanged existing models are referenced by name and file location.

## New: `AssetLabel`

Asset-level metadata tag attachment. Fully independent of `Annotation.labelId`.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | PK |
| `assetId` | `String` | FK → `Asset.id`, `onDelete: Cascade` |
| `labelId` | `String` | FK → `Label.id`, `onDelete: Cascade` |
| `createdAt` | `DateTime` | default now |
| `createdById` | `String?` | FK → `User.id`, who attached it (audit) |

**Constraints**:
- `@@unique([assetId, labelId])` — at most one attachment per (Asset, Label) pair. Backs FR-014/FR-019 idempotency: adding an already-attached label is a no-op, not an error.
- `@@index([labelId])` — supports "filter Assets by label" (FR-002) and "which assets does this label affect" (used by the FR-016 annotation-reference warning check, which is separate — see below).
- Service-layer invariant (not a DB constraint, since `Label` has no composite key to join against): a write is rejected if `label.datasetId !== asset.datasetId`.

**Relations added to existing models** (append-only, non-breaking):
- `Asset.assetLabels AssetLabel[]`
- `Label.assetLabels AssetLabel[]`

## Changed: `Asset` (existing model, [schema.prisma:375](../../prisma/schema.prisma))

One new scalar + relation, nothing else touched:

| Field | Type | Notes |
|---|---|---|
| `assignedToId` | `String?` | FK → `User.id`. Assignment boundary only (FR-004/FR-018) — no workflow/history. |

**Validation rule** (service layer): `assignedToId`, when set, must reference a user with an active `DatasetMember` row for the Asset's Dataset. Enforced at bulk-assign time, not as a DB constraint (a member could theoretically be removed after assignment — that's a future Collaboration-phase concern, not blocked here).

No other `Asset` fields change. `status: AssetStatus` (unchanged enum, [schema.prisma:789](../../prisma/schema.prisma)) remains the sole target of "Change Status" (FR-017); `NEEDS_REVIEW`/`REVIEWED`/`REJECTED` values within it serve review-status filtering (no new enum, per research.md §10). Phase 023 retains this single status authority, but reserves `IN_PROGRESS`, `NEEDS_REVIEW`, `REVIEWED`, and `REJECTED` for its guarded workflow transitions rather than generic bulk mutation.

## Changed: `JobType` enum ([schema.prisma:902](../../prisma/schema.prisma))

Two new values appended (enum values are additive/backward-compatible):

- `BULK_DELETE_ASSETS`
- `BULK_EXPORT_SELECTED`

## Changed: `JobStage` enum ([schema.prisma:928](../../prisma/schema.prisma))

New stage values mirroring the granularity already used by `EXPORT_DATASET`'s stages (e.g. `EXPORTING_DATASET`, `FINISHED`):

- `RESOLVING_SELECTION` — used by both new job types while re-running the selection query server-side
- `DELETING_ASSETS` — `BULK_DELETE_ASSETS` only
- `EXPORTING_SELECTED_ASSETS` — `BULK_EXPORT_SELECTED` only

(`FINISHED` and other cross-cutting stages already exist and are reused as-is.)

## Changed: `packages/queue/src/job-contract.ts`

`supportedQueueJobTypes` gains `BULK_DELETE_ASSETS`, `BULK_EXPORT_SELECTED` — required or `queueNameForJobType()` refuses delivery (per research.md).

## Not changed (referenced only)

- **`Label`** ([schema.prisma:487](../../prisma/schema.prisma)) — reused as-is for Add Label's "existing label" path and for creating a new label inline (same `[datasetId, normalizedName]` uniqueness the standalone Labels tab already enforces).
- **`Annotation`** — read-only, for the FR-016 warning: "does any selected Asset have an `Annotation` where `labelId` equals the label being removed" — a simple `Annotation.count({ where: { assetId: { in }, labelId } })` check, no write.
- **`DatasetMember`** / `DatasetMemberRole` — read-only, for assignment validation.
- **`Job`** core fields (`input`, `state`, `summary`, `progress`, `processedItems`/`successItems`/`failedItems`/`skippedItems`, `resultStorageKey`, `resultFilename`, `idempotencyKey`, `retryOfJobId`) — the bulk-operation result envelope (below) is stored in `Job.summary` for background-Job runs, exactly like Dataset Export does today.

## Application-level types (not persisted — request/response/store shapes)

### `AssetListQuery` (extends today's `assetListQuerySchema`)

```text
{
  q?: string
  status?: AssetStatus[]        // was single-value; now repeatable
  modality?: Modality
  labelId?: string[]
  assignedToId?: string          // boundary filter, FR-004
  createdFrom?: DateTime
  createdTo?: DateTime
  updatedFrom?: DateTime
  updatedTo?: DateTime
}
```

Deliberately excludes `sort`/`order`/`cursor`/`page`/`limit` — those are display/pagination concerns, never part of what a selection "matches" (research.md §3).

### `BulkSelection`

```text
{ mode: "EXPLICIT", assetIds: string[] }
| { mode: "FILTERED", datasetId: string, query: AssetListQuery }
```

### `BulkOperationResult`

```text
{
  processed: number
  succeeded: number
  failed: number
  skipped: number
  failures?: { assetId: string, reason: string }[]   // bounded, e.g. first 50
}
```

Returned synchronously for sync actions; stored in `Job.summary` (same shape) and surfaced via the existing `GET /api/jobs/{jobId}` for background actions.

### Client selection store shape (`asset-selection-store.ts`)

```text
{
  datasetId: string
  mode: "NONE" | "EXPLICIT" | "FILTERED"
  explicitIds: Set<string>
  filteredQuery: AssetListQuery | null
  selectVisible(ids: string[]): void
  toggle(id: string): void
  selectAllFiltered(query: AssetListQuery): void
  clear(): void
  reconcile(newQuery: AssetListQuery): void   // implements FR-013's per-mode rule
}
```

## State transitions

`Job.status`/`Job.stage` for the two new `JobType`s follow the existing state machine unchanged (`QUEUED → RUNNING → COMPLETED|FAILED`, with `RETRYING`/`CANCELING`/`CANCELED` as already defined) — no new states introduced, only new `stage` values marking progress within `RUNNING`.

`AssetLabel` has no state machine — rows exist or don't (create/delete only).

`Asset.status` remains a single enum. Since Phase 023, generic `CHANGE_STATUS` may set only non-workflow operational statuses and may not clear a workflow-governed status on a mixed selection; `IN_PROGRESS`, `NEEDS_REVIEW`, `REVIEWED`, and `REJECTED` require the validated Asset workflow transition endpoint.
