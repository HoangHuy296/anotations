# AI Integration API Contract

## Common rules

- All routes use the normal opaque-cookie session (`getRequestActor()`); an
  unauthenticated request receives `401 AUTH_REQUIRED`.
- `datasetId` authorization uses the existing `annotation.create` permission
  (any actor who can create manual annotations on a dataset may also request
  AI pre-annotation for it — no separate AI permission tier) for creation, and
  `dataset.read` for status reads. A dataset the actor cannot access is
  concealed as `404`, matching the platform's existing resource-concealment
  policy (see `docs/architecture.md`/existing Job routes).
- `Job.provider` never appears in any request or response body on these
  routes. The AI provider is an internal resolution detail
  (`AiTask.modelId → AiModel.provider`) and is never itself part of the public
  contract.
- Responses are safe DTOs only: no database internals, lock tokens, worker
  identifiers, provider credentials, or raw provider payloads.
- Cancelling an AI task is cancelling its `Job` — `POST /api/ai/tasks/{aiTaskId}/cancel`
  (below) is a `taskId`-scoped entry point onto the same cancellation the
  platform already exposes at `POST /api/jobs/{jobId}/cancel`, not a second
  cancellation mechanism (`jobId` is still included in every response above
  so a client that already has it can use either route interchangeably).

## `GET /api/ai/models`

Lists AI models currently available for pre-annotation requests.

### Success — `200`

```json
{
  "data": {
    "models": [
      {
        "id": "model-id",
        "key": "aioz-detector-v2",
        "displayName": "AIOZ Object Detector v2",
        "modality": "IMAGE",
        "taskType": "DETECT_OBJECTS"
      }
    ]
  }
}
```

Only `AiModel` rows with `isActive: true` are returned. `modality: null` on the
underlying row (a model that supports more than one modality) is surfaced as
`"modality": null` — the client must not assume every model is single-modality.
`provider` is never included in this response; it is an internal resolution
detail, not something a browser client selects.

## `POST /api/ai/tasks`

Requests AI pre-annotation for one or more assets in a dataset.

### Request

```json
{
  "datasetId": "dataset-id",
  "modelId": "model-id",
  "assetIds": ["asset-id-1", "asset-id-2"]
}
```

- `assetIds` must be non-empty and every id must belong to `datasetId`
  (checked server-side before any durable record is created).
- `modelId` must reference a currently active `AiModel`.

### Success — `202`

```json
{
  "data": { "taskId": "ai-task-id", "jobId": "job-id" }
}
```

`202` is returned in every accepted case, including the case where the
durable `Job`/`AiTask` pair committed but the queue transport delivery is
momentarily pending (mirrors the existing `enqueueExistingJob` deliver-pending
contract already used by other durable-Job creation routes) — the request is
never lost, and a background recovery pass redelivers it. The caller does not
need to distinguish "delivered" from "pending" from this response; both are
already durably queued for processing.

### Failure

| Status | Code | Condition |
| --- | --- | --- |
| `400` | `INVALID_REQUEST` | Body fails schema validation. |
| `403` | `FORBIDDEN` | Actor lacks `annotation.create` on the dataset. |
| `404` | `DATASET_NOT_FOUND` | Dataset does not exist, or actor cannot access it (concealed). |
| `409` | `ASSET_NOT_IN_DATASET` | One or more `assetIds` do not belong to `datasetId`. |
| `409` | `AI_MODEL_INACTIVE` | `modelId` references a disabled/inactive model. |
| `404` | `AI_MODEL_NOT_FOUND` | `modelId` does not reference any model. |

No `Job` or `AiTask` row is created for any failure above (FR-002/FR-003):
validation and authorization happen before the creation transaction opens.

## `GET /api/ai/tasks/{aiTaskId}`

Reads the current status of a previously submitted AI task.

### Success — `200`

```json
{
  "data": {
    "taskId": "ai-task-id",
    "jobId": "job-id",
    "datasetId": "dataset-id",
    "status": "RUNNING",
    "type": "PREANNOTATE_ASSET",
    "modality": "IMAGE",
    "modelNameSnapshot": "AIOZ Object Detector v2",
    "modelVersionSnapshot": "2.1.0",
    "pollAttempts": 4,
    "createdAt": "2026-08-12T00:00:00.000Z",
    "updatedAt": "2026-08-12T00:02:00.000Z",
    "error": null,
    "errorCode": null
  }
}
```

`status` is one of `QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELED`
(`AiTaskStatus`). On `FAILED`, `error`/`errorCode` are populated
(`errorCode: "AI_TASK_TIMEOUT"` for a poll-budget timeout). The response never
includes `externalTaskId`, raw provider output, or lock/worker fields.

### Failure

| Status | Code | Condition |
| --- | --- | --- |
| `404` | `AI_TASK_NOT_FOUND` | Task does not exist, or actor cannot access its dataset (concealed). |

## `POST /api/ai/tasks/{aiTaskId}/cancel`

Cancels a previously submitted AI task by its own id — a `taskId`-scoped
entry point onto the same cancellation `POST /api/jobs/{jobId}/cancel`
already performs on the task's underlying `Job` (see Common rules above).
Authorization uses the existing `job.cancel` permission on the task's
Dataset, applied to its `Job` exactly as the generic route already does.

### Success — `200`

```json
{
  "data": { "taskId": "ai-task-id", "jobId": "job-id", "status": "CANCELING" }
}
```

`status` is `"CANCELED"` when the underlying `Job` was still `QUEUED` or
`RETRYING` (cancellation is immediate and terminal), or `"CANCELING"` when it
was already `RUNNING` (cancellation is cooperative — a worker still in flight
finalizes it to `CANCELED`; `GET /api/ai/tasks/{aiTaskId}` reflects the final
`AiTaskStatus` once that happens).

### Failure

| Status | Code | Condition |
| --- | --- | --- |
| `401` | `AUTH_REQUIRED` | No session. |
| `404` | `AI_TASK_NOT_FOUND` | Task does not exist, or actor cannot access its dataset (concealed). |
| `403` | `FORBIDDEN` | Actor lacks `job.cancel` on the task's Dataset. |
| `409` | `JOB_CONFLICT` | The underlying Job is already in a terminal state (`COMPLETED`/`FAILED`/`CANCELED`) or otherwise cannot be canceled right now. |
