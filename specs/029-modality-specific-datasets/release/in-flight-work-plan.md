# In-flight work disposition plan (plan only — nothing is mutated)

Data source: read-only transactions on the shared dev database, 2026-10-05 ~16:13 UTC (system identifier `7662655305624969250`, `transaction_read_only = on`). Code facts are from the current repository (`apps/worker/src/readiness.ts`, `queue/*`, `jobs/import-dataset.ts`). Redis/BullMQ state was **not** inspected (no credentials were read); where it matters it is listed as a pre-cutover read-only check.

## Headline
Every Job below is **at least 38 days old** (created 2026-07-21 … 2026-08-28; the newest PREPARING import, 2026-09-24, belongs to an already CANCELED Job), none holds a live worker lease, none has a repository source connection, and most of the import Jobs belong to Datasets that are archived or deleted. **None blocks migration 24/25 itself**; the migration takes its locks in a drained window. The risk is what the **new worker does when it starts** (it runs periodic scanners from the first minute) and what a worker restart redelivers from Redis. Dispositions are decided and executed (separately authorized) **before the worker starts**.

## How the worker treats these rows after cutover (code facts)
- `failExpiredPreparedImports` (every 60 s) expires a PREPARING import only when its Job is **RUNNING or RETRYING**. Imports whose Job is QUEUED, CANCELING or CANCELED are never expired by it.
- `runPendingJobRecovery` (60 s) examines only `QUEUED` Jobs with `enqueuedAt IS NULL`; a Job that already has a queue id is skipped (`TRANSPORT_CONFLICT`, a JobEvent row is written, nothing else).
- `recoverExpiredLeaseJobs` matches `RUNNING` with a non-NULL expired `lockedUntil`; `failRunawayJobs` matches `RUNNING` with a non-NULL `lockedAt`. A Job with neither field is matched by **no** scanner.
- `processImportDataset`: a Job that has a PreparedImport returns `local-receipt` (the local-folder import is receipt-only; the worker does no asset work). A repository import (`sourceMode MIRROR_TO_MINIO` with parsable repository input) against an unresolved Dataset sets `DATASET_MODALITY_UNRESOLVED` and fails the Job (fail closed, no data change). Anything else is `not-applicable`.
- `commit-local-folder-import` rejects a preparation that is EXPIRED or past its deadline, so none of the 11 PREPARING imports can ever be committed.

## A. The 19 `IMPORT_DATASET` Jobs
All have `sourceConnectionId` NULL (no repository clone/provider involved) and no live lease.
| Group | Jobs | State | Dataset | Items / Assets | After cutover (if untouched) | Classification | Proposed disposition |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | 4 (`f1db8f25…`, `d36fe78c…`, `858cd785…`, `6f91ad63…`) | QUEUED, queue id set, stage WAITING, PREPARING import | archived/deleted | 63 / 0 | If the BullMQ entry still exists: delivered, has a PreparedImport → `local-receipt` no-op, Job completes as a receipt with nothing imported. Otherwise inert | **safely fail/cancel** | terminalize as CANCELED (reason code `STALE_PRE_PHASE029`); expire the import in the same action |
| A2 | 4 (`8303aa3c…`, `1e9f7cfe…`, `94b3b655…`, `c4446464…`) | QUEUED, queue id set, stage WRITING_ASSETS, processed = total (6/6, 1/1, 6/6, 6/6), PREPARING import | **live** (IMAGE ×3, VIDEO ×1 legacy `primaryModality`), Assets already present (6, 1, 6, 12) | | As A1 (receipt no-op). The Datasets become unresolved after M24 | **operator intervention** (confirm, do not assume) | per Job: compare Assets with the manifest; if present, terminalize as FAILED/`STALE_PRE_PHASE029` **without touching Assets** (never resume: resuming after M24 would be refused anyway); record the decision |
| C1 | 8 (`cmryqjgl5…`, `cmryqkpo0…`, `cmrys947z…`, `cmrysb8nn…`, `cmrysifqk…`, `cms4c8enm…`, `cms4eh8af…`, `cms4ei2hi…`) | RETRYING, attempts 1/3, no queue id, no PreparedImport | archived/deleted (one has 69 Assets, IMAGE) | | Inert: no scanner redelivers RETRYING; only a user retry/cancel acts on them | **safely fail/cancel** (or leave inert) | terminalize as CANCELED |
| C2 | 1 (`cms4ht5d3…`) | RETRYING, attempts 1/3, no queue id | **live** IMAGE, 6 Assets | | Inert; a manual retry after M24 would fail `DATASET_MODALITY_UNRESOLVED` if it is a repository import | **operator intervention** | inspect `Job.input` kind, then terminalize |
| D | 2 (`9ca799f0…`, `25b4bb16…`) | CANCELING, cancel requested, heartbeat set, lease expired, PREPARING import | archived/deleted, 0 Assets | 119 / 6 | No scanner finalizes CANCELING; BullMQ has no worker holding them | **drain by completing the cancel** | finalize as CANCELED (the intended end state) |

