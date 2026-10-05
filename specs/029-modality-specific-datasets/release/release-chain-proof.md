# Release-chain proof — canonical 25-migration repository on disposable PostgreSQL

**Result: PASS.** Run `release:phase029-chain`, directory `specs/029-modality-specific-datasets/verification/focused-runs/20261005T160813Z-2c4c4b77` (raw evidence is gitignored and kept locally). Shared dev was not touched: the run provisions its own PostgreSQL, Redis and MinIO containers (system identifier `7693216261455953954`, not the application's).

Command: `node scripts/db-safety/disposable-test.mjs release:phase029-chain` (no argument, URL or receipt from the caller; nine receipts are issued inside the run, each scoped to exactly one step).

An earlier attempt, `…/20261005T160636Z-459c346c`, failed with `RELEASE_M25_DATASETS_CHANGED` — a defect in the new assertion (it required the fixture's resolved Datasets to be unresolved; the captures before and after M25 were identical). The assertion and its test were corrected; that run still cleaned up (primary ok, independent verifier exit 0). Both directories are retained.

## What it proves
| Requirement | Result |
| --- | --- |
| Built from the canonical repository (no staging of proposals) | `prisma/migrations` holds 25 migrations; the runner stages the 23 historical ones, then applies migration 24 and 25 from the active chain, one `migrate deploy` each |
| 25 clean migration records | `_prisma_migrations` has 25 rows, all finished, none rolled back |
| Exact frozen checksums | M24 `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7`; M25 `a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859`; the 23 historical records match the repository bytes at every stage |
| Existing migration records preserved | the first 23 rows are identical before and after migration 24, and the first 24 identical before and after migration 25 |
| Schema delta 1829 → 1841 → 1842 | reviewed manifest (`recovery.v2.review.sql`, bytes pinned): 1,829 entries after the 23 migrations; M24 adds exactly 12 (4 columns, 2 constraints, 3 triggers, 3 functions), nothing removed or changed; M25 adds exactly one (`PreparedImport.creationRequestHash`), nothing removed or changed |
| No data change | every application table fingerprint identical (34 tables plus the `PreparedImport` row comparison) across M24 (Dataset compared without its 4 new columns) and across M25; no indexes, constraints, triggers, routines or enums changed by M25 |
| Expected historical Dataset state | 8 synthetic historical Datasets (EMPTY, admin-empty, former-admin-empty, single, mixed, deleted-child, archived, deleted) seeded on the 23-migration database; after M24 all have `modality` NULL, revision 0, no resolvedAt, no subject; the same rows are unchanged after M25 |
| M25 existing rows NULL | 3 `PreparedImport` rows created by the fixture after M24 all have `creationRequestHash` NULL after M25 and are otherwise identical |
| No migration drift | `prisma migrate diff` (database vs canonical `schema.prisma`, `--exit-code`): "No difference detected"; `prisma migrate status`: "25 migrations found … Database schema is up to date!" |
| Canonical schema/client compatibility | frozen bindings verified before and after the run: schema SHA-256 `4fe3d96a…`, generated client tree `a750e6b9…` (44 files), active chain tree `f0da8710b3c874f842de6b686ae5b025dffd59f8acdab74a6e1c00faadb54ca8`; client compatibility test 12/12 |
| Runtime contracts of the historical states | `g2:candidate` contract tests (EMPTY/SINGLE/MIXED/deleted-child stay unresolved, only EMPTY resolvable, owner/admin only, immutability, opaque subject) pass on the 25-migration database; schema and history unchanged afterwards |
| Repository untouched | `g2:generate` regenerates into the tracked client directory; the runner proves the tree is byte-identical (`FROZEN_CLIENT_DRIFT` check passed) and `git status` shows no change under `lib/` or `prisma/schema.prisma` |
| Cleanup | primary cleanup: 3 containers, 3 volumes, private stage and 9 receipt registrations removed by exact identity; independent verifier (`cleanup-verify.mjs`) exit 0 |

## Receipt topology (verified by the run)
`baseline-deploy` → `generate` (`g2:generate`) → `baseline-seed` (`g2:baseline`) → `proposal-1-deploy` (M24) → `fixture` → `proposal-2-deploy` (M25) → `schema-compat` (`g2:compatibility`) → `client-compat` → `candidate-contracts` (`g2:candidate`).

## Not claimed
Not G3 or G5 evidence; not an authorization to apply anything; production-scale performance and browser end-to-end are not exercised; the shared dev database's 120 real Datasets are represented only by the synthetic historical fixture.

## Repository changes behind the proof
`git mv` of the two migrations into `prisma/migrations` (hash and size verified identical); runner bindings (`disposable-test.mjs`: promoted paths, baseline = active chain minus the two promoted names, `activeChainTreeSha256`, the new fixed plan, pure assertions); `prisma-client-stage.mjs` path/watch list; the four G2/G3 Python rehearsal scripts stage the 23-migration baseline and take migration 24 from the active chain (they remain M24-only rehearsals); offline tests (211, of which one — `runtime-browser-control` "the real rehearsal and isolation are untouched" — already failed at `1804e9a` because it asserts diagnostic wiring in `runtime-suite.mjs`/`g3-rehearse.py` that was never committed). The incident-specific recovery tooling under `scripts/phase029-recovery/` is intentionally unchanged: it recognizes the 22/23-migration states and refuses the 25-migration chain.
