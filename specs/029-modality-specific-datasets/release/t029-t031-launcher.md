# T029/T031 maintenance launcher and real-storage disposable proof

**Status: BUILT and disposable-verified against real PostgreSQL and real MinIO. Shared-dev execution is NOT enabled (`SHARED_DEV_ENABLED = false` in the launcher) and nothing was run against shared dev.** This is the execution path T029/T031 will use; running it on shared dev needs the later operational gates (see "To run it on shared dev").

## Architecture
```
 request.json (private, 0600)        approved-manifest.json (release owner, separate artifact)
        │                                         │
 backfill-launcher.mjs  ── verifies everything, fails closed ──►  evidence dir: binding.json (sealed first)
        │  (psql read-only probe: identity, history, schema manifest, Dataset counts)
        │  (child "identity" probe → the SAME storage adapter reports endpoint, bucket, bucketExists, config fingerprint)
        ▼
 fenced child:  node --require register-server-only --require maintenance-fence.cjs --import tsx apps/web/scripts/backfill-run.ts
        │            observe → buildBackfillManifest (T029)     apply → applyApprovedBackfill (T031)
        │            storage = modality-backfill-storage.ts (createMinioStatObject: stat only)
        ▼
 evidence dir: observed-manifest.json | result.json, receipt.json   (all created exclusively, mode 0400, secret-free)
```
- **One implementation per concern:** the launcher spawns the same child for the storage identity probe and for the operation; the rehearsal drives the launcher, not a copy of it. T029/T031 logic is unchanged apart from the approved-ID layer.
- **The fence** (`maintenance-fence.cjs`) lets the child open sockets only to the two bound `host:port` pairs (database, storage), refuses listening sockets, and pins the Prisma datasource to the launcher's verified URL (same technique as the G1 fence). Native drivers are not a sandbox; the launcher's identity checks come first.
- **Operations:** exactly `observe` (T029, read-only) and `apply` (T031). `observe` takes no approval input at all.

