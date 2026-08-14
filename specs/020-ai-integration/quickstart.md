# Quickstart: AI Integration through BullMQ

Validates the feature end-to-end against a running local stack (PostgreSQL,
Redis, MinIO, web app, worker — same Docker Compose topology as every prior
phase). No implementation code is included here; see
[contracts/ai-api.md](./contracts/ai-api.md) and [data-model.md](./data-model.md)
for exact shapes.

## Prerequisites

- Local stack running (`docker compose up`, per `docs/architecture.md`).
- An authenticated session (existing login flow) with `annotation.create`
  access to a dataset that has at least one asset.
- At least one `AiModel` row with `isActive: true` seeded in the database
  (e.g. `key: "aioz-detector-v2"`, `provider: "aioz-company"`,
  `taskType: "DETECT_OBJECTS"`, `modality: "IMAGE"`).
- The "AIOZ-company API" adapter's endpoint/credential env vars configured for
  the worker process (server-side only — never in browser code or a queue
  payload, per `AGENTS.md`).

## Scenario 1 — Happy path: request → draft annotations appear

1. `GET /api/ai/models` → confirm the seeded active model is listed and no
   disabled model appears.
2. Note one asset's id in the target dataset. Optionally create a manual
   annotation on it first (to verify it survives untouched later).
3. `POST /api/ai/tasks` with `{ datasetId, modelId, assetIds: [assetId] }`.
   **Expect**: `202` with `{ taskId, jobId }`, returned in well under a
   second — the request does not block on AI processing (SC-001).
4. Poll `GET /api/ai/tasks/{taskId}` every few seconds.
   **Expect**: `status` starts `QUEUED`/`RUNNING`, and — once the worker's
   `ai-submit` step has run and the configured provider has produced a
   result — reaches `SUCCEEDED` within the provider's normal turnaround time.
5. Fetch the asset's annotations (existing `GET /api/assets/{assetId}/annotations`).
   **Expect**:
   - One or more **new** annotations with `source: "AI"`, `status: "DRAFT"`,
     and `properties.aiTaskId === taskId` (SC-002).
   - The manual annotation created in step 2, if any, is present and
     byte-for-byte unchanged (`revision` unchanged) — 0% of manual
     annotations altered (SC-002, FR-016).

## Scenario 2 — Reject before any durable record is created

1. `POST /api/ai/tasks` with an `assetId` that belongs to a *different*
   dataset than the given `datasetId`.
   **Expect**: `409 ASSET_NOT_IN_DATASET`, and no new `Job`/`AiTask` row
   exists afterward (query the dataset's jobs list — count unchanged)
   (FR-002).
2. `POST /api/ai/tasks` with a `modelId` referencing an inactive `AiModel`.
   **Expect**: `409 AI_MODEL_INACTIVE`, and again no new `Job`/`AiTask` row
   (FR-003).

## Scenario 3 — Bounded polling (timeout path)

Point the configured provider adapter at a test double that always reports
`PENDING`/`IN_PROGRESS` (or is unreachable) for a given `externalTaskId`.

1. Submit a task as in Scenario 1.
2. Wait past `MAX_POLL_DURATION_MS` (or, for a fast local check, temporarily
   lower this constant and `MAX_POLL_ATTEMPTS`).
   **Expect**: `GET /api/ai/tasks/{taskId}` eventually reports `status: "FAILED"`
   with `errorCode` reflecting a timeout, and the associated `Job` also
   reaches a non-running terminal state (`FAILED`) — never left `RUNNING`
   indefinitely (SC-003, FR-010, FR-017).
3. Confirm no annotations were created for that task.

## Scenario 4 — Cancellation stops outbound provider calls

1. Submit a task against a slow/always-pending provider double (as in
   Scenario 3), and let it reach at least one `RUNNING` poll cycle.
2. Call the existing `POST /api/jobs/{jobId}/cancel` using the `jobId` from
   the task-creation response.
3. Instrument or log the provider double's call count at the moment of
   cancellation.
   **Expect**: no further calls to the provider double occur after
   cancellation is recorded (SC-005, FR-011), and
   `GET /api/ai/tasks/{taskId}` settles into `status: "CANCELED"` rather than
   completing.
4. Cancel the same `jobId` again.
   **Expect**: the already-terminal outcome is unchanged (no error, no state
   flip) — matches User Story 4's second acceptance scenario.

## Scenario 5 — Concurrent poll safety

1. Submit a task against a provider double that reports `COMPLETED` with a
   fixed, valid prediction set.
2. Trigger two poll attempts for the same `jobId` in close succession (e.g.,
   by forcing two scanner ticks to race, or by invoking the poll processor
   function twice concurrently in a test harness).
   **Expect**: exactly one set of annotations is created (no duplicates), the
   provider double is called at most the expected number of times, and the
   `AiTask`/`Job` reach `SUCCEEDED`/`COMPLETED` exactly once (SC-007,
   `renewOrReclaimLock` lock-gating).

## Manual smoke test command reference

```bash
# List active models
curl -sb cookies.txt http://localhost:3000/api/ai/models | jq

# Submit a pre-annotation request
curl -sb cookies.txt -X POST http://localhost:3000/api/ai/tasks \
  -H 'content-type: application/json' \
  -d '{"datasetId":"<dataset-id>","modelId":"<model-id>","assetIds":["<asset-id>"]}' | jq

# Poll status
curl -sb cookies.txt http://localhost:3000/api/ai/tasks/<task-id> | jq

# Cancel via the existing Job endpoint
curl -sb cookies.txt -X POST http://localhost:3000/api/jobs/<job-id>/cancel | jq
```
