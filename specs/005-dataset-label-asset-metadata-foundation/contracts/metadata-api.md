# Dataset Metadata API Contract

All operations require an active session except no public operation is defined.

| Operation | Required permission | Success | Safe denial |
| --- | --- | --- | --- |
| `GET /api/datasets` | authenticated actor | ADMIN: all active datasets; other users: owned/member datasets only | `401` |
| `POST /api/datasets` | system ADMIN or MANAGER | `201`, owner derived server-side | `401` / `403` / `400` |
| `GET/PATCH/DELETE /api/datasets/[datasetId]` | read/update/delete | `200`; delete archives | `404` outsider, `403` member without permission |
| `GET/POST /api/datasets/[datasetId]/labels` | read/label.manage | safe labels / `201` | `404` / `403` |
| `PATCH/DELETE /api/labels/[labelId]` | label.manage via label dataset | `200` / `204` | `404` / `403` |
| `GET /api/datasets/[datasetId]/assets` | dataset.read | bounded safe page | `404` / `403` |

Responses never include binary bodies, storage bucket/key, source URL, provider token, encrypted fields, or owner fields that the actor is not entitled to see.
