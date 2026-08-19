# Phase 1 Data Model: Production Hardening and Garbage Collection

**No Prisma schema migration is required by this feature.** Every entity below is either reused exactly as it exists in `prisma/schema.prisma` today, or is a derived/ephemeral concept with no new table, column, or enum value. This is a deliberate design outcome of `research.md` (decisions 1, 5, 6), not an oversight — AGENTS.md forbids redesigning the `Job` state machine or adding parallel job/dead-letter tables without necessity, and every requirement in this feature turned out to be satisfiable from fields that already exist.

## Reused Entities

### Job (`prisma/schema.prisma` `model Job` — unchanged)

The durable record of one asynchronous unit of work. This feature reads and writes existing fields; no new field is added.

| Field (existing) | Used for in this feature |
| --- | --- |
| `status` (`QUEUED`\|`RUNNING`\|`RETRYING`\|`COMPLETED`\|`FAILED`\|`CANCELING`\|`CANCELED`) | Recovery/stale-detection transitions `RUNNING → RETRYING` (under retry budget) or `RUNNING → FAILED` (budget exhausted / dead-letter). No new value added. |
| `lockedBy` / `lockToken` / `lockedAt` / `lockedUntil` / `heartbeatAt` | The lease this feature's stale-`RUNNING` detector reads (`lockedUntil < NOW()`) and clears on recovery, using the same atomic-`UPDATE` idiom as `job-lock.ts`. |
| `attempts` / `maxAttempts` | Incremented on recovery; compared to decide retry vs. dead-letter. Dead-letter is **derived**, not stored: `status = 'FAILED' AND attempts >= maxAttempts`. |
| `errorCode` / `error` / `errorDetails` | Carries a machine-readable reason for stale-timeout and recovery-exhausted failures (e.g. `STALE_RUNNING_TIMEOUT`, `RECOVERY_EXHAUSTED`), reusing the same fields `IMPORT_COMMIT_TIMEOUT` already uses today. |
| `queueName` / `queueJobId` / `enqueuedAt` / `dequeuedAt` | Read by the (now-scheduled) `recovery-scanner.ts` to find jobs whose durable record exists but were never delivered to BullMQ — the Redis-outage-recovery candidate set. |
| `retryOfJobId` | Unaffected — recovery/dead-letter retries the *same* Job row (`attempts++` in place); this lineage field remains reserved for the existing user-authorized-retry flow (`POST /api/jobs/[jobId]/retry`), not touched by automatic recovery. |
| `cancelRequestedAt` / `canceledAt` | Read (not written) by the recovery scanner, which already skips a candidate with `cancelRequestedAt` set. |

No new `JobStatus`, `JobType`, or `JobTrigger` enum value is introduced.

### JobEvent (`prisma/schema.prisma` `model JobEvent` — unchanged)

Append-only event history, `{ jobId, level, stage, message, data, createdAt }`. This feature:
- **Writes** new event `message`/`data` values for recovery, stale-timeout, dead-letter, and cleanup outcomes, following the existing convention (`writeSafeJobEvent`, already used by `recovery-scanner.ts`).
- **Deletes** rows older than `JOB_EVENT_RETENTION_DAYS` in batches, gated by `job.status IN (terminal states)` so an active job's events are never touched — no column changes, purely a new scheduled `DELETE ... WHERE id IN (SELECT id ... LIMIT <batchSize>)` pass.

### PreparedImport / PreparedImportItem (`prisma/schema.prisma` — unchanged)

`PreparedImport.status` (`PREPARING`\|`COMMITTED`\|`EXPIRED`) and `deadlineAt` already fully express the commit-timeout state machine `import-timeout-scanner.ts` enforces. This feature adds scheduling and tests only.

### Asset / AssetVersion / Dataset (`prisma/schema.prisma` — unchanged)

Read-only from this feature's perspective for GC purposes: `Asset.storageProvider`/`storageBucket`/`storageKey` (unique together) is the reference the orphan scanner checks every MinIO object key against; `Asset.deletedAt` distinguishes a soft-deleted asset (whose object becomes a cleanup-job target) from a live one. `Dataset` deletion cascades to `Asset` at the database level (`onDelete: Cascade` on `Asset.dataset`); the dataset-cleanup job walks the dataset's (now-cascaded-away, so captured *before* the cascade or read from an audit trail — see Open Question below) asset storage keys.

> **Open question carried into `/speckit-tasks`**: `Asset.dataset` is `onDelete: Cascade`, meaning a `Dataset` delete already removes its `Asset` rows in the same transaction. The dataset-cleanup job (FR-028/FR-029) must therefore capture the affected assets' `(storageProvider, storageBucket, storageKey)` triples *before* the cascading delete commits (e.g. read them in the same request that performs the delete, before calling `dataset.delete()`), then hand that captured list to the batched MinIO cleanup pass — it cannot look them up afterward. This ordering must be implemented as one unit; flagged here so `/speckit-tasks` sequences it correctly rather than assuming the rows are still queryable post-delete.

