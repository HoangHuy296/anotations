# Phase 029 release review — index and gate status (2026-10-05)

Scope of this directory: release-chain reconciliation and release-blocker closure only. **Shared-dev rollout is NOT authorized.** Nothing here applies a migration, takes a rollout backup, stops or replaces a service, builds or deploys an image, backfills or resolves a Dataset, or pushes `main`.

## Agreed sequence
M24/M25 promotion → disposable 25-chain proof → T007 → T008 exception acceptance → T018 → historical and in-flight data policy → final rollout authorization → build → backup/drain/apply → cutover → G5 acceptance.

| Step | Status | Document |
| --- | --- | --- |
| Promote frozen M24 and M25 into `prisma/migrations` (byte-for-byte; active chain = 25) | **DONE** in the release-chain commit | `release-chain-proof.md` |
| Disposable 23 → 24 → 25 proof | **PASS** (`focused-runs/20261005T160813Z-2c4c4b77`) | `release-chain-proof.md` |
| T007 final SQL review (SHA-256 `13f0e977…`) | **APPROVED 2026-10-05** (exact bytes; opaque resolver subject accepted; performance regression accepted as a known capacity risk, not a PASS) | `t007-m24-sql-review.md` |
| T008 provenance exception RPE-029-M24 | **ACCEPTED 2026-10-05** (missing provenance accepted, not reconstructed; reconstruction is supporting evidence only) | `t008-provenance-exception.md` |
| T018 writer audit | **CLOSED 2026-10-05; no unresolved writer** | `../writer-inventory.md` (+ pinned by two offline tests) |
| Historical Dataset plan (67 single-modality; EMPTY and MIXED separate; 3 disagreements) | **decisions D-1…D-8 recorded 2026-10-06; G-DATA still open** | `historical-data-release-plan.md`, `decisions-20261006.md` |
| T029/T031 backfill tooling | **BUILT and disposable-verified (not run on shared dev)**; launcher/storage adapter not built | `t029-t031-backfill.md`, `t031-fence-semantics.md` |
| In-flight work disposition (19 import Jobs, 11 PREPARING imports, 8 stale AI Jobs) | **F-1/F-3 deferred; F-2 comparison done; Redis reconciled; nothing mutated** | `in-flight-work-plan.md` |
| Final rollout authorization, build, backup, drain, apply, cutover, G5 | **not started, not authorized** | — |

## Frozen identities
| Item | Value |
| --- | --- |
| M24 `20260930030000_dataset_modality_g2` | SHA-256 `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7`, 7,526 bytes |
| M25 `20261006000000_prepared_import_creation_request_hash` | SHA-256 `a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859`, 68 bytes |
| Active chain tree (25 migrations + lock file, 26 files) | `f0da8710b3c874f842de6b686ae5b025dffd59f8acdab74a6e1c00faadb54ca8` (previous 23-migration tree `8514e919…e6fb`) |
| `prisma/schema.prisma` | SHA-256 `4fe3d96a334e18e504ea14fd5519a1a363fae5ea6d9845355c9d548698eed174` (unchanged) |
| Generated client (44 files) | tree `a750e6b900e00991e818b660f7af67866d1c8ea2ec7774ff2f92f0b40fb54a52` (unchanged) |

## Side effects of the promotion that were checked (read-only)
- **No automatic path applies the chain to the shared dev database.** `docker-compose.yaml` has no migrate service; the web and worker Dockerfiles run no migration; `pnpm db:migrate` is `scripts/db-safety/cli.mjs deploy`, which only accepts a verified disposable receipt whose PostgreSQL system identifier is not the application's. A rebuild or `docker compose up` of the dev stack therefore cannot apply M24/M25.
- `docker-compose.review.yaml` has a one-off `migrate` container that would apply all 25 migrations to the **review** stack's own fresh database, and its `seed` step runs `prisma/review.seed.ts`, which creates a Dataset without a modality and would fail closed after migration 24 (T018, class I). The review stack is out of scope here and was not run.
- Recovery tooling for the 22/23-migration incident (`scripts/phase029-recovery/*`) is unchanged and will refuse the 25-migration chain by design.

## Backup policy (recorded position, decision deferred)
The rollout plan's default of combining physical base backups with a logical dump is **not** adopted. The working position is a logical `pg_dump -Fc` with checksum, `pg_restore --list`, and an actual restore into a scratch PostgreSQL with fingerprint comparison; a physical base backup adds WAL, tablespace and configuration checks that must each prove recoverability. The backup policy is chosen only after the blockers above are resolved.

## Post-cutover test data (recorded position)
Creating application test data after cutover is **not** authorized now. It needs: a self-contained release chain (done), T007/T008/T018 resolved, and a clear historical-data policy first.

## Still open before any shared-dev rollout
1. ~~T007 approval and T008 exception acceptance~~ — granted 2026-10-05; production capacity acceptance remains open.
2. A receipt-bound shared-dev launcher and storage adapter for T029/T031 (the tooling itself is built); the T030 Cohort-C remediation proposal (D-8, no deletion by default); Cohort B/D policy.
3. In-flight decisions F-1 … F-5.
4. Backup policy; rollout window; permission to build release images; permission to run the read-only pre-window checks (fresh inventory, Redis queue).
5. G5 (browser/runtime end-to-end) is still OPEN/UNVERIFIED.
6. `scripts/db-safety/tests/runtime-browser-control.test.mjs` "the real rehearsal and isolation are untouched and the diagnostic scope is exact" fails at `1804e9a` and at this commit: it asserts diagnostic-control wiring in `runtime-suite.mjs` and `g3-rehearse.py` that was never committed. Not introduced by the promotion; unresolved.
