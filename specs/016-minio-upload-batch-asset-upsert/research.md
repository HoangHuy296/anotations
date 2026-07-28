# Phase 016 Research: MinIO Upload + Batch Asset Upsert

## Decision: keep the queue payload and worker claim boundary unchanged

**Decision**: The worker continues to receive only `{ jobId }`, loads the Job
from PostgreSQL, claims it with the existing lock token, and performs all
progress, completion, failure, and cancellation mutations through the
lock-token lifecycle.

**Rationale**: PostgreSQL remains the sole authority for import state and this
keeps Phase 016 compatible with duplicate BullMQ delivery and recovery.

**Alternatives considered**: Sending a manifest, source URL, batch cursor, or
credential in BullMQ was rejected because those are Job state, provider data,
or secrets.

## Decision: use a bounded ephemeral provider manifest

**Decision**: `listFiles()` produces an in-memory, bounded stream/list of
eligible file candidates for the immutable ref in the safe Job input. Do not
persist the full manifest. Batch size is deployment policy, default 100 and
strictly validated in the inclusive 50–200 range.

**Rationale**: It limits memory, allows batch-level progress, and avoids a new
durable manifest model or binary database storage.

**Alternatives considered**: Persisting all source files or one JobEvent per
file was rejected as unnecessary durable data/noise.

## Decision: derive public source access server-side

**Decision**: Private imports re-resolve and decrypt their owned active
`SourceConnection` in the worker. Public GitHub/Gitea access is derived from
server-controlled provider configuration/allowlisted provider roots, never a
base URL in `Job.input`.

**Rationale**: Phase 015 intentionally excluded base URLs and credentials from
safe Job input. This closes the public-import worker gap without reintroducing
browser-controlled destinations.

**Alternatives considered**: Adding a private repository URL to Job input or
reusing browser form values was rejected as an architecture/security violation.

## Decision: deterministic source identity and MinIO key

**Decision**: Hash Dataset ID, provider, repository owner/name, immutable
resolved revision, normalized source path, and provider file identity
(SHA/ETag where available) using SHA-256. Use that fingerprint as the Asset
`sourceFingerprint` and a controlled MinIO key such as
`repository-imports/{datasetId}/{fingerprint}`.

**Rationale**: The existing unique `[datasetId, sourceFingerprint]` constraint
and deterministic object location reconcile redelivery/retry while a changed
immutable revision becomes a different identity.

**Alternatives considered**: Filename/path-only identity and job-ID storage
keys were rejected because rename/retry behavior is not stable enough.

## Decision: upload then reconcile with guarded cleanup

**Decision**: Mirror a file to the deterministic private MinIO key, then
perform a Prisma transaction to find/create the Asset and upsert exactly one
modality child row. If persistence fails, remove only the deterministic object
when no Asset references that exact bucket/key. Recheck before every delete.

**Rationale**: Object storage cannot join the database transaction. The
guarded compensation prevents unreferenced orphan objects without deleting a
published/shared object.

**Alternatives considered**: Storing bytes in PostgreSQL, deleting blindly on
any error, or creating an Asset before object verification were rejected.

## Decision: safe aggregate outcome projection

**Decision**: Each completed batch updates PostgreSQL counters/progress and
writes one allowlisted batch JobEvent. The final safe summary contains only
aggregate imported/skipped/failed counts and a bounded generic error summary;
it contains no paths, URLs, tokens, raw provider response, or object key.

**Rationale**: It supplies progress UI data while preserving the existing safe
Job-status DTO boundary.

**Alternatives considered**: File-level events/raw reports in Job summary were
rejected for leakage and scale reasons.
