# Data Model: Job APIs and Progress UI

## Existing entities used

### Job

The durable Job remains the lifecycle, progress, cancellation, and retry authority.

Browser-visible fields are limited by the safe status contract. Internal input, state, raw summary, errors, queue fields, lock fields, provider/source fields, and storage references remain server-only.

### JobEvent

JobEvent remains append-only operational history. Its raw `data` field is server-only. The browser receives only the safe event projection defined in [job-api.md](./contracts/job-api.md).

### Dataset membership

Dataset membership is the authorization boundary for Job status/events (`dataset.read`), cancellation (`job.cancel`), and retry (`job.retry`). A non-member lookup is hidden as not found.

## Additive entity relationship

### Retry lineage

| Field | Type | Rules |
| --- | --- | --- |
| `retryOfJobId` | optional Job identifier | Present only on a retry successor; references the failed original. |
| `retryOfJob` | relation | Restricts deletion of an original while a successor exists. |
| `retries` | reverse relation | Allows internal audit of retry successors. |

**Constraint**: `retryOfJobId` is unique, so an original Job has at most one direct successor. A later failed successor may be retried as the next chain link.

## Derived safe projections

### Safe Job Status

Includes Job and Dataset identifiers, type, durable status/stage, progress and outcome counters, nullable allowlisted summary, and creation/update timestamps. It excludes all internal fields.

### Safe Job Event

| Field | Source | Validation |
| --- | --- | --- |
| `id` | JobEvent id | opaque identifier |
| `createdAt` | JobEvent time | ISO timestamp |
| `level` | JobEvent level | allowlisted enum |
| `stage` | JobEvent stage | nullable allowlisted enum |
| `message` | JobEvent message | allowlisted event kind/message |
| `reason` | derived from safe event context | nullable allowlisted reason only |

Raw event data is never part of this projection.

## State transitions

| Initial durable state | Authorized action | Result | Notes |
| --- | --- | --- | --- |
| `QUEUED` | cancel | `CANCELED` | terminal cancellation, no worker claim required |
| `RETRYING` with no active lease | cancel | `CANCELED` | terminal cancellation, no worker claim required |
| `RUNNING` | cancel | `CANCELING` | records request; active private worker later acknowledges |
| `CANCELING` | worker acknowledgement | `CANCELED` | requires Phase 008 current unexpired lock token |
| `FAILED` | retry | new `QUEUED` successor | original remains `FAILED`; only one direct successor |
| terminal/non-eligible | cancel/retry | no mutation | safe conflict/not-found response as applicable |

## Explicit exclusions

No PreparedImport, local filesystem path, staging manifest, staged object key, import ownership, or binary field is introduced in this phase.
