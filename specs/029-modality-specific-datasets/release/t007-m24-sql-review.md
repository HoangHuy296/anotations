# T007 — final release review of the frozen migration 24 SQL

**Status: APPROVED 2026-10-05** by the project owner for the exact frozen SQL (SHA-256 `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7`); decision recorded in the last section. The approval covers those bytes only and is **not** an authorization to apply the migration anywhere. This document changes no SQL.

## Binding
| Item | Value |
| --- | --- |
| Migration | `prisma/migrations/20260930030000_dataset_modality_g2/migration.sql` |
| SHA-256 | `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7` |
| Size | 7,526 bytes, 128 lines, one transaction (`BEGIN … COMMIT`) |
| Origin | moved byte-for-byte (`git mv`, hash and size verified) from `specs/proposals/phase029-modality/migrations/`; Prisma records this checksum in `_prisma_migrations` |
| Position | migration 24, after `20260930020000_revert_dataset_modality`; migration 25 (`a8ffbc84…`, one nullable column on `PreparedImport`) follows and is outside this review |
| Provenance | the SQL changed once from `abf72fd2…` before the final verification; see `t008-provenance-exception.md` (read-only reconstruction shows which object changed and why) |

A reviewer re-checks the binding with `sha256sum prisma/migrations/20260930030000_dataset_modality_g2/migration.sql`.

## What the file does (all of it)
- **No data statement.** The only DML-looking tokens are trigger event clauses (`BEFORE INSERT/UPDATE/DELETE`). Nothing reads, updates, backfills or resolves any row.
- **Locking.** `SET LOCAL lock_timeout = '10s'`, `SET LOCAL statement_timeout = '120s'`, then `LOCK TABLE "Dataset", "Asset" IN ACCESS EXCLUSIVE MODE`. Every reader and writer of those two tables blocks for the duration. If any session holds a conflicting lock for more than 10 s the whole migration aborts and rolls back (transactional DDL). This is why the rollout drains web and worker first.
- **No table rewrite.** `ADD COLUMN … BIGINT NOT NULL DEFAULT 0` uses a constant default (metadata-only on PostgreSQL 16). The CHECK constraints are validated with one scan of `Dataset` (120 rows on shared dev).
- **Atomic.** One transaction: either all 12 objects exist or none.

## The 12 objects and their runtime consequences
| # | Object | Definition (summary) | Runtime consequence |
| --- | --- | --- | --- |
| 1 | column `Dataset.modality` | nullable enum `Modality` | NULL = unresolved. Every existing row stays NULL. |
| 2 | column `Dataset.modalityContentRevision` | `BIGINT NOT NULL DEFAULT 0` | Parent fence counter. Existing rows get 0. Only the fence/resolution code and the Asset trigger change it. |
| 3 | column `Dataset.modalityResolvedAt` | nullable timestamp | Set by the triggers, never by callers. |
| 4 | column `Dataset.modalityResolverSubject` | nullable text, 1–128 chars when set | Opaque immutable receipt of who resolved the Dataset. **No foreign key to `User`**: deleting a user never cascades into or clears a receipt (G2 candidate test "opaque subject survives actor deletion"). |
| 5 | CHECK `dataset_modality_resolution_shape` | modality, resolvedAt and subject are all NULL or all set (subject length 1–128) | A row can never be half-resolved. All 120 existing rows satisfy it (all NULL). |
| 6 | CHECK `dataset_modality_revision_nonnegative` | revision ≥ 0 | Defense in depth. |
| 7 | function `phase029_guard_dataset_insert()` | NULL modality → `DATASET_MODALITY_REQUIRED` (23514); stamps `modalityResolvedAt` with `transaction_timestamp()`; `search_path` pinned | Any writer that inserts a Dataset without a modality fails. Includes: the three production creators (supply a modality), the dormant importer and three operator scripts (would fail closed). |
| 8 | trigger `dataset_modality_insert_guard` | BEFORE INSERT ON `Dataset`, per row | binds #7. |
| 9 | function `phase029_guard_dataset_assignment()` | rejects a lowered revision (`DATASET_MODALITY_FENCE_REWIND`); once a modality is set, rejects any change of modality, resolvedAt or subject (`DATASET_MODALITY_IMMUTABLE`); NULL→value requires every existing Asset to match (`ASSET_MODALITY_MISMATCH`) and stamps resolvedAt | Modality is write-once. UPDATEs that touch no modality column pass for resolved and unresolved rows (metadata, archive, text policy, visualization). |
| 10 | trigger `dataset_modality_assignment_guard` | BEFORE UPDATE ON `Dataset`, per row | binds #9. |
| 11 | function `phase029_guard_asset_write()` | INSERT, DELETE, and any UPDATE whose evidence row changes (datasetId, modality, source identity, storage, checksum, mime, size, width, height, duration, textLength, relativePath …) takes the parent fence (`UPDATE Dataset SET modalityContentRevision = … + 1`) and enforces: unresolved parent rejects INSERT and any datasetId/modality change (`DATASET_MODALITY_UNRESOLVED`); resolved parent rejects a different asset modality (`ASSET_MODALITY_MISMATCH`); missing parent rejects (`DATASET_NOT_FOUND`), except on cascade DELETE. A non-evidence UPDATE (revision, status, description, assignee, deletedAt …) takes no parent write: it reads the parent modality and rejects only a mismatch | The database itself refuses to ingest into an unresolved Dataset or to mix modalities. Evidence-changing Asset writes serialize on the parent row (hot-parent contention). |
| 12 | trigger `asset_modality_write_guard` | BEFORE INSERT OR UPDATE OR DELETE ON `Asset`, per row | binds #11. |

