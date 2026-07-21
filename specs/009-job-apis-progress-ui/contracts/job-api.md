# Job API Contract

All endpoints require the current authenticated actor. Authorization is evaluated from the Job's Dataset; callers outside that boundary receive a safe not-found response. All success payloads are JSON under the existing response envelope.

## GET `/api/jobs/[jobId]`

Returns the canonical safe Job status projection already established in Phase 007.

```ts
type SafeJobStatus = {
  id: string
  datasetId: string
  type: JobType
  status: JobStatus
  stage: JobStage | null
  progress: number | null
  totalItems: number | null
  processedItems: number | null
  successCount: number | null
  failedCount: number | null
  skippedCount: number | null
  summary: JobSafeSummary | null
  createdAt: string
  updatedAt: string
}
```

The response does not include Job input/state/result, raw summary/errors, events, transport fields, locks, provider/source data, private storage values or URLs, credentials, or binary.

## GET `/api/jobs/[jobId]/events`

Query parameters:

```ts
type JobEventQuery = { cursor?: string; limit?: number }
```

`limit` defaults to 50 and is capped at 100. Results are ordered newest-first with a stable opaque cursor.

```ts
type SafeJobEvent = {
  id: string
  createdAt: string
  level: JobEventLevel
  stage: JobStage | null
  message: SafeJobEventMessage
  reason: SafeJobEventReason | null
}
```

`data` is never returned. Unknown or non-allowlisted persisted events are omitted rather than serialized.

## POST `/api/jobs/[jobId]/cancel`

Requires Dataset `job.cancel` permission.

| Job state | Result |
| --- | --- |
| `QUEUED` or unlocked `RETRYING` | terminal `CANCELED` response |
| `RUNNING` | `CANCELING` response with cancellation request recorded |
| `CANCELING`, terminal, or otherwise ineligible | conflict; no duplicate event or transport write |

The endpoint never accepts or exposes a worker identity, lock token, queue identifier, or cancellation owner supplied by the browser.

## POST `/api/jobs/[jobId]/retry`

Requires Dataset `job.retry` permission. Only a failed Job with an approved queue-supported type is eligible.

On first success, returns `201` with the successor safe Job reference/status. A concurrent or repeated submission returns the existing successor with `200`. The original Job is not modified. Unsupported types return a safe conflict and are not queued.

The successor is created from server-held allowlisted retry context only, then follows durable create-then-enqueue. Its BullMQ payload remains exactly:

```json
{ "jobId": "job_123" }
```

## Error behavior

- `401`: no current session.
- `404`: Job absent or actor outside the Dataset boundary; no Job details are disclosed.
- `403`: actor can identify the Dataset but lacks the action permission.
- `409`: known Job has an ineligible state, unsupported type, or duplicate terminal action.
- `400`: invalid Job identifier or query parameters.

## Explicitly absent endpoint

`POST /api/jobs/[jobId]/commit-import` is not part of Phase 009. It is reserved for the next prepared-import and import-worker phase.
