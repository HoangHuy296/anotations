# Research: Autosave, Batch Navigation, and Dataset Export

## Decision: Reuse existing revision-guarded mutations and add a flush coordinator

**Rationale**: `Annotation.revision` and `Asset.revision` already support guarded `updateMany` mutations. The browser store already tracks per-resource debounce timers and save states. Phase 012 should add awaited flush and navigation/conflict coordination around that boundary, rather than create a second persistence mechanism or save on every pointer event.

**Alternatives considered**:

- Continuous writes during drag/transform: rejected because the Architecture Lock requires semantic action-boundary persistence.
- Browser-local durable autosave queue: rejected because it risks stale replay and creates a second authority for drafts.
- New revision column: rejected because the approved schema already has `Annotation.revision` and `Asset.revision`.

## Decision: Treat one authorized workspace list query as the filtered-navigation authority

**Rationale**: The existing workspace read service already scopes Asset queries to an authorized Dataset, applies case-insensitive filename matching, status filtering, stable batch ordering, and a page size of 100. Previous/next and selected-asset reconciliation will derive from that same filtered order to avoid cross-Dataset or unfiltered navigation.

**Alternatives considered**:

- Client-only filtering over one page: rejected because it cannot search the full Dataset or navigate reliably beyond the loaded batch.
- A separate unscoped Asset lookup for previous/next: rejected because it risks IDOR disclosure and inconsistent order.
- A `MULTI_MODAL` workspace route: rejected because `Asset.modality` selects the engine under the shared route.

## Decision: Use the common `EXPORT_DATASET` Job and the existing durable enqueue flow

**Rationale**: `JobType.EXPORT_DATASET`, Job export stages, queue mapping, queue payload validation, `resultStorageKey`, result filename, progress counters, recovery scanner, and safe Job status projection already exist. `POST /api/export` can use this foundation without an ExportJob model or Redis state.

**Alternatives considered**:

- A dedicated ExportJob table: rejected by the Architecture Lock.
- Queue payload with Dataset/config/manifest: rejected because only `{ jobId }` is permitted.
- Synchronous export in the browser-facing backend: rejected because artifact generation is long-running worker work.

## Decision: Persist only a canonical JSON export configuration and use deterministic artifact identity

**Rationale**: Phase 012 has one JSON export format. A small allowlisted input (Dataset identity plus format/schema version) is safe to persist in the durable Job and can form an idempotency key. The worker can use a deterministic object identity derived from the durable Job context and reconcile it on redelivery.

**Alternatives considered**:

- Persist the complete manifest in Job input or Redis: rejected because it can be large and Job/queue data must not contain binary or unbounded transport state.
- Let the browser choose bucket/key/filename: rejected because browser input cannot control private storage locations.
- Generate a random artifact on every delivery: rejected because retries must not create duplicate objects.

## Decision: Export safe logical storage references, not private storage locations

**Rationale**: The requested export includes storage references, but Phase 0 forbids private storage keys and URLs in browser-visible data. The manifest can identify an Asset and include its modality, media type, byte size, checksum, and a logical `assetId`-based reference without revealing bucket, object key, presigned URL, or credentials.

**Alternatives considered**:

- Include bucket/object key: rejected by the Architecture Lock.
- Include a permanent download URL: rejected because it creates public or long-lived private access.
- Include source binary inline: rejected because exports are metadata-only and binary remains in MinIO.

## Decision: Keep safe Job status projection as the only browser Job-status source

**Rationale**: Phase 007's `SafeJobStatus` already allowlists identifiers, Dataset/type/status/stage/progress/counters, timestamps, and sanitized summary. The export status endpoint can reuse it and append a short-lived download capability only after authorization and completed-artifact verification.

**Alternatives considered**:

- Read BullMQ progress/events in the UI: rejected because Redis/BullMQ is transport only.
- Return raw Job result or event JSON: rejected because it can disclose private storage and operational data.
- Let the worker expose a download HTTP endpoint: rejected because the worker is private.

## Decision: Preserve existing retry lineage while making export retry context explicit

**Rationale**: The current Phase 009 retry boundary creates a successor Job and already special-cases `EXPORT_DATASET`. Phase 012 will retain this approved behavior but replace any empty/implicit export retry context with a small server-allowlisted canonical export configuration. Artifact idempotency applies per durable Job and must reconcile repeat delivery for that Job.

**Alternatives considered**:

- Copy raw old `Job.input` to the successor: rejected because retry input must be allowlisted and secrets/private data cannot propagate.
- Change the project-wide retry policy in this phase: rejected as an unrelated architecture change.

## Decision: Use controlled Compose services for full export integration

**Rationale**: Export crosses PostgreSQL, passworded Redis/BullMQ, the private worker, and MinIO. Mocks cannot prove durable enqueue, worker claim/cancel behavior, private object creation, or safe download handling.

**Alternatives considered**:

- Unit-only worker test: retained for fast validation but insufficient as final evidence.
- Unauthenticated local Redis: rejected by current safe queue-test policy.