Exactly 4 columns, 2 constraints, 3 triggers and 3 functions; no index, no foreign key, no policy, no enum change, no type.

## Consequences an approver is accepting
1. **All 120 existing Datasets become unresolved.** Until a separately authorized resolution/backfill, the workspace shows "resolution needed", local-folder append, direct upload and repository import into those Datasets are rejected, annotation editing is unavailable, and 19 stale import jobs / 11 prepared imports / 8 stale AI jobs need the dispositions in `in-flight-work-plan.md`.
2. **The stable 184ddd0 web runtime is not a safe rollback target** after M24: it creates Datasets without a modality (insert trigger rejects) and uploads into unresolved Datasets with raw database errors.
3. **Writers that bypass the application guards fail closed**: `prisma/review.seed.ts`, `apps/web/scripts/visualization-phase4-smoke.ts`, `scripts/027-verify-trigger.ts` (`writer-inventory.md`, T018).
4. **Resolver attribution is an opaque subject, not a `User` foreign key.** This replaces the "FK `Restrict`" option of `implementation-review.md` §11 item 2. A deleted or later-demoted user cannot erase or block the receipt; the cost is that the subject is not referentially tied to a live `User` row.
5. **Performance is not accepted.** No performance thresholds were ever approved. Evidence (disposable, small fixtures, serial repetitions; not a production-scale or soak result), eight clients, final candidate vs matched baseline (`g3-contention/runs/20261001T045031Z`): metadata same-parent p50/p95 22.7/32.6 ms vs 16.3/21.5 ms (337 vs 463 tx/s); bulk insert of eight assets p50 67.9 vs 32.5 ms (107 vs 150 tx/s, ≈71 %); Serializable same-parent exhaustion 3/320 vs 3/320. The earlier candidate (`abf72fd2…`, `…035416Z`) had Serializable same-parent exhaustion of 131/320 vs 2/320; the final SQL's non-evidence short-circuit (see T008) removed it. Bulk import throughput loss and hot-parent serialization of evidence writes remain accepted-or-not decisions for the approver. The earlier proposed criteria in `verification/g3-retry/handoff.md` (≤1 % exhausted, p95/p99 ≤ 2× baseline, throughput ≥ 70 %) were never approved; against them the bulk-insert p99 (166 vs 179 ms) and throughput (≈71 %) are marginal.
6. **Forward-only after the fact.** Rolling back removes nothing automatically; the contract keeps the additive columns and stops incompatible writers (`contracts/migration-rollout.md`).

## Evidence for the frozen bytes (all disposable; none touches shared dev)
| Claim | Evidence |
| --- | --- |
| 23 → 24 → 25 from the canonical repository; history 25, every record finished, checksums exact | `release:phase029-chain` PASS, `focused-runs/20261005T160813Z-2c4c4b77` (see `release-chain-proof.md`) |
| M24 adds exactly the 12 objects above; nothing removed or changed; schema entries 1829 → 1841 | same run, `release-m24-assertions.json` |
| No data change; every historical Dataset unresolved (NULL, revision 0) | same run (11 Datasets: 8 synthetic historical + 3 fixture) |
| Triggers reject: NULL modality, modality change, mismatched Asset, unresolved ingest, fence rewind; opaque subject; all four enum values | G2 candidate tests (`g2:candidate`, 7 tests) inside the same run |
| Concurrency: independent connections, insert/resolve/reparent races, stale Serializable assignment, deadlock retry, cascade, unresolved ingest blocked while metadata allowed | G3 concurrent-correctness schedule (one test of 17 steps, disposable): PASS on the earlier bytes (`g3-retry/runs/20261001T031819Z`) and again on the final bytes `13f0e977…` (`g3-contention/runs/20261001T045031Z`; `g3-retry/runs/20261001T084416Z`, `…20261001T112901Z`, `…20261002T052913Z`, each `# tests 1 # pass 1`) |
| No drift; client compatible | same run: `prisma migrate diff` "No difference detected", `migrate status` "25 migrations … up to date", client compat 12/12 |
| Cleanup | primary and independent cleanup verifier passed |

## Not proven by this review
- Behavior on the shared dev database at scale (never applied there).
- G5 browser/runtime end-to-end (open), production-scale performance, and any soak.
- That the old bytes (`abf72fd2…`) are preserved; they are not (T008).

## Decision record (to be completed by a human)
| Decision | Value |
| --- | --- |
| Approve the trigger, counter and receipt SQL with SHA-256 `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7` for shared dev | **APPROVED** for exactly these bytes |
| Accept the opaque `modalityResolverSubject` (no `User` FK) in place of the FK-`Restrict` option | **ACCEPTED**; the opaque resolver actor-subject design replaces the earlier User-FK concept |
| Performance position | **The observed performance regression is accepted as a known shared-dev/release capacity risk. This is NOT a performance PASS.** Production capacity acceptance remains OPEN. Correctness fencing must not be weakened for performance |
| Approver / date | Project owner (instruction given in the session of 2026-10-05) / 2026-10-05 |

**Scope of the approval:** it closes the G-SQL review of the frozen bytes. It does not authorize shared-dev migration, backup, drain, deployment, backfill, service replacement or any application-data mutation; those remain separate gates. The previously proposed performance criteria (≤1 % exhausted, p95/p99 ≤ 2× baseline, throughput ≥ 70 %) remain unapproved and are the open production-capacity item.
