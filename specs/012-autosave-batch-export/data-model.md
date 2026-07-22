# Data Model: Autosave, Batch Navigation, and Dataset Export

## Schema decision

No Prisma schema change or migration is planned. This feature uses existing durable records and adds only validated DTOs, safe projections, and deterministic derived values.

## Existing durable entities

### Annotation

| Field / relationship | Phase 012 use | Validation and transition rule |
| --- | --- | --- |
| `id`, `datasetId`, `assetId`, `labelId` | Authorized identity and association | Server resolves Dataset/Asset/Label scope; client cannot cross-reference them. |
| `geometry` | Canonical saved shape | Geometry updates remain action-boundary writes and do not alter label metadata. |
| `properties` | Exported metadata | Export uses a safe JSON serialization policy; no binary or secret is introduced. |
| `revision` | Optimistic lock | Save requires the expected revision; guarded success increments once; stale result produces no mutation. |
| `status`, timestamps, creator/editor/reviewer links | Workspace/export metadata | Existing authorization and review boundary remain authoritative. |

### Asset

| Field / relationship | Phase 012 use | Validation and transition rule |
| --- | --- | --- |
| `datasetId`, `filename`, `modality`, `status` | Search/filter/list/export metadata | Query is always Dataset-scoped, excludes archived/deleted Assets, and uses stable order. |
| `batchIndex`, `orderIndex` | Batch and previous/next order | A result page contains at most 100 Assets. |
| `description`, `revision` | Description autosave | Save requires expected Asset revision and increments once on success. |
| storage metadata | Worker-only export source metadata | Manifest exposes only an allowlisted logical storage reference; no bucket/key/URL/credential. |
| annotations / child metadata | Progress and export relation | Export uses stable Dataset-scoped reads. |

### Dataset and DatasetMember

| Field / relationship | Phase 012 use | Validation and transition rule |
| --- | --- | --- |
| Dataset lifecycle | Active export/workspace boundary | Archived/deleted Dataset cannot be operated or exported. |
| owner and member roles | Effective permission boundary | Existing `requireDatasetPermission` resolves system role, ownership, and DatasetMember role. |
| labels/assets/jobs | Export aggregation | All selected records must have the same authorized Dataset id. |

### Job and JobEvent

| Field / relationship | Phase 012 use | Validation and transition rule |
| --- | --- | --- |
| `type = EXPORT_DATASET` | Common export discriminator | No export-specific Job table. |
| `input` | Small canonical export configuration | Strictly allowlisted, no secrets or manifest payload. |
| `status`, `stage`, counters, timestamps | Canonical lifecycle/progress | Only durable PostgreSQL values feed browser status. |
| `idempotencyKey` | Duplicate start prevention | Derived server-side from canonical authorized export context. |
| queue fields | Delivery audit | Set by existing create-then-enqueue flow; never supplied/read by browser clients. |
| claim/cancel/lock fields | Worker safety | Existing claim/heartbeat/complete/fail/cancel helpers require current unexpired lock token. |
| `resultStorageKey`, `resultFilename` | Private completed artifact metadata | Never sent to browser; used only after authorization to issue a short-lived download capability. |
| JobEvent | Safe audit/progress | Writer persists allowlisted event data; raw event JSON is never a public DTO. |

## Derived and transient entities

### Workspace save state

Client-only state keyed by `annotation:<id>` or `asset-description:<id>`.

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `idle` | No local change awaiting persistence | `pending` |
| `pending` | Debounce period is active | `saving`, `idle` (explicit discard) |
| `saving` | One guarded mutation is in flight | `saved`, `failed`, `conflict` |
| `saved` | Server accepted the current revision | `pending` |
| `failed` | Non-conflict failure; draft retained | `saving` through explicit retry/flush, `idle` through explicit discard |
| `conflict` | Server rejected stale revision; draft retained | `saving` only after explicit reconciliation/reload, `idle` through explicit discard |

### Filtered asset result set

Non-durable authorized query state:

```text
datasetId + normalized filename query + zero or more allowed status filters + stable order + page
```

`page` is one-based; page size is 100. Previous/next resolve adjacent Assets in this same result set, not in a client-only page subset.

### Dataset progress projection

A safe aggregate for one authorized active Dataset:

```text
totalAssets, statusCounts, completedOrReviewedAssets, remainingAssets
```

The final exact count definitions must use existing `AssetStatus` values and be computed from the same Dataset lifecycle filter as the list; they must never include another Dataset.

### Export configuration

Canonical persisted input (conceptual):

```text
datasetId, format = JSON, manifestSchemaVersion
```

All values are validated at the browser boundary. Object locations, credentials, provider data, arbitrary filters, and raw manifest contents are excluded.

### Export manifest

Private JSON artifact with stable ordering and the contract defined in [export-manifest.md](./contracts/export-manifest.md). It includes metadata only.

## Job state transitions for export

```text
POST /api/export
  → QUEUED (durable create)
  → QUEUED with delivery audit (enqueue succeeds)
  → RUNNING (private worker claim)
  → COMPLETED | FAILED | CANCELED
```

- Queue enqueue failure leaves the durable Job `QUEUED` with no `enqueuedAt`; existing recovery may deliver it later.
- A worker may change lifecycle only under an existing valid lock token.
- A running Job with an authorized cancellation request transitions through `CANCELING`; worker-side acknowledgement completes `CANCELED` only under the existing cancellation rules.
- Repeated delivery must not create a second completed artifact for the same durable Job.
- Existing retry lineage creates/reuses one successor Job. The successor receives only allowlisted canonical export configuration.
