# Contract: Pagination Envelope

Applies to every endpoint newly bounded by this feature (`GET /api/datasets`, `GET /api/datasets/[datasetId]/labels`, and any endpoint the full audit in `/speckit-tasks` finds unbounded). Does **not** apply to `GET /api/datasets/[datasetId]/assets` (already paginated, contract frozen — FR-042) or `GET /api/jobs/[jobId]/events` (already cursor-paginated, contract frozen).

## Request (offset shape — matches the existing asset-listing endpoint's convention)

Query parameters, all optional:

```
GET /api/datasets?page=1&pageSize=20
GET /api/datasets/{datasetId}/labels?page=1&pageSize=20
```

- `page`: 1-indexed integer, default `1`. A value `< 1` is treated as `1` (never an error, matching "never allow arbitrary huge take" being about the ceiling, not the floor).
- `pageSize`: integer, default matches each endpoint's current typical result size, **capped at `PAGINATION_MAX_PAGE_SIZE`** (see `data-model.md`, default `100`) regardless of what the caller requests. A requested size above the cap is silently clamped to the cap, not rejected — preserving "do not break normal legitimate usage."

## Response

Wrapped in the existing `apiSuccess()` envelope (`{ data: ... }`), unchanged:

```json
HTTP 200 OK
{
  "data": {
    "items": [ /* existing per-item shape, unchanged */ ],
    "page": 1,
    "pageSize": 20,
    "total": 137
  }
}
```

This mirrors the shape already returned by `GET /api/datasets/[datasetId]/assets` today (`workspace.page.{page,pageSize,total}` as consumed by `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx`) so that a caller already familiar with one paginated endpoint's shape can predict every other one.

## Backward compatibility

- A caller of `GET /api/datasets` or `GET /api/datasets/[datasetId]/labels` today that ignores pagination and expects a bare array **will observe a breaking response-shape change** (bare array → `{ items, page, pageSize, total }`) for these two specific endpoints, because they currently return an unbounded bare list. This is the one explicitly-acknowledged, minimal, necessary contract change this feature makes (FR-041/FR-042 §"preserve existing response shape wherever possible" — "wherever possible" excludes an endpoint that has no bound at all today). Every existing internal caller of these two endpoints must be updated in the same change (tracked in `/speckit-tasks`).
- Every other endpoint's contract is unchanged.

## Out-of-range requests

- `page` beyond the last page → `items: []`, `total` still reflects the real count, `200 OK` (never an error) — matches the spec's edge case "operator requests a job list page far beyond the last page ... must respond with an empty/bounded result rather than erroring."
- `pageSize=0` or a negative `pageSize` → treated as the endpoint's default page size, not an error and not zero results.