### AiTask (`prisma/schema.prisma` — unchanged)

Read-only: this feature's logging (FR-049) and observability (FR-051) surfaces read `AiTask.id`/`jobId`/`modelId`/`status` for structured log fields and dead-letter/stale counts; no field is added or changed. AI task behavior itself is explicitly out of scope.

## Derived Concepts (no schema, computed at query time)

| Concept | How it's derived |
| --- | --- |
| **Dead-lettered Job** | `status = 'FAILED' AND attempts >= maxAttempts` (optionally further narrowed by a recognized `errorCode`, e.g. excluding validation failures that fail on attempt 1 by design if that distinction matters at implementation time — to be confirmed in `/speckit-tasks`). |
| **Stale Job** | `status = 'RUNNING' AND lockedUntil < NOW()`. |
| **Recovering Job** | A `JobEvent` with a recovery-specific `message` exists for that `jobId` — used only for observability counts, not as a state gate. |
| **Orphaned storage object** | A MinIO object key with no matching `Asset` row where `storageProvider/storageBucket/storageKey` equals that key AND `deletedAt IS NULL`, **and** the object's own `LastModified`/`stat` timestamp is older than the configured grace period. |
| **Active upload (direct/browser upload path)** | Cannot be positively confirmed via a DB row (no session table exists for this path — see `research.md` decision 5) — treated conservatively as "any object younger than the grace period," per FR-032 ("when uncertain, do not delete"). |
| **Active upload (prepared-import path)** | `PreparedImport.status = 'PREPARING' AND deadlineAt >= NOW()` for the owning import. |

## New Ephemeral State (Redis — not a database entity)

### Rate Limit Window

- **Key shape**: `ratelimit:{userId}:{routeCategory}:{windowStartEpochSeconds}` (fixed window; `routeCategory` ∈ `{ai-task, import, export}` per FR-037's minimum endpoint set).
- **Value**: integer count, incremented via `INCR`, with `EXPIRE` set on first increment to the window length.
- **Authority**: explicitly **not** authoritative for anything — losing this key (e.g. a Redis restart) only ever *relaxes* the limit temporarily, never blocks or loses a `Job`. This is the one new piece of Redis-resident state this feature introduces, and it is designed so that AGENTS.md's "Redis is transport only, never a Job store" is respected: no `Job` field or lifecycle decision ever depends on this key's presence or value.

## Configuration (new environment variables, no schema — reuses the `apps/worker/src/config.ts` `z.coerce...default()` policy-schema convention)

| Variable | Purpose | Suggested default |
| --- | --- | --- |
| `JOB_RECOVERY_LEASE_GRACE_MS` | How far past `lockedUntil` a `RUNNING` job must be before the stale-job detector reclaims it (separate from the lease duration itself, to absorb clock/scheduling jitter). | `60_000` (1 min) |
| `JOB_MAX_RUNTIME_MS` | Absolute cap on how long a job may stay `RUNNING` regardless of lease renewals, before the stale-job detector fails it outright. | `3_600_000` (1 hr) — override per `JobType` if needed at task-breakdown time |
| `JOB_EVENT_RETENTION_DAYS` | Age past which `JobEvent` rows for terminal Jobs are deleted. | `30` |
| `JOB_EVENT_CLEANUP_BATCH_SIZE` | Rows deleted per batch iteration. | `500` |
| `MINIO_ORPHAN_GRACE_PERIOD_MS` | Minimum object age before the orphan scanner may delete it. | `86_400_000` (24 hr) |
| `MINIO_ORPHAN_SCAN_DRY_RUN` | Default dry-run posture for the scheduled orphan scan. | `true` (explicit opt-in required to enable live deletion) |
| `TEMP_UPLOAD_RETENTION_MS` | Age past which a temp/prepared-import-prefix object with no active session is removed. | `86_400_000` (24 hr) |
| `RATE_LIMIT_AI_TASK_PER_MINUTE`, `RATE_LIMIT_IMPORT_PER_MINUTE`, `RATE_LIMIT_EXPORT_PER_MINUTE` | Per-user, per-route-category request ceiling. | `10` each — tune per route at task-breakdown time |
| `PAGINATION_MAX_PAGE_SIZE` | Hard cap on any caller-requested page size across newly-paginated endpoints. | `100` |

All are read through a new `z.coerce.number().int().min().max().default()` schema in `apps/worker/src/config.ts` (worker-side thresholds) and an analogous small schema in `apps/web` (rate-limit/pagination), matching the existing `repositoryImportPolicySchema` pattern exactly — no ad hoc `process.env.X` reads.
