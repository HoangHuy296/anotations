# Authorized Job Status Contract

## `GET /api/jobs/[jobId]`

This is the minimal browser-facing status-read boundary for Phase 007. It is owned by the Next.js backend; it never reads Redis/BullMQ status to form the response.

### Authorization

1. Resolve the active opaque-cookie session on the server.
2. Resolve the Job from PostgreSQL and enforce `dataset.read` against the Job Dataset.
3. Return `401` for no active session, `404` for missing/non-member/cross-Dataset Jobs, and `403` only for a visible member who lacks the required permission.

### Safe success response: `200`

```json
{
  "data": {
    "id": "cuid",
    "datasetId": "cuid",
    "type": "EXPORT_DATASET",
    "status": "QUEUED",
    "stage": "WAITING",
    "progress": 0,
    "totalItems": null,
    "processedItems": 0,
    "successCount": 0,
    "failedCount": 0,
    "skippedCount": 0,
    "summary": null,
    "createdAt": "2026-07-15T00:00:00.000Z",
    "updatedAt": "2026-07-15T00:00:00.000Z"
  }
}
```

### Canonical safe DTO

```ts
type JobSafeSummary = {
  message?: string
  outcome?: "completed" | "failed" | "canceled"
  completedAt?: string
  resultCount?: number
}

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

`summary` is optional in the source model but nullable in this response. It must be constructed by an explicit safe mapper, never forwarded as raw Prisma JSON. Its only allowed members are sanitized plain `message`, allowlisted `outcome`, ISO `completedAt`, and non-negative whole `resultCount`. For Phase 007, the worker does no business processing, so the endpoint returns `summary: null`.

The projection must not include full `input`, `state`, raw persisted `summary`, result fields, raw JobEvent data, raw errors/details, queue name/id/timestamps, provider/source-connection/repository metadata, result storage references, lock fields, private storage keys, private URLs, credentials, encrypted values, or binary data.

### Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `AUTH_REQUIRED` | No active session. |
| 403 | `FORBIDDEN` | Visible Dataset member lacks status-read permission. |
| 404 | `NOT_FOUND` | Job absent or not visible to the actor. |
