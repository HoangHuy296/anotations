# Research: Local Folder Import and Commit Signal

## Decision: create a durable PreparedImport before upload

**Rationale**: It binds requester, Dataset, expected safe manifest, deadline, and common `IMPORT_DATASET` Job before browser transfer. This is the durable authority for authorization, reconciliation, disconnects, and retries.

**Alternatives considered**: Browser-only manifest was rejected because it cannot survive disconnect; a separate ImportJob table was rejected because the common Job is canonical.

## Decision: reuse scoped direct-upload capabilities

**Rationale**: Existing object-scoped browser capabilities transfer bytes without credentials or a backend binary proxy. Each completed item is reconciled with its durable preparation item.

**Alternatives considered**: A backend proxy violates the binary boundary; broad bucket access exposes excessive capability.

## Decision: commit is an idempotent validation barrier

**Rationale**: Commit compares durable completed Assets with the expected total before recording completion. Browser-reported counts are not authority.

**Alternatives considered**: Completion on final browser upload or an inactivity timer bypasses explicit intent and is unsafe under disconnect.

## Decision: stale detection writes one timeout outcome

**Rationale**: A durable deadline lets a PostgreSQL-backed scanner fail an uncommitted import with `IMPORT_COMMIT_TIMEOUT`. Redis age/retention is never lifecycle state.

**Alternatives considered**: Leaving Jobs running indefinitely or silently completing after a delay misrepresents partial imports.

## Decision: extend Phase 009 boundaries

**Rationale**: Reuse safe Job APIs/UI, Dataset concealment, retry lineage, `{ jobId }` transport, and token-gated worker lifecycle. Add import-specific data only at these boundaries.

**Alternatives considered**: A separate public import service duplicates the Next.js boundary; manifest/state in BullMQ violates PostgreSQL authority.
