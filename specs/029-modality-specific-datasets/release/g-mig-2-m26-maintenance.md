# G-MIG-2 — M26-aware maintenance launcher and rehearsal plans

Scope: make the receipt-bound maintenance launcher (T029 observe / T031 apply and the guarded migration steps) work on the **26-migration** chain, and prove it
on disposable PostgreSQL + MinIO and on an isolated copy of the shared-dev data. Nothing here authorizes a shared-dev migration or backfill.

## Why the two plans were stale

- `release:phase029-backfill` compared a 25-migration database with the current (M26) Prisma schema, so its schema-compat step could only fail.
- `release:phase029-backfill-maintenance` used a rehearsal harness written for the v1 launcher request (`postgres.url`, `expectedDatabase`) while the launcher on `main`
  already validates the v2 request (`host`, `port`, `database`, `user`): every request was refused with `REQUEST_POSTGRES_INVALID`. The v2 harness
  (`createMaintenance`) existed only on `a2/s0-storage-authority` and is ported here.

## What changed

| Area | Change |
| --- | --- |
| `backfill-binding.mjs` | `FROZEN_M26` (name, checksum, 1842 → 1942 entries, exactly 100 additions pinned by digest, new table `MediaVerification`); `migrate-m26` operation; `profileFor` (observe/apply accept a 25- or 26-row history, nothing else); `assertM26Delta`; table check allows only the empty new table; `copy` target kind (`copyPins`, no authorization artifact); authorization for the 26 chain carries `m26`. |
| `backfill-launcher.mjs` | `verifyCopyTarget` (running pinned container, compose project `devcopy`, every mount a `devcopy_*` volume, loopback bindings only, container control file reports the expected system identifier); M26 step verification (datasets must be left exactly as they were). `SHARED_DEV_ENABLED` is still `false`. |
| `backfill-maintenance-rehearsal.mjs` | v2 harness with a `chainLength` (25 or 26) parameter; M24, M25 and M26 each applied through the launcher's guarded migration step. |
| `disposable-test.mjs` | `release:phase029-backfill-maintenance` and `release:phase029-backfill` now run `through: 3` (26 migrations); topology updated; the maintenance plan asserts the M26 delta with `assertRelease26`. |
| Tests | `backfill-launcher-m26.test.mjs` (16 tests: constants vs the real migration, profiles, history, exact delta incl. 7 negative cases, tables, request validation, copy-target rules, end-to-end launcher runs incl. 5 failure cases, source contract); runner pin tests updated (80/80). |

## Evidence

- Live, disposable PostgreSQL + MinIO: both plans PASS on the 26-migration chain (M26 delta 100 added / 0 removed / 0 changed; 15 launcher refusals; apply stops on three storage faults and completes idempotently).
- db-safety suite 449/450; the one failure is the known G5 diagnostic.

## Procedure for a real dev database (not executed)

1. Verified backup (`pg_dump -Fc`, checksum) and a restore-and-count rehearsal on a copy.
2. `migrate-m24`, `migrate-m25`, `migrate-m26` through the launcher (each its own request, receipt and evidence).
3. `observe` → offline approval of the exact dataset ids → `apply`; a second `apply` must replay.
4. For the real shared-dev system only: the reviewed `SHARED_DEV_ENABLED` change plus a per-run authorization artifact (`phase029-backfill-authorization/v2`).
