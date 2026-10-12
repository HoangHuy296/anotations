# Release-owner decisions recorded 2026-10-06 (D-1…D-8, F-1…F-5)

Recorded as given by the release owner. Nothing below authorizes a shared-dev migration, backup, service change, backfill, EMPTY resolution, job-state mutation or Dataset deletion.

| ID | Decision | Effect |
| --- | --- | --- |
| D-1 | **APPROVED** — build T029/T031 | built and disposable-verified (`t029-t031-backfill.md`); no shared-dev execution |
| D-2 | **APPROVED**, Cohort A membership subject to fresh T029 evidence; the count of 29 is not permanently frozen | current database-evidence count is **28** (see `t029-t031-backfill.md`); the window-time T029 manifest decides |
| D-3 | **APPROVED WITH QUALIFICATION** — verify authoritative Asset/subtype/storage evidence and object metadata existence/size; compare the recorded ETag/version identity when that identity is authoritative and present for the source/storage mode; do not invent an ETag/version requirement for historical rows whose canonical identity uses another mechanism; no full object-byte reads unless an existing authoritative contract requires them | implemented as the object metadata rule: existence, size against `Asset.sizeBytes`, and `Asset.sourceEtag` only when one is recorded (none of the 189 Cohort-A Assets records one) |
| D-4 | **APPROVED** — archived/deleted Datasets remain unresolved | T029 rejects them (`DATASET_NOT_LIVE`) |
| D-5 | **APPROVED** — do not modify or use legacy `primaryModality` as authority | it appears in no evidence type; the rehearsal proves it is unchanged, including a conflicting value |
| D-6 | **APPROVED** — receipt-bound opaque subject `system:phase029-backfill:<run-token>` | `backfillSubject(runToken)` |
| D-7 | **APPROVED** — EMPTY stays explicit OWNER/current ADMIN resolution; no system backfill | T029 rejects EMPTY (`EMPTY_DATASET`); the human path is untouched |
| D-8 | **PARTIAL** — T030 is a separate remediation checkpoint; Dataset deletion is not an approved or default remediation; inventory and propose evidence-preserving repair per affected Dataset; any destructive deletion needs separate authorization | `cohort-c-remediation-inventory.md` is the next scoped artifact (not part of this checkpoint) |
| F-1 | **DEFER** mutation; preserve the 14 inert rows | no job or import was changed |
| F-2 | **APPROVE** read-only per-job comparison only; return results before terminalization | done, `in-flight-work-plan.md` §F-2 |
| F-3 | **DEFER** the 8 stale AI rows | untouched |
| F-4 | **APPROVED** — a fresh read-only database and Redis inventory is mandatory at maintenance-window preflight | recorded as a hard preflight step |
| F-5 | deferred / not applicable until a job mutation is separately authorized | — |
