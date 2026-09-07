# Contract: Dataset Overview data

Extends the existing dataset detail surface. The current `apps/web/src/app/(app)/datasets/[datasetId]/page.tsx` is a server component reading directly via Prisma — no REST route exists today and none is strictly required (server component can call the new `dataset-overview-service.ts` directly, matching the existing pattern). A route is documented here anyway since the same data is useful to the workspace's dataset-level UI chrome and keeps a contract-testable boundary; if implementation finds the direct-service-call approach sufficiently reused, the route MAY be skipped — the service function is the required deliverable, the route is optional plumbing.

To be merged into `specs/api/openapi.yaml` as a **new** `/api/datasets/{datasetId}/overview` path (`GET`), plus reuse of the existing `PATCH /api/datasets/{datasetId}` for description edits (see below).

## `GET /api/datasets/{datasetId}/overview`

### Response — `200`

```json
{
  "assetCounts": { "total": 10404, "byModality": { "IMAGE": 8240, "VIDEO": 2044, "TEXT": 120, "AUDIO": 40 } },
  "annotationCount": 15872,
  "progress": { "completedAssets": 6120, "totalAssets": 10404 },
  "createdAt": "2026-01-04T00:00:00.000Z",
  "updatedAt": "2026-08-20T00:00:00.000Z",
  "health": {
    "missingStorageReference": 12,
    "cacheConflicts": 0,
    "failedImportJobs": 4,
    "incompleteImports": 2
  }
}
```

Field notes:
- `assetCounts.byModality` — grouped `Asset.count` by `modality`, source of truth per FR-032/spec's Key Entities (`Dataset`). Always includes all four modality keys (0 if none).
- `progress` — reuses the exact "completed/total" definition already computed for the workspace's existing per-tab progress line ([video-properties-tabs.tsx:449](../../../apps/web/src/components/workspace/video-properties-tabs.tsx#L449)) rather than a new progress formula (no "conflicting second progress model," per FR-032/plan §23).
- `health` — strictly the data-integrity signal set from research.md §13. No field here is ever a quality/agreement/accuracy metric (FR-034 hard requirement) — this is enforced by review, not by the schema, so it's called out explicitly in test coverage below.

### Errors

- `401`/`403` — same dataset-authorization check as every other dataset-scoped route.
- `404` — dataset not found / not accessible.

## Description edit

Reuses the existing `PATCH /api/datasets/{datasetId}` route and its current authorization rule for who may edit a dataset's description (FR-033: "where already permitted by existing authorization rules") — **no contract change**, the Dataset Overview UI simply surfaces the existing edit affordance if one doesn't already exist on this page, calling the existing route.

## Test coverage required

- Counts match seeded fixture data exactly, including a dataset with zero assets (valid empty state, not an error — Edge Cases in spec.md).
- `byModality` includes all four keys even when some are zero.
- `health.missingStorageReference` positively detects a seeded asset with a `NULL`/invalid `storageKey` where `status` implies one should exist.
- `health` response contains no field name or value resembling an annotation-quality metric (regression guard so a future change can't accidentally reintroduce one).
- Authorization: user without dataset access → `403`; nonexistent dataset → `404`.