## Target binding and fail-closed rules (all enforced before any application data or object is read or written; each has a test)
| Bound item | Rule and refusal code |
| --- | --- |
| Ambient targets | any inherited `DATABASE_URL*`, `PG*`, `REDIS_*`, `MINIO_*`, `S3_*`, `AWS_*`, `STORAGE_*`, `BACKFILL_*`, `DB_SAFETY_*`, `G1_*`, `NODE_OPTIONS`, `NODE_PATH`, `BULLMQ_*` → `AMBIGUOUS_TARGET_ENVIRONMENT`. The only authority is the request. No `.env` is read. |
| Request | private file; strict schema (unknown key refused); operation equals argv; issued ≤ now < expires, lifetime ≤ 30 min; run token `^[a-z0-9][a-z0-9-]{6,62}[a-z0-9]$` (the receipt subject is `system:phase029-backfill:<run-token>`) |
| Implementation | the request pins the SHA-256 of 13 files (T029/T031 evidence and application code, the storage adapter, the child runner, the launcher, the binding module, the fence, the domain retry helper source and its built output, the schema, the manifest definition, M24 and M25) plus the generated-client tree and the migration-chain tree; any difference or extra/missing file → `IMPLEMENTATION_HASH_MISMATCH` / `…FILE_SET_MISMATCH` / `GENERATED_CLIENT_MISMATCH` / `MIGRATION_CHAIN_MISMATCH`. Checked at binding time, again immediately before the child starts, and again after it exits (a change during the run seals no receipt). |
| PostgreSQL | exact system identifier and database name (`SYSTEM_IDENTITY_MISMATCH`); history of exactly 25 finished, not-rolled-back records equal to the pinned list, with the frozen M24 `13f0e977…` and M25 `a8ffbc84…` last (`HISTORY_*`, `FROZEN_MIGRATION_MISMATCH`); schema manifest (reviewed read-only CTE, bytes pinned) with 1,842 entries and the pinned digest, i.e. no drift (`SCHEMA_*`); Dataset counts are observed and recorded. The probe is `psql` in a read-only transaction. |
| Target kind | `disposable`: loopback `127.0.0.1:554xx`, user `postgres`, G1 container pins verified (id, labels, loopback binding, system identifier ≠ the application's), storage must be the pinned MinIO container and a `g1-…` bucket. `shared-dev`: refused while disabled (`SHARED_DEV_EXECUTION_NOT_ENABLED`); when enabled it additionally needs the application system identifier and an exact, unexpired authorization file bound to the operation, run token, storage endpoint, bucket and approved-manifest hash (`AUTHORIZATION_*`). |
| Storage | endpoint equals the expected endpoint and bucket equals the expected bucket (`STORAGE_TARGET_MISMATCH`); the endpoint answers (`STORAGE_UNAVAILABLE`) and the bucket exists (`STORAGE_IDENTITY_MISMATCH`); the receipt records host, port, TLS flag, bucket and a fingerprint of the non-secret configuration plus a hash of the access-key id — never a credential. |
| Approval inputs (`apply`) | observed and approved manifests are private files whose bytes equal the pinned SHA-256 (`MANIFEST_FILE_HASH_MISMATCH`); the approved manifest names this observed manifest (`APPROVED_OBSERVED_MISMATCH`); the observed manifest's bucket equals the run's bucket (`MANIFEST_BUCKET_MISMATCH`); the child re-verifies both manifests fully. |
| Evidence | a new or empty directory below `verification/maintenance-runs/` or `.data/maintenance-runs/`, real directory, private; identity (realpath, device, inode) recorded; `binding.json` is sealed before the child starts; files are created with `wx` and mode 0400; any secret value in a written file or in the child's output aborts the run, removes what the run wrote and seals no receipt. |

## Manifest lifecycle — three distinct artifacts
1. **Observed candidate manifest (T029 output)** — what the tool saw: per Dataset id, modality, fence revision, Asset-evidence digest, observed object size/ETag; plus every rejection with a code. Sealed with `manifestSha256`. It proves nothing about permission.
2. **Approved-ID manifest (release owner)** — a separate, explicit list of Dataset ids derived offline from (1) by `apps/web/scripts/backfill-approve.ts`: it names the observed manifest's hash, the approver, the time and a statement, and is sealed with its own hash. Every approved id must be an observed candidate (a Dataset the tool did not find eligible cannot be approved); empty lists, duplicates, unsorted ids and tampering are refused.
3. **Execution receipt (T031 output)** — `binding.json` (what the run was bound to), `result.json` (per-Dataset outcomes in manifest order, deterministic accounting) and `receipt.json`, which binds the request hash, the observed manifest hash, the approved manifest hash and ids digest, and the hash of the exact executed manifest (the approved subset of the observed candidates, with their observed evidence unchanged).
T031 executes only the approved ids; a Dataset that appears in (1) but not in (2) is never mutated. Both input files are pinned by hash in the request and bound into the receipt.

## TOCTOU and storage-consistency semantics
Object-store metadata is **not** transactionally locked with PostgreSQL, and a stat is only a statement about one instant. T031 therefore: (1) re-reads the Dataset's Asset evidence and **re-stats every object immediately before opening the assignment transaction**, comparing the result with what the manifest approved (existence, size, and the recorded ETag where one is recorded); a changed, missing or unreachable object stops the run before any write for that Dataset (`SIZE_MISMATCH`, `ETAG_MISMATCH`, `OBJECT_MISSING`, `OBJECT_CHECK_FAILED`, `ASSET_EVIDENCE_CHANGED`); (2) inside the Serializable transaction repeats the fence compare-and-swap and the Asset-evidence digest comparison against PostgreSQL. What the protocol cannot detect is an object that changes after the last stat and before the commit (a window of milliseconds); it is closed operationally by running with every application writer stopped for the maintenance window. The rehearsal below shows the storage check is what stops a changed object: PostgreSQL evidence alone cannot see it.

## Real-MinIO rehearsal (plan `release:phase029-backfill-maintenance`, fresh PostgreSQL + Redis + MinIO containers, receipt-bound, canonical 25-migration chain)
The seed uploads real objects, then creates 19 historical-style unresolved Datasets on the 23-migration baseline. Everything below goes through the committed launcher, child and adapter; no in-memory stand-in is used.
| Required case | Result |
| --- | --- |
| object exists and size matches | candidates `mn-a-image` (2 objects), `-b-video`, `-c-audio`, `-d-text`, … observed with their real size/ETag |
| no recorded ETag remains eligible | the four above and `mn-m`, `mn-o`, `mn-q`, `mn-y` have no recorded ETag and are candidates |
| ETag recorded and matching | `mn-e-etag-match`, `mn-n-mutate-etag` (real recorded ETag) are candidates |
| ETag recorded and mismatching | `mn-t-etag-mismatch` rejected `ETAG_MISMATCH` |
| object missing | `mn-r-missing` rejected `OBJECT_MISSING` |
| size mismatch | `mn-s-size-mismatch` rejected `SIZE_MISMATCH` |
| wrong bucket / foreign identity | `mn-u-bucket-foreign` rejected `BUCKET_NOT_APPROVED` with no storage read; launcher refusals for a different expected endpoint (`STORAGE_TARGET_MISMATCH`), a different existing bucket (`MANIFEST_BUCKET_MISMATCH`) |
| storage unavailable | endpoint changed to a closed loopback port → real connection refusal → `STORAGE_UNAVAILABLE`, no evidence |
| metadata changes between approval and execution | after approval the runner changes storage: `mn-m` gets a different size, `mn-n` the same size with different bytes (new ETag), `mn-o` is deleted. Execution stops at each in turn with `SIZE_MISMATCH`, `ETAG_MISMATCH`, `OBJECT_MISSING`; after each repair the same token resumes: `COMMITTED_REPLAY` for earlier Datasets, then the next |
| approved-only mutation | the 11th candidate `mn-p-unapproved` is never approved and stays unresolved with an unchanged row; 10 approved Datasets end resolved with `system:phase029-backfill:<token>`, fence 1, legacy `primaryModality` untouched |
| accounting | four apply runs: `5 committed + 1 stopped + 4 not attempted`, `5 replayed + 1 committed + 1 stopped + 3 not attempted`, `6 replayed + 1 committed + 1 stopped + 2 not attempted`, `7 replayed + 3 committed` (COMPLETED); exit codes 3, 3, 3, 0 |
| refusals (12) | ambient database URL, ambient storage variable, wrong system identifier, tampered implementation hash, tampered history checksum, schema drift, storage unavailable, storage endpoint mismatch, bucket mismatch, tampered approved-manifest bytes, non-empty evidence directory, shared-dev kind — each fails closed with its code, seals no `binding.json` and changes nothing |
| T029 select-only | a DB check before and after `observe` (and after the refusals) shows no Dataset, Asset, Job, import or label row changed |
| immutability | after the run the database rejects a modality change and a subject change |
| evidence | every sealed file is mode 0400 and contains neither the database password nor the storage access key |

**Sensitivity:** with T031's pre-transaction storage revalidation deliberately removed, the first apply run committed all ten approved Datasets — including those whose object size changed, whose ETag changed and whose object was deleted — and the rehearsal failed (`focused-runs/20261006T072901Z-9de3b0e2`). A first attempt (`…T072805Z-d9b7423d`) failed earlier for an unrelated reason (a protected file was edited during the run) and proves nothing. The source was restored byte-for-byte before the final runs.

## Verification runs (final source)
| Plan | Run | Result |
| --- | --- | --- |
| `release:phase029-backfill-maintenance` (real PostgreSQL + MinIO + Redis) | `focused-runs/20261006T073242Z-6f397fd5` (earlier identical pass `…T072440Z-6d1184a9`) | PASS: history 25 with the frozen M24/M25 checksums, schema entries 1829 → 1841 → 1842 → 1842, `g2:compatibility` no drift, 17 receipts, primary and independent cleanup |
| `release:phase029-backfill` (T029/T031 library rehearsal, 14 cases) | `…T073543Z-e4a43615` | PASS |
| `release:phase029-chain` | `…T073654Z-5163d43d` | PASS |
Offline: launcher/binding tests 58, storage adapter and approval-lifecycle unit tests (16 with the evidence rules), runner plan tests 73 — all passing. The whole `scripts/db-safety` suite is **275 of 276**: the one failure, `runtime-browser-control … the real rehearsal and isolation are untouched and the diagnostic scope is exact`, is the same failure that exists at earlier commits and is unrelated to this work.

## Implementation hashes (SHA-256, the bytes rehearsed)
| File | SHA-256 |
| --- | --- |
| `apps/web/src/lib/datasets/modality-backfill-evidence.ts` | `57ec3a9920fccbd8fed364f59efdf47148cf9fa023b257a564d2bf5cad880d0f` |
| `apps/web/src/lib/datasets/modality-backfill.ts` | `9aee54e647000f9bfaff06fc6942cedcc3d878efe9d4a21559bfa2b54fd715e3` |
| `apps/web/src/lib/datasets/modality-backfill-storage.ts` | `3ff84547b3ec0a85bbc017e857fc164c59cf9c343f211538bfaee4430fff1e6f` |
| `apps/web/scripts/backfill-run.ts` | `0ca9d7e7f8493303615111eb4a5aab0dafaec2bdb872b703467c0158d37e3699` |
| `apps/web/scripts/backfill-approve.ts` | `8a7ee03ecb433a5f819769bda87c8b8c8dfec544e2e244092ecae4770d50c3d3` |
| `scripts/db-safety/backfill-launcher.mjs` | `8fe0bf0212d4dc19e6afea7a4be9a1941c344af2469333f28419b4dd41c0c051` |
| `scripts/db-safety/backfill-binding.mjs` | `416634550e36c033d99b6decc3e0f6496724e457cfb0ecdafaf085cfcebc8868` |
| `scripts/db-safety/maintenance-fence.cjs` | `7c263376c707b053fedcd58b8645598892541d4772efcec9cb795058d1a368ee` |
| `scripts/db-safety/backfill-maintenance-rehearsal.mjs` | `eb84df98c144508a9c74c5afbe1999ceb23b43facfcc69c46a9a0034f45503bc` |
| `scripts/db-safety/disposable-test.mjs` | `481d25b91dab74691b4b4fc799935c59ab234c0aac9e805f31433c54b58c09ee` |
| `scripts/db-safety/commands.json` | `05c2365357deb98b799421231a1c7420529e064a475017d6660f10349c41d1aa` |
| `apps/web/tests/dataset-modality/maintenance-baseline.test.ts` | `68286d429be375d17c5ff753a374af622f43fc9c1aebf57457aae4d8964a2ff8` |
| `apps/web/tests/dataset-modality/maintenance-objects.test.ts` | `5521aac68dceb90a224d0b1a54346d89fe6c631fc45522f3cee02e8f944066de` |
| `apps/web/tests/dataset-modality/maintenance-check.test.ts` | `0904ec115ade6da7c9412e9ed60e77094fe2c2fb6a2b574bf030fb7b661cdba9` |
| `apps/web/tests/dataset-modality/maintenance-fixture.ts` | `499af5522f8cb09c51409e73bcd8a633bb6c42321bf0ba767641d647e851baec` |
| `apps/web/src/lib/datasets/modality-backfill-evidence.test.ts` | `4720a414c27ce6d825318d7f5985ad28c0318155768ae37b38faaf9194a13109` |
| `apps/web/src/lib/datasets/modality-backfill-storage.test.ts` | `318e4acf4e0f7345d5bf61ee7a41fb6c0f558ddb6c4270ba2db454daa4e16c5b` |
| `scripts/db-safety/tests/backfill-launcher.test.mjs` | `85cf11df9d41023b3efd6caa3e3bd84333c09567b1b14d3f8c0340cd31476ee0` |
| `packages/domain/dist/dataset-modality.js` | `a78353a3bd84f8c6cd71ec323da099ba3cfc631956a952d7dc4c1bedd23f2c6b` |
| `packages/domain/src/dataset-modality.ts` | `8eb878c14cffb625441fcca882e7f8efcf7ac484a0d5f4d25921403a44369bc6` |
Unchanged: M24 `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7`, M25 `a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859`, `prisma/schema.prisma` `4fe3d96a…`, generated client tree `a750e6b9…`, migration-chain tree `f0da8710…`. No schema, migration or client change; no new package; no raw SQL in application code (the launcher's read-only observation uses `psql`, like the existing G1 probe).

## Cohort A and the TEXT Dataset
Eligibility is unchanged: fresh read-only database evidence (2026-10-06T07:38Z) again gives **28** candidates (the same 24 IMAGE and 4 VIDEO Datasets) before object-stat verification. The TEXT Dataset `cmrono652000d10va60fr6prt` stays excluded by the general rules (`SIZE_UNRECORDED`, bucket `test` ≠ the configured bucket); nothing special-cases it and no rule was weakened to recover 29. The final membership is whatever the window-time T029 run (real object metadata) observes.

## F-2 evidence
The five-job read-only findings (four local-folder imports fully published and linked; one empty repository import) are recorded in `in-flight-work-plan.md`. No job, import, queue entry or Asset was terminalized, retried, cancelled, resumed or changed.

## To run it on shared dev (not authorized, not enabled)
1. Review and hash-bind a source change that sets `SHARED_DEV_ENABLED = true`, or approve a separate shared-dev build of the launcher.
2. Window-time sequence: fresh read-only inventory (database and Redis) → backup policy and backup → drain (web, worker, temporary web stopped) → M24/M25 → `observe` (real storage metadata) → release owner derives the approved-ID manifest → authorization file for the exact run → `apply` → runtime cutover/postflight.
3. A storage credential path for the real MinIO and a decision on where the request/credentials file lives (private, short-lived).
4. Production capacity acceptance, G5, backup policy and the in-flight dispositions remain open.
