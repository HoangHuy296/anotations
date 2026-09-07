# Contract: Extended Asset list query

Extends the existing `GET /api/datasets/{datasetId}/assets` route ([route.ts](../../../apps/web/src/app/api/datasets/[datasetId]/assets/route.ts), schema at [asset-list.ts](../../../apps/web/src/lib/validation/asset-list.ts)) and the equivalent server-side query used by the workspace RSC (`readWorkspacePage`). Backward compatible: every existing param keeps its current meaning and default.

To be merged into `specs/api/openapi.yaml` under the existing `/api/datasets/{datasetId}/assets` path.

## Request

`GET /api/datasets/{datasetId}/assets`

| Param | Type | Change | Notes |
|---|---|---|---|
| `cursor` | `string` (cuid) | unchanged | |
| `limit` | `int`, 1–100, default 25 | unchanged | server-enforced ceiling; workspace RSC path separately enforces the fixed 10/page (FR-006/007) |
| `q` | `string`, 1–100 chars | unchanged | filename search |
| `modality` | enum | unchanged | |
| `status` | enum | **changed**: now repeatable (`?status=NEEDS_REVIEW&status=REVIEWED`) | previously single-value; single-value callers keep working unchanged |
| `labelId` | `string` (cuid), repeatable | **new** | matches Assets with an `AssetLabel` row for any listed Label |
| `assignedToId` | `string` (cuid) | **new** | boundary filter (FR-004); matches `Asset.assignedToId` |
| `createdFrom` / `createdTo` | ISO 8601 datetime | **new** | inclusive range on `Asset.createdAt` |
| `updatedFrom` / `updatedTo` | ISO 8601 datetime | **new** | inclusive range on `Asset.updatedAt` |
| `sort` | `"createdAt" \| "updatedAt" \| "filename"`, default unchanged (batch/order index) | **new** | display-only; never affects selection membership |
| `order` | `"asc" \| "desc"`, default `"desc"` | **new** | |

Invalid combinations (e.g. `createdFrom > createdTo`) → `400` with a validation error, same error envelope the route already uses.

## Response (unchanged shape, richer filtering only)

```json
{
  "items": [ { "...existing assetMetadataSelect fields...": "…", "sizeBytes": "1234" } ],
  "page": { "limit": 25, "nextCursor": "…" | null, "hasNextPage": true }
}
```

No new fields on `items` — this contract only changes *which* assets can be selected/ordered, not what's returned per asset.

## Used by

1. The workspace UI's Assets tab (via `readWorkspacePage`, offset/URL-param variant) as the primary browse surface.
2. The bulk-mutation endpoint ([assets-bulk.md](./assets-bulk.md)) internally, to resolve a `FILTERED` selection's matching count/rows in bounded batches — never returning a full page list to the caller for that purpose.
3. The Asset Browser UI, to show a "N assets match" preview before committing to "Select All Filtered."

## Test coverage required

- Each new filter param independently and in combination with `q`/existing `status`/`modality`.
- `sort`/`order` combined with every filter; confirm result *set* is identical regardless of sort, only order differs.
- Max `limit` enforcement — request `limit=99999` → clamped/rejected, never honored as-is.
- Multi-value `status` — old single-value callers unaffected (regression check against `apps/web/tests/dataset-metadata/assets.test.ts`).
