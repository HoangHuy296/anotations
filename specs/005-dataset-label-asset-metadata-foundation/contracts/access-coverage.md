# Phase 005 Metadata Access Coverage

| Surface | System ADMIN | Non-admin owner/member | Outsider |
| --- | --- | --- | --- |
| `GET /api/datasets` | all active datasets | owned/member active datasets | n/a without session |
| `POST /api/datasets` | `201`, owner is actor | MANAGER `201`; LABELER/REVIEWER `403` | n/a without session |
| Dataset detail/update/archive | all active datasets | exact Dataset permission | `404` |
| Dataset labels | all active datasets | `dataset.read` / `label.manage` | `404` |
| Asset metadata list | all active datasets | `dataset.read` | `404` |

Responses use safe projections only: no owner id, storage provider/bucket/key, cache key, source path/URL/fingerprint, provider credential, encrypted value, or binary body.
