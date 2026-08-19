# Quickstart: Validating Production Hardening and Garbage Collection

Prerequisites: local stack running via `docker compose -f docker-compose.yaml up -d postgres redis minio` (or the full stack), `.env` populated per `data-model.md`'s new environment variables (sensible defaults listed there work out of the box), `pnpm install`, `pnpm db:migrate` (no new migration is expected from this feature, but keeps the schema current), workers started with `pnpm dev:worker`, web app with `pnpm dev`.

Each section below is this feature's user story restated as a runnable check. Full field/response shapes are in `contracts/`; full entity/state notes are in `data-model.md` — this file only sequences the steps.

## US1 — Stuck and runaway jobs recover (P1)

1. Create any job-backed action (e.g. start a local-folder import) and note its `jobId`.
2. While the worker is mid-claim, kill the worker process (`Ctrl-C` / `docker compose stop worker`) before it finishes, without letting it release its lock.
3. Wait past `JOB_RECOVERY_LEASE_GRACE_MS` + the lease duration.
4. Start a worker again (`pnpm dev:worker` / `docker compose start worker`).
5. **Expect**: the job's `attempts` increments by 1, a `JobEvent` describing the recovery appears (`GET /api/jobs/{jobId}/events`), and the job either completes on retry or, once `attempts >= maxAttempts`, reaches `status: FAILED` with a recorded `errorCode` — never stuck in `RUNNING` forever, never processed twice (verify via idempotent side effects, e.g. no duplicate `Asset` rows).
6. Run the same recovery pass twice back-to-back (e.g. trigger it manually via its exported function in a `node:test` script) and confirm the second run is a no-op on an already-recovered job (FR-003).

## US2 — Queue/cache outages never lose a job (P1)

