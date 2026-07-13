# Conceptual Data Model: Architecture Lock

This model is a Phase 0 contract, not a Prisma schema or migration. Field
names describe required domain ownership; concrete types, indexes, and storage
keys are deferred to later approved phases.

## Dataset

Central entity that groups imported or processed assets and their annotation
work.

| Field | Purpose | Rules |
| --- | --- | --- |
| identity | Stable dataset reference | Used to scope assets, annotations, and jobs. |
| provenance | Source and import context | Contains no provider token or storage credential. |
| lifecycle | Dataset availability state | Updated only through authorized durable operations. |

## Asset

An item belonging to a Dataset, representing source or derived binary content.

| Field | Purpose | Rules |
| --- | --- | --- |
| identity | Stable asset reference | Unique within its domain. |
| dataset reference | Links the asset to its Dataset | Required. |
| modality | Kind of media | Required; selects the workspace engine. |
| object reference | Pointer to private binary content | Metadata only; never contains binary content or credential. |
| provenance | Origin and derivation metadata | Supports retry-safe deduplication. |

## Annotation

Canonical user-created description of an Asset.

| Field | Purpose | Rules |
| --- | --- | --- |
| identity | Stable annotation reference | Required. |
| asset reference | Links annotation to an Asset | Required. |
| geometry | Canonical shape | All workspace engines read and write this representation. |
| version | Concurrency counter | Required for every update/autosave; stale version is rejected. |
| label and metadata | Annotation meaning and non-shape properties | Must not replace geometry as canonical shape. |

## Job

The one durable record for every asynchronous workflow.

| Field | Purpose | Rules |
| --- | --- | --- |
| identity | Durable job identifier | The only value placed in a queue payload. |
| kind | Operation discriminator | Covers import, export, repository sync, and future job kinds. |
| state | Lifecycle state | PostgreSQL is authoritative. |
| input | Durable request parameters | Never duplicated as full queue payload. |
| result | Outcome metadata and object references | Never stores binary data. |
| attempt and idempotency data | Retry coordination | Prevents duplicate binary outputs. |
| audit metadata | Requester, timestamps, error-safe diagnostics | Contains no secrets. |

### Job state transitions

```text
created → queued → running → completed
                   ↘ failed → queued (retry)
created | queued | running → cancelled
```

- A worker may begin only from a durable `queued` record.
- Terminal states (`completed`, `failed` without retry, `cancelled`) reject
  repeated execution unless an authorized new Job is created.
- Queue transport events never replace the durable state transition.

## Binary Object

Private content managed by MinIO and referenced by metadata.

| Field | Purpose | Rules |
| --- | --- | --- |
| object identity | Stable idempotent object reference | Derived/selected from durable context to prevent duplicates. |
| content metadata | Type, size, checksum, retention | Stored as metadata, not as binary database data. |
| access policy | Authorization boundary | Credentials remain server-side and are never exposed in client state. |

## Relationships

```text
Dataset 1 ── * Asset 1 ── * Annotation
Dataset 1 ── * Job
Job     * ── * Binary Object (by private metadata reference)
```