Counts: 8 QUEUED + 9 RETRYING + 2 CANCELING = 19. 14 are on not-live Datasets (A1 4, C1 8, D 2); 5 on live Datasets (A2 4, C2 1).

**Redelivery risk to check read-only before the worker starts:** whether BullMQ still holds `{ jobId }` entries for the 8 QUEUED Jobs (waiting/delayed/failed sets of the import queue). If it does, a started worker would process them as `local-receipt` (harmless) — but it is safer to terminalize first. This needs an authorized read-only Redis inspection.

## B. The 11 PREPARING `PreparedImport` rows
All have passed their deadline. 28 COMMITTED and 48 EXPIRED rows exist; none of those is in scope.
| Import(s) | Linked Job | Dataset | Classification | Proposed disposition |
| --- | --- | --- | --- | --- |
| 4 × (63 items) `40a5e230…`, `1b71c68a…`, `d652077a…`, `ead5f85e…` | QUEUED (A1) | not live | **inert, safely expired** | set EXPIRED together with A1 |
| 4 (`30fae120…` 6 items, `b92e5e28…` 1, `11ef6911…` 6, `3abc9010…` 6; the last one's Dataset already holds 12 Assets) | QUEUED (A2) | live | **operator intervention** | EXPIRED together with their A2 decision |
| 2 (`aada1293…` 119 items, `f109ab1e…` 6 items) | CANCELING (D) | not live | **drain** | EXPIRED when the cancel is finalized |
| 1 (`116e6ea6…`, 2 items) | CANCELED | live, 12 Assets | **inert, safely expired** | set EXPIRED |
They are not a migration hazard: M24 touches no `PreparedImport` row, M25 adds a NULL column (replay of an old key with a new confirmed-class request is `IDEMPOTENCY_KEY_CONFLICT`, fail closed). Leaving them PREPARING is also safe (the commit path refuses them); expiring them only tidies state and releases their idempotency keys' "preparing" appearance.

## C. The 8 stale AI Jobs
| Jobs | State | Evidence | Classification | Proposed disposition |
| --- | --- | --- | --- | --- |
| 8 × `AI_PREANNOTATE_ASSET` (`cmssmb6at…`, `cmssmb6fw…`, `cmssmb70t…`, `cmssmb76a…`, `cmssmb7a6…`, `cmssmb7dx…`, `cmssmb87m…`, `cmssmc8bf…`), created 2026-08-14 | RUNNING, attempts 0, no queue id, **no lock, lease or heartbeat**, **no `AiTask` row** | the job rows exist but the task row was never created (an interrupted creation) | **operator intervention**: no scanner matches them (no `lockedUntil`/`lockedAt`), so they never self-heal and show as "running" forever | terminalize as FAILED with reason `STALE_NO_TASK`; independent of migration 24/25. Each Job belongs to one **live IMAGE Dataset holding a single Asset with no storage reference and no subtype row** (`cmssmb6a6…`, `cmssmb6f3…`, `cmssmb704…`, `cmssmb75h…`, `cmssmb79j…`, `cmssmb7d9…`, `cmssmb86w…`, `cmssmc8ar…`): these are 8 of the 22 cohort-C Datasets of the historical plan, so coordinate with T030 remediation |

## D. Execution order and gates (none executed now)
1. **Pre-window (read-only, needs authorization):** re-run this inventory immediately before the window (the figures can change), inspect the import queue in Redis, record the result.
2. **Authorization** for one scoped maintenance action: exact Job and PreparedImport IDs (the lists above), target statuses and reason codes, per-row `WHERE` guards on current status so a changed row is skipped, evidence of before/after. This writes Job, JobEvent and PreparedImport rows only; Assets and Datasets are untouched. It must run **before** the drain/backup so that the backup captures the terminalized state, or **after** the backup inside the drained window — the choice belongs to the rollout sequence.
3. **A2 and C2** get per-Job human confirmation; A1, C1, D, the two inert imports and the CANCELED-linked import are mechanical.
4. After cutover, verify no non-terminal Job references these IDs, no scanner acted on them unexpectedly (JobEvent query), and the AI Jobs are terminal.

Not authorized and not done here: any write to these rows, any Redis read or write, starting a worker, or retrying a Job.

## F-2 and Redis reconciliation (read-only, recorded 2026-10-06)
**Redis/BullMQ (2026-10-05T16:53:15Z, queue `annotation-platform:fieldframe-jobs`, Redis database 15; read commands only):** wait, active, paused, delayed, prioritized and waiting-children are all empty; failed holds 64 and completed 2,393 jobs. Of the 27 non-terminal database jobs: **the 8 QUEUED imports and the 8 stale AI jobs have no BullMQ job key at all** (nothing to deliver, nothing a started worker can receive); **the 9 RETRYING and 2 CANCELING imports exist only as completed BullMQ jobs** (completed 2026-07-24 … 2026-08-28) while PostgreSQL never left RETRYING/CANCELING. The database inventory at 2026-10-05T16:53Z is the same 27 job IDs as the one this plan was written from. A re-read at 2026-10-06T06:47Z found the same five live-Dataset jobs. Observation: between the 2026-10-05 10:25Z preflight and 16:53Z the shared database moved (annotations 155,351 → 231,770, jobs 443 → 450, with the non-terminal set unchanged), so the window-time inventory is mandatory (F-4).

**F-2 — the four local-folder imports on live Datasets (A2), compared with their Assets:**
| Job | Import | Items | Completed | Linked to an existing Asset | Modality / size / storage-key match | Dataset Assets | Assets not linked to this import |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `1e9f7cfe…` | `b92e5e28…` PREPARING | 1 | 1 | 1 | 1 / 1 / 1 | 1 | 0 |
| `8303aa3c…` | `30fae120…` PREPARING | 6 | 6 | 6 | 6 / 6 / 6 | 6 | 0 |
| `94b3b655…` | `11ef6911…` PREPARING | 6 | 6 | 6 | 6 / 6 / 6 | 6 | 0 |
| `c4446464…` | `3abc9010…` PREPARING | 6 | 6 | 6 | 6 / 6 / 6 | 12 | 6 (belong to another import, `2387ea80…`, linked item-by-item) |
Every linked Asset is in the same Dataset and in `UPLOAD` mode; in the Dataset with 12 Assets the six linked to this import were created 2026-07-21 and the other six 2026-07-23. Job counters are `processed = success = total`, stage `WRITING_ASSETS`, never started (`startedAt` empty), `attempts` 0. **Finding:** every item was completed and published exactly as prepared; the Jobs and imports are stale only because the commit step never ran and the deadline has passed (the commit path now refuses them). No Asset is missing, duplicated or unlinked. Terminalizing these four Jobs/imports would not touch any Asset; resuming them is neither needed nor possible.

**F-2 — the RETRYING repository import on a live Dataset (C2), `cms4ht5d3…`:** a GITEA repository import (`input` keys `manifest, repository, sourceConnectionId`; `manifest.itemCount` 0; no source connection, no external repository, no PreparedImport), attempts 1/3, started 2026-07-28 10:08Z, never finished. Another Job for the same Dataset is already FAILED. The Dataset (`MIRROR_TO_MINIO`, legacy `primaryModality` IMAGE) holds 6 Assets, all `UPLOAD` mode, created 2026-07-28 15:14Z — five hours after this Job started and by a different path. **Finding:** the Job imported nothing and has no relationship to the Assets; its manifest is empty. Terminalizing it cannot affect data. After migration 24 a manual retry would fail closed (`DATASET_MODALITY_UNRESOLVED`).

**Not changed:** no Job, import, Asset, JobEvent or queue entry was altered. The remaining dispositions (the other 14 Jobs, 11 imports and 8 AI Jobs) are unchanged by this reconciliation except that the Redis question is closed.

## E. Decisions needed
**Recorded 2026-10-06:** F-1 DEFER mutation, F-2 read-only comparison approved and done (above), F-3 DEFER, F-4 approved (fresh read-only database and Redis inventory is mandatory at window preflight), F-5 deferred. Original wording follows for the record. **F-1** approve terminalizing the 14 not-live-Dataset Jobs and their imports (A1, C1, D, and the 6 related imports). **F-2** decide A2 (4 Jobs) and C2 (1 Job) per Job after the comparison. **F-3** approve FAILED/`STALE_NO_TASK` for the 8 AI Jobs, or defer them (they do not block the migration). **F-4** authorize the read-only Redis queue inspection and the fresh pre-window re-inventory. **F-5** timing relative to the backup (before drain, or inside the drained window).
