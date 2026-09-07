# Contract: Unified bulk-mutation endpoint

New endpoint. To be added to `specs/api/openapi.yaml` under a new `/api/datasets/{datasetId}/assets/bulk` path.

## Request

`POST /api/datasets/{datasetId}/assets/bulk`

```json
{
  "action": "ADD_LABEL" | "REMOVE_LABEL" | "CHANGE_STATUS" | "ASSIGN" | "DELETE" | "EXPORT_SELECTED",
  "selection": {
    "mode": "EXPLICIT",
    "assetIds": ["cuid", "…"]
  },
  "payload": { "...action-specific, see below..." }
}
```

or, for a filtered selection:

```json
{
  "action": "…",
  "selection": {
    "mode": "FILTERED",
    "query": { "q": "…", "status": ["…"], "modality": "…", "labelId": ["…"], "assignedToId": "…", "createdFrom": "…", "createdTo": "…", "updatedFrom": "…", "updatedTo": "…" }
  },
  "payload": { "…" }
}
```

`selection.query` uses the exact shape defined in [assets-list.md](./assets-list.md) minus `sort`/`order`/pagination fields (server rejects the request with `400` if they're present — sort/order have no meaning for "what does this selection match").

### `payload` by action

| Action | `payload` shape |
|---|---|
| `ADD_LABEL` | `{ labelId: string }` (existing label) **or** `{ createLabel: { name: string, color: string } }` (new label, created via the same rules as the standalone Labels tab) — exactly one of the two |
| `REMOVE_LABEL` | `{ labelId: string, confirmedAnnotationWarning?: boolean }` — server returns a `409`-style "warning required" response (not an error) if any selected asset has an `Annotation` referencing this label and `confirmedAnnotationWarning` was not `true`; see Responses below |
| `CHANGE_STATUS` | `{ status: AssetStatus }` |
| `ASSIGN` | `{ assignedToId: string | null }` — `null` unassigns |
| `DELETE` | `{}` — no payload; confirmation happens client-side before this request is sent (FR-025) |
| `EXPORT_SELECTED` | `{}` — no payload |

## Authorization (server-side, every action)

1. Resolve the requesting user's session; `401` if absent.
2. Verify the user is authorized for `datasetId` (existing dataset-access check, same as every other dataset-scoped route) — `403` if not, regardless of any `datasetId` implied elsewhere in the body.
3. For `mode: "EXPLICIT"`, re-verify every `assetId` actually belongs to `datasetId` — silently drop (report as `skipped`, reason `"not_in_dataset"`) any that don't, never error the whole batch, never act on them.
4. For `mode: "FILTERED"`, the query is evaluated only against Assets the requesting user is authorized to see in that dataset (no distinct authorization gap vs. §2 — filtered resolution reuses the same dataset-scoped query).

## Size enforcement

Resolved count (after §Authorization step 3/4, not the client's claimed `assetIds.length`) is checked against `BULK_SYNC_MAX_ASSETS` (research.md §6, currently 200):

- `ADD_LABEL` / `REMOVE_LABEL` / `CHANGE_STATUS` / `ASSIGN`: resolved count `> BULK_SYNC_MAX_ASSETS` → `422` with `{ error: "selection_too_large", max: 200 }`. No background path for these in this phase (research.md §7).
- `DELETE` / `EXPORT_SELECTED`: resolved count `≤ BULK_SYNC_MAX_ASSETS` → executes synchronously; `>` → creates a `Job` (`BULK_DELETE_ASSETS` / `BULK_EXPORT_SELECTED`) and enqueues via the existing `enqueueExistingJob()` funnel.

## Responses

**Sync success** — `200`:

```json
{ "mode": "SYNC", "result": { "processed": 50, "succeeded": 47, "failed": 1, "skipped": 2, "failures": [{ "assetId": "…", "reason": "…" }] } }
```

**Background accepted** — `202`:

```json
{ "mode": "JOB", "jobId": "cuid" }
```

Client polls the existing `GET /api/jobs/{jobId}` (unchanged contract) for status/progress/`summary` (same `BulkOperationResult` shape) and, for `EXPORT_SELECTED`, follows the existing `GET /api/export/{jobId}`-style download-URL pattern once `COMPLETED`.

**Annotation-reference warning required** (`REMOVE_LABEL` only, `confirmedAnnotationWarning` not set) — `409`:

```json
{ "error": "annotation_reference_warning", "affectedAssetCount": 6, "message": "Some selected assets have annotations using this label; removing it will not affect those annotations." }
```

Client re-sends the identical request with `payload.confirmedAnnotationWarning: true` to proceed (mirrors FR-016).

**Selection too large (organize actions)** — `422`: as above.

**Validation error** — `400`: standard Zod-derived error envelope (malformed `selection`, unknown `action`, missing required `payload` field, both/neither of `labelId`/`createLabel` present, etc.).

**Unauthorized** — `401`/`403` as in §Authorization.

## Idempotency

- `ADD_LABEL`: relies on `AssetLabel`'s `@@unique([assetId, labelId])` — re-adding is reported `skipped` (reason `"already_labeled"`), not `failed`.
- `REMOVE_LABEL`: removing an absent attachment is `skipped` (reason `"not_labeled"`), not `failed`.
- `CHANGE_STATUS`: setting the current status is `succeeded` (a genuine no-op write), not `skipped` or `failed`.

### Phase 023 workflow compatibility

Generic `CHANGE_STATUS` must not bypass the Asset review workflow. Requests
targeting `IN_PROGRESS`, `NEEDS_REVIEW`, `REVIEWED`, or `REJECTED` return
`400 WORKFLOW_STATUS_REQUIRES_TRANSITION`. A request targeting an operational
status is also rejected as a whole when any resolved Asset currently has one
of those workflow-governed statuses; it never partially updates a mixed
selection. Those states are reachable only through the revision-guarded
single-Asset workflow endpoint.
- `DELETE`: an already-deleted asset (not found in dataset scope) is `skipped` (reason `"already_deleted"`).
- `DELETE`/`EXPORT_SELECTED` background Jobs: retried via the existing Job-retry lineage (`retryOfJobId`) and `idempotencyKey`, exactly like Dataset Export.

## Logging

Every call emits one of `bulk_action_started` / `bulk_action_completed` / `bulk_action_partial_failure` / `bulk_action_failed` with `{ userId, datasetId, action, selectionMode, resolvedCount, succeeded, failed, skipped, jobId?, durationMs }`. Never logs `selection.query`'s free-text `q` value verbatim if it could contain user-entered PII beyond a filename search — logs a hash or the resolved count only for that field if this becomes a concern; never logs signed URLs, label colors are fine (not sensitive).

## Test coverage required

- Every action × both selection modes × authorization boundary (asset outside dataset, dataset outside user's access).
- `BULK_SYNC_MAX_ASSETS` boundary (exactly at, one over) for every action.
- Idempotency: replay each action twice, assert second run's `skipped`/`succeeded` matches the idempotency rule above, no duplicate `AssetLabel` rows, no duplicate storage deletes.
- `REMOVE_LABEL` annotation-reference warning: with and without `confirmedAnnotationWarning`.
- Partial failure: a batch where some assets fail mid-transaction (e.g. concurrently deleted) still reports accurate `failed`/`skipped`, never a false `succeeded` total.
- `DELETE`/`EXPORT_SELECTED` background path: Job created, enqueued via the existing `{jobId}`-only payload, `Job.summary` ends up with the same envelope shape as the sync response.
