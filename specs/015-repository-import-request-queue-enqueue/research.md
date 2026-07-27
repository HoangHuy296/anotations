# Research: Repository Import Request + Queue Enqueue

## Decision: Reuse the approved source-backed acceptance boundary

The new `POST /api/datasets/from-repository` Route Handler will validate the
Phase-015 request and delegate to a single server-only repository-import
acceptance service. That service will use the Phase-014 read-only preflight
coordinator and the existing post-commit `enqueueExistingJob` path.

**Rationale**: The existing `/api/source-import-jobs` route already proves the
correct ordering: server preflight, serializable durable creation, then enqueue
of `{ jobId }`. Duplicating this in a second Route Handler risks divergent
authorization, input redaction, and delivery recovery behavior.

**Alternatives considered**:

- Create Dataset/Job directly in the new route — rejected; it creates a second
  durable acceptance implementation.
- Keep the browser calling `/api/source-import-jobs` — rejected; it does not
  expose the Phase-015 public API contract or idempotency semantics.

## Decision: Preflight remains read-only and is repeated before acceptance

The browser may first call the existing safe preflight API to display a
preview. `POST /api/datasets/from-repository` must independently repeat
preflight before any transaction and must not trust browser preview data.

**Rationale**: A repository, ref, credential, access policy, or connection
state can change between preview and submit. Revalidation guarantees invalid
requests cannot leave Dataset/Job/queue/storage side effects.

**Alternatives considered**:

- Treat a preview result as a signed acceptance capability — rejected; it
  would weaken current authorization and expiry/security controls.
- Persist the preflight result — rejected; Phase 014 intentionally makes
  preflight non-persistent and Phase 015 excludes manifest persistence.

## Decision: Private imports reference an existing owned SourceConnection

Phase 015 accepts public repository requests without a SourceConnection and
private requests only with an existing active, owned, unexpired, unrevolved
SourceConnection. The request contains its opaque ID only. The service
re-resolves eligibility in the transaction.

**Rationale**: The Phase-013 security layer is canonical. It prevents tokens,
ciphertext, or browser credential claims from entering Dataset metadata, Job
input, BullMQ, or responses.

**Alternatives considered**:

- Send a PAT with the Phase-015 request — rejected; the feature contract
  forbids browser credential input and would expand credential lifecycle scope.
- Trust client visibility/source ownership — rejected; server authorization is
  non-negotiable.

## Decision: Queue delivery is strictly post-commit and recoverable

The service commits the Dataset/Job first, then calls the existing queue helper
which sends `jobQueuePayloadSchema.parse({ jobId })`. If Redis/BullMQ delivery
fails, the Job remains `QUEUED`, lacks the delivery stamp, and is discovered by
the existing recovery scanner.

**Rationale**: PostgreSQL remains authoritative. A transport outage cannot
delete accepted work or cause a second authoritative Job.

**Alternatives considered**:

- Enqueue inside the database transaction — rejected; queue delivery is
  external and cannot participate in the PostgreSQL transaction.
- Put repository request data in Redis for recovery — rejected; violates the
  queue payload and canonical-state rules.

## Decision: Safe import input uses only allowlisted repository fields

Job input holds provider identity, owner/repository name, resolved ref/revision,
normalized root path, expected/actual visibility where safe, bounded preflight
summary, and optional SourceConnection ID. Dataset fields reference safe source
metadata only. Raw provider bodies, URLs with userinfo/query/fragment,
credentials, encrypted material, manifest contents, storage locations, and
queue data are excluded.

**Rationale**: A Job may later be read by worker/recovery code; it must remain
safe even though it is never browser-projected wholesale.

**Alternatives considered**:

- Store the full preflight response — rejected; it may include private URLs or
  provider-specific data and is outside the phase scope.

## Decision: Durable duplicate-submit idempotency requires explicit schema approval

Use an actor-scoped, optional repository-import idempotency key on `Dataset`
with a database unique constraint, then set `Job.idempotencyKey` in the same
transaction. On a uniqueness conflict, fetch and return the original accepted
Dataset/Job without enqueueing again.

**Rationale**: Existing `Job @@unique([datasetId, idempotencyKey])` cannot
protect a request before the new Dataset ID exists. The database must own
concurrent deduplication, not application timing.

**Alternatives considered**:

- Lookup a matching Job JSON before create — rejected; no unique constraint and
  unsafe under concurrent requests.
- Reuse `PreparedImport` idempotency — rejected; it represents browser local
  uploads and would incorrectly introduce a later-phase entity into repository
  import acceptance.
- Deterministically synthesize Dataset IDs — rejected; it overloads unrelated
  identifiers and does not express the actual idempotency invariant.

**Approval status**: The plan does not change the schema. A migration is an
explicit Phase-015 implementation gate and requires owner approval first.

## Decision: Progress uses the existing safe PostgreSQL Job status projection

The progress page obtains its data through the existing authorized Job status
API/DTO and dataset guard. It polls or refreshes safe `status`, stage,
progress/counters, safe summary, and timestamps; it never reads Redis/BullMQ
or raw Job input/events.

**Rationale**: This preserves the Phase-009 and Phase-007 status boundary and
prevents queue/internal data leakage.

**Alternatives considered**:

- Read BullMQ status in browser — rejected; Redis is transport only and not an
  authorization-safe UI store.

## Decision: Controlled Compose evidence is mandatory

Use real PostgreSQL, passworded Redis with isolated DB/prefix, MinIO prefix
snapshots, controlled provider fixtures, and normal opaque-cookie HTTP login.

**Rationale**: Validity, no-side-effect, queue payload, and recovery behavior
cross service boundaries and cannot be evidenced by mocked storage/queue tests.

**Alternatives considered**:

- Unit tests only — rejected; they cannot prove no mutation in actual providers
  or delivery isolation.
