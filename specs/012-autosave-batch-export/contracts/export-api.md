# Export API Contract

All routes use the current opaque-cookie session and resolve authorization through the export Job's Dataset. They use the existing response envelope and safe error conventions. No route accepts browser-selected owner, Job state, queue/lock field, worker identity, bucket, object key, artifact filename, or provider credential.

## POST `/api/export`

Creates or reconciles an authorized durable JSON export Job, then asks the existing enqueue service to deliver `{ jobId }`.

### Request

```ts
type CreateExportRequest = {
  datasetId: string;
  format?: "JSON";                 // defaults to and is restricted to JSON
  manifestSchemaVersion?: "1";     // defaults to and is restricted to 1
};
```

Unknown properties are rejected. The server derives canonical input and idempotency context after validating the session and `job.createExport` permission.

### Success response

```ts
type CreateExportResponse = {
  job: SafeJobStatus;
  deliveryPending: boolean;
};
```

- First durable creation/enqueue reports `201`; a repeated identical start may report the existing Job with `200`.
- An enqueue outage may report `202` with `deliveryPending: true`; the returned Job remains `QUEUED` in PostgreSQL and is recoverable. It is never reported as completed.

### Error behavior

| Condition | Status | Safe error behavior |
| --- | --- | --- |
| Missing/invalid session | 401 | Authentication-required error only |
| Malformed or unsupported configuration | 400 | Validation error only |
| Dataset absent or caller outside Dataset scope | 404 | No Dataset/Job details |
| Known Dataset without export permission | 403 | Forbidden error only |
| Archived/deleted/ineligible Dataset or incompatible duplicate state | 409 | Safe conflict code only |

Denials and validation failures create no Job, JobEvent, queue delivery, export artifact, or metadata mutation.

## GET `/api/export/[jobId]`

Returns safe status for one authorized `EXPORT_DATASET` Job. If its private artifact is complete and available, it also returns a short-lived authorized download capability.

### Success response

```ts
type ExportStatusResponse = {
  job: SafeJobStatus;
  download: null | {
    url: string;                    // short-lived object-scoped capability
    expiresAt: string;
    filename: string;
  };
};
```

- `download` is `null` unless the Job is completed and its artifact is verified as available.
- `url` is a temporary capability, not a credential. It is not persisted in browser state/logs and never permits object listing or another object.

### Excluded response fields

The route never returns raw `Job.input`, `Job.state`, `Job.summary`, raw `JobEvent.data`, error details, queue/lock fields, retry internals, `resultStorageKey`, bucket, provider configuration, source-connection data, credentials, tokens, private URLs, or binary data.

### Error behavior

`401`, `404`, `403`, and `409` retain the safe semantics above. A known Job outside Dataset scope is concealed with `404`; no download is issued.

## Queue and worker boundary

```json
{ "jobId": "durable-job-id" }
```

This is the complete queue message. The private worker reloads the Job from PostgreSQL, claims it through the existing lock protocol, and writes status/progress/result metadata there. Browser polling uses `GET /api/export/[jobId]` or the existing safe Job status route, never BullMQ/Redis.
