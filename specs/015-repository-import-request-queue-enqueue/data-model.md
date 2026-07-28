# Data Model: Repository Import Request + Queue Enqueue

## Existing persistent entities used

### Dataset

The central entity created only after successful server-side preflight and
authorization.

| Field/group | Phase-015 use | Rules |
| --- | --- | --- |
| `id`, `ownerId`, `name` | Durable accepted Dataset identity and owner. | `ownerId` always comes from the opaque-session actor, never the request body. |
| `sourceMode` | Repository-backed source mode. | Set only server-side after preflight acceptance. |
| `externalRepositoryId`, `sourceConnectionId` | Safe optional links to source metadata/credential reference. | Public request has no `sourceConnectionId`; private request must re-resolve eligible owned connection in the transaction. |
| `sourceBranch`, `sourceRootPath`, `lockedRevision` / `currentRevision` | Safe resolved source selection. | Written from server preflight result, never browser-stated as authoritative. |
| `metadata` | Not used for credentials or raw provider payload. | No PAT, ciphertext, queue fields, storage location, or full manifest. |

### Job

The sole durable asynchronous-work record.

| Field/group | Phase-015 use | Rules |
| --- | --- | --- |
| `id`, `datasetId`, `createdById`, `type` | One `IMPORT_DATASET` Job per accepted unique request. | Created transactionally with the Dataset; actor comes from session. |
| `status`, `stage` | Starts `QUEUED` / existing waiting stage. | Worker processing does not begin in this phase. |
| `sourceConnectionId` | Optional private-source reference. | ID only; no token/ciphertext in `input`. |
| `input` | Allowlisted source request context. | Provider/repository identity, resolved revision, root, safe bounded summary, connection ID where needed. No credential, raw provider payload, queue state, object storage data, or binary. |
| `queueName`, `queueJobId`, `enqueuedAt` | Delivery transport observability. | Written only by existing post-commit enqueue helper; never returned through the UI DTO. |
| `idempotencyKey` | Mirrors the accepted request key within its Dataset. | It supplements, but cannot alone establish, new-Dataset duplicate safety. |

### SourceConnection

Existing Phase-013 encrypted credential reference.

| Field/group | Phase-015 use | Rules |
| --- | --- | --- |
| `id`, `userId`, `provider`, `status`, `revokedAt`, `tokenExpiresAt` | Server-side eligibility resolution. | Must be active, owned by actor, unrevoked, and unexpired inside acceptance transaction. |
| encrypted token fields | Provider access only. | Never copied to Dataset, Job, JobEvent, queue payload, UI state, or public response. |

### ExternalRepository

Existing safe repository metadata record, if current source-import boundary
uses it.

| Field/group | Phase-015 use | Rules |
| --- | --- | --- |
| provider/base URL/full name/visibility/default branch | Safe canonical source identity. | Normalize server-side from preflight. Do not persist private URL variants, credentials, raw response, or manifest. |

## Required schema-alignment decision before implementation

The existing `Job` uniqueness constraint is `@@unique([datasetId,
idempotencyKey])`. It cannot prevent two concurrent new-Dataset requests from
creating two Dataset IDs first. To fulfil FR-009, an explicitly approved
migration should add:

| Candidate field | Entity | Constraint | Purpose |
| --- | --- | --- | --- |
| `creationIdempotencyKey String?` and `creationRequestHash String?` | `Dataset` | `@@unique([ownerId, creationIdempotencyKey])` | One actor-scoped durable acceptance outcome per request key; the hash detects reuse of that key for a different request while preserving multiple `NULL` values for all other Dataset flows. |

The approved field names are `creationIdempotencyKey` and
`creationRequestHash`. Their scope remains actor-scoped repository-import
acceptance. Do **not** add a workflow-specific Job table or repurpose
`PreparedImport`.

## Transaction and state transitions

### Invalid or unauthorized request

```text
request → actor/schema/policy/preflight failure → safe HTTP error
```

No Dataset, SourceConnection, ExternalRepository mutation, Job, JobEvent,
Redis delivery, or MinIO object is created.

### Valid accepted request

```text
read-only preflight
  → serializable transaction
      → idempotency lookup/create
      → Dataset create
      → safe repository relation/create as applicable
      → Job(IMPORT_DATASET, QUEUED) create
  → commit
  → enqueueExistingJob(job.id)
  → response { dataset, job safe DTO }
```

If an idempotent request already won, return its existing Dataset/Job and do
not enqueue another delivery. If enqueue fails after commit, retain `QUEUED`
Job for the existing recovery scanner.

### Progress observation

```text
authorized Dataset member → safe Job status projection → progress UI
foreign/non-member → concealed outcome
```

No progress read obtains raw Job input, raw events, queue data, or credentials.
