# Schema Governance Contract

- `Asset.modality` selects workspace engine; do not add modality-specific workspace routes.
- Persist annotation shapes only in `Annotation.geometry`; updates require the caller's current `Annotation.version` and reject stale versions.
- Store binaries by MinIO key/metadata only; never PostgreSQL bytes.
- Never persist a token on `ExternalRepository`, `Dataset`, `Asset`, `Job`, or `JobEvent`.
- Queue messages contain only `{ jobId }`; Job input/state/result remain PostgreSQL data.
- Do not add `ImportJob`, `ExportJob`, or `RepositorySyncJob` models.