1. Stop Redis (`docker compose stop redis`).
2. Submit a job-creating request (e.g. `POST /api/ai/tasks`).
3. **Expect**: `HTTP` response is an honest failure (not a false "queued" success), and if a `Job` row was created it has `queueName: null, enqueuedAt: null`.
4. Restart Redis (`docker compose start redis`).
5. **Expect**: within one scheduled recovery-scanner tick, the job becomes eligible for delivery without resubmitting it, and no duplicate `Job` row exists for the same request (check via the endpoint's own idempotency key if applicable).
6. Separately, force a BullMQ stall (e.g. a worker that claims a delivery and then hangs past `lockDuration`) and confirm BullMQ redelivers it, `claimJob`'s guard makes the redelivery a safe no-op against the still-`RUNNING` row, and the Postgres-side stale detector is the eventual backstop if the process never comes back.

## US3 — Imports never hang on a missing commit (P1)

1. Start a local-folder import (creates a `PreparedImport` with `status: PREPARING` and a `deadlineAt`).
2. **Commit-before-timeout**: call the commit endpoint before `deadlineAt` — expect normal success, `PreparedImport.status: COMMITTED`, timeout scanner takes no action.
3. **Commit-after-timeout**: start a second import, withhold the commit call, wait past `deadlineAt`, let the scheduled scanner tick — expect `Job.status: FAILED`, `errorCode: IMPORT_COMMIT_TIMEOUT`, `PreparedImport.status: EXPIRED`, a `JobEvent` recording the reason, and any assets already committed by earlier items in that batch remain visible in the dataset.
4. **Worker restart mid-commit**: kill the worker between the commit call's write and its finalization step (if the flow has an intermediate state), restart, and confirm the import either resumes to `COMMITTED` or is caught by the timeout scanner — never left ambiguous.
5. Re-run the scanner against an already-`EXPIRED` import — expect no duplicate failure/event (FR-014).

## US4 — Deleted data and abandoned uploads stop costing storage (P1)

1. Delete a single `Asset`. **Expect**: the DB delete succeeds immediately; within the cleanup job's schedule, the corresponding MinIO object is gone (`minio.statObject` → not found).
2. Repeat with MinIO stopped at the moment of deletion (`docker compose stop minio`). **Expect**: DB deletion still succeeds; the cleanup job fails and logs the failure (FR-048); restart MinIO and confirm either the retried cleanup job or the next orphan-scan tick removes the object.
3. Delete a `Dataset` with several assets. **Expect**: cleanup proceeds in batches (observable via structured log entries per batch, not one unbounded call), and any object still referenced by a surviving record (if the data model ever allows it) is preserved.
4. Run the orphan scanner with `MINIO_ORPHAN_SCAN_DRY_RUN=true` against a bucket with at least one known-orphaned object younger than the grace period and one older. **Expect**: both are reported, neither is deleted.
5. Flip to live mode (`MINIO_ORPHAN_SCAN_DRY_RUN=false`) and re-run. **Expect**: only the object past the grace period is deleted; the younger one is left untouched.
6. Run the same live-mode scan twice in a row. **Expect**: identical end state after both runs (FR-031) — the second run reports zero additional deletions.
7. Upload a file via the presigned-upload flow, stop before calling the publish endpoint, and confirm the orphaned object is **not** removed until it exceeds `TEMP_UPLOAD_RETENTION_MS` — never while "fresh."

## US5 — JobEvent history stays bounded (P2)

1. Seed `JobEvent` rows for a terminal `Job`, some older than `JOB_EVENT_RETENTION_DAYS`, some newer (e.g. via direct test-fixture inserts backdating `createdAt`).
2. Run the retention cleanup. **Expect**: only the old rows for that terminal job are gone, in `JOB_EVENT_CLEANUP_BATCH_SIZE`-sized batches (observe via query count/log entries), and the pass exits cleanly if re-run immediately after.
3. Repeat with an **active** (non-terminal) job whose events are old. **Expect**: none of its events are deleted regardless of age.

## US6 — Operators can see platform health (P2)

1. Call `GET /api/health` as an unauthenticated caller. **Expect**: `{ "status": "ready" | "not_ready" }` only, matching `contracts/health-observability.md`'s authorization note.
2. Call it again authenticated as an `ADMIN`-role user. **Expect**: the full `checks`/`jobs`/`cleanup` body.
3. Trigger a job failure, a recovery, and one cleanup pass; confirm each shows up in the relevant count (`jobs.failed`, `jobs.stale`→0 after recovery) and in structured log output (`grep` the worker's stdout for the new JSON log lines) — with no credentials, tokens, or signed URLs present anywhere in that output. (`cleanup.*` "last ran at" timestamps were deliberately not added to the health body — no cross-process queryable state exists for it without a new table, out of scope for this feature's "basic operational visibility" goal; a cleanup pass's occurrence is only observable via its structured log line or its `JobEvent`/`MaintenanceEvent`-equivalent trail, not a health-endpoint field.)

## US7 — Platform survives traffic spikes (P2)

1. As one authenticated user, submit `RATE_LIMIT_AI_TASK_PER_MINUTE` (or however many the configured limit is) `POST /api/ai/tasks` requests within the window. **Expect**: all succeed.
2. Submit one more within the same window. **Expect**: `HTTP 429`, body per `contracts/rate-limit-error.md`, and no `Job`/`AiTask` row created for the rejected request.
3. Wait for the window to roll over. **Expect**: the next request succeeds again.
4. Confirm a second, different user is unaffected by the first user's limit during the same window.
5. Confirm an internal worker-side operation (not an end-user HTTP call) is never subject to this check by construction (it never calls the browser-facing route).

## US8 — Large lists stay fast (P2)

1. Seed a dataset with 15+ assets; open its workspace and the Properties Panel's Assets tab. **Expect**: exactly 10 assets on page 1, `Next` advances to page 2 with the remaining 5, `Previous` disabled on page 1 only — per `contracts/properties-panel-labels-assets.md`.
2. In the Labels tab, create a label choosing a color visually and confirm the "Color code" field reflects the chosen hex and is itself editable; confirm the created label's swatch matches. Compare against the same flow on `/labels` for parity.
3. Hover/inspect the "Add defaults" control and confirm explanatory copy is present (FR-045).
4. Call `GET /api/datasets` and `GET /api/datasets/{id}/labels` with 20+ seeded rows each; confirm both return the bounded envelope from `contracts/pagination-envelope.md`, that an oversized `pageSize` query param is clamped, and that `GET /api/datasets/{id}/assets` and `GET /api/jobs/{id}/events` are byte-for-byte unchanged in shape from before this feature.

## US9 — Docker Compose starts everything together (P3)

1. From a clean checkout: `docker compose -f docker-compose.yaml up -d`.
2. **Expect**: `docker compose ps` shows `postgres`, `redis`, `minio`, `web`, `worker` all healthy/running (plus `gitea`, unaffected by this feature).
3. Through the running `web` container, submit one job-creating request end-to-end and confirm it reaches a terminal state, proving `web` ↔ `worker` ↔ `postgres`/`redis`/`minio` are actually connected, not just individually up.
4. Confirm every new environment variable from `data-model.md`'s configuration table has a documented default in `docker-compose.yaml` (or its `.env.example` equivalent) so a clean checkout needs no undocumented manual step (FR-057).
