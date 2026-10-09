# Phase 029 shared-dev maintenance window — final go/no-go package

**Verdict: EXECUTION-READY PREPARATION COMPLETE (GN-2/GN-3 done, see §16). This document does not authorize execution; the maintenance window itself needs its own authorization naming the operator and the duration.** Nothing in this checkpoint stopped a service, migrated, built or deployed an image, took a rollout backup, or wrote to PostgreSQL, Redis, MinIO or any application data. The only shared-dev contact was the strictly read-only inventory procedure of the frozen execution package (one preflight run, no baseline written). T009, T036, T037, T038, T022, T027, T028, T030 and T032 stay OPEN; T025/T026 stay partial; T033 is *proposed satisfied by M24* (separate map); G3/G5 are untouched; A2/M26 has not started.

Written for: the release owner deciding whether to open the window.

Basis: the execution package `shared-dev-execution-package.md` (corrected in §1 by this checkpoint: its earlier claim that the release application tree equals `19a0341` was stale). Superseding rule: **only the hashes in §3 count**; earlier reports are not cumulative authority.

## 0. Go/no-go summary

| # | Condition | Status |
| --- | --- | --- |
| 1 | Exact release commit exists and is authorized | **NOT YET** — candidate tree computed (§2); creating the commit needs the owner's authorization (GN-2) and a basis decision (GN-1) |
| 2 | Execution package frozen and hashed | **YES** (§3), subject to the release commit being created from exactly those blobs |
| 3 | M24/M25 bytes frozen | **YES** (§4) |
| 4 | Migration-chain/client/implementation identities pinned and reproducible in a pristine worktree | **YES** (§4); one build prerequisite found (dist, §4.2) |
| 5 | Per-run authorizations | **PROCESS READY**; none can be valid before the window (§5) |
| 6 | Backup/restore | **TOOL PROVEN on a throwaway PostgreSQL only**; the real shared-dev backup is a window step (§6) |
| 7 | Recovery tags and release images | **NOT CREATED / NOT BUILT** by design (§7); the real old worker image was run through the verifier and is correctly refused |
| 8 | Fresh hard-stop inventory | **PROCEDURE READY**; today's read-only preflight shows no stop condition, but **no baseline exists** and the web image changed since the last one (§8) |
| 9 | Stop/restart authority, credentials, window owners | **OWNER INPUT REQUIRED** (§10–§12) |
| 10 | Exclusions held (T030, T032, A2/M26, EMPTY resolution, Cohort C, unrelated mutations) | **YES** (§13) |

**Owner decisions needed before a GO:** GN-1 release basis; GN-2 authorization to create the release commit; GN-3 authority to build and tag images; GN-4 service-stop authority and window owners; GN-5 private credentials supplied at window time; GN-6 acceptance of a fresh baseline; GN-7 window length and abort authority. Details in §14.

## 1. What the execution package must and must not contain (and the release-basis finding)

**Finding (resolved in the package text):** the package had stated that the image-build commit's application tree equals `19a0341`. That is no longer true of `main`, and it was never true of the A2 branch.
- `main` = `96379b1f8ebb8daf5510c7eb83d6c90b7b1437c6`. Versus the verified launcher baseline `19a0341` it differs **only** in the completed-dataset visualization viewer (9 files: `apps/web/src/components/visualization/{asset-table,data-tab,dataset-header,dataset-summary,derived-status,read-state,visualization-shell}.tsx`, removal of `unavailable-panel.tsx`, `apps/web/tests/visualization/viewer.vitest.spec.ts`). `prisma/schema.prisma`, `prisma/migrations`, `lib/generated/prisma`, `packages/queue/src/job-contract.ts`, `packages/domain/src/dataset-modality.ts`, `apps/web/src/lib/datasets/modality.ts`, `apps/web/src/app/api/datasets/route.ts` and both Dockerfiles are byte-identical to `19a0341`.
- The A2 branch commit `a5aa248` (current `HEAD`, branch `a2/s0-storage-authority`) additionally changes the **worker and web application code** (A2/S0: verify-only `ensureBucket`, sealed-namespace routing in readiness and bulk delete, the classification refactor, the truncated-PNG upload fix). **It must never be the release source.**
- The working tree adds uncommitted documentation and tests (T003 edits, feasibility reports, T033 map, S0 receipts, new tests). None of that can reach an image because images are built only from `git archive <R>` into a clean directory, and `.dockerignore` excludes `specs/`, `docs/`, `.data/`, `.git/` and `.env*`; the image verifier then byte-compares key files with `git show <R>:<path>`.

## 2. Exact release commit (proposal — not yet created)

| Item | Value |
| --- | --- |
| Parent | `main` @ `96379b1f8ebb8daf5510c7eb83d6c90b7b1437c6` (or `19a0341…` if GN-1 chooses to exclude the visualization delta; the tree below would then be recomputed) |
| Content | parent tree + exactly the nine package files of §3 (no `apps/`, `packages/`, `prisma/` change) |
| Candidate tree | `b342b5d02e35666bb84a72749d52dde0ffbe8100` (computed with a temporary index; the tree object exists but no commit or ref was created) |
| Alternative tree if GN-1 chooses the verified baseline | `715638966323d91fd29a709d6ed8e8e0f416a230` = `19a0341` + the same nine files (parent `19a03414e81e529c82becff9433a98d1fc94930d`) |
| How to create it (after authorization GN-2) | `git commit-tree b342b5d02e35666bb84a72749d52dde0ffbe8100 -p 96379b1f8ebb8daf5510c7eb83d6c90b7b1437c6 -m "release(029): shared-dev maintenance execution package"` then `git branch release/phase029-rollout <printed-commit>`; verify `git rev-parse <R>^{tree}` equals the tree above and `git diff main <R> --stat` lists exactly the nine files |
| Verified in a pristine worktree of this candidate | `backfill-launcher.test.mjs` + `maintenance-tools.test.mjs`: **173/173 pass**; implementation digest `c131765eed96c2b19d497328e235f76ef0c9b7270cc3fec88f6e5ad0be44909a` (identical to the current tree's) after the domain dist build (§4.2) |
| Relationship to uncommitted work | the release worktree is a separate checkout of R (`git worktree add <dir> release/phase029-rollout`); the A2 working tree and its uncommitted files are never the build or execution source; `git status --porcelain` in the release worktree must be empty (plus, at most, the enable patch) |

## 3. Execution-package identities (sha256 / git blob)

| File | sha256 | blob |
| --- | --- | --- |
| `scripts/db-safety/backfill-binding.mjs` | `c68390816488dbdad8df74596f5f2396a3ec70b1a4adbd09b83f37571072b863` | `cc66bfd3ade0` |
| `scripts/db-safety/backfill-launcher.mjs` (`SHARED_DEV_ENABLED = false`) | `d233b1a18c3f64357ebf0999bdfbf8b05834655ece56bdaa821ab25733a5f5d5` | `47e127956a7f` |
| `scripts/db-safety/backfill-window-inventory.mjs` | `a09c736e3c55176064d9055fd72393619e0b69cbc36c7a2784419a5a22bc229f` | `6f98d19dd542` |
| `scripts/db-safety/backup-proof.mjs` | `b6c7e7bf77486d6588aa5d15a05e921051d06c98f1941d5336154ac053a5ff25` | `5d99f0d5955e` |
| `scripts/db-safety/release-image-verify.mjs` | `842e6ff7bd6c8bcd61ce08f4acb80ab17d1d8938f7d7470302d5267cbf1962a6` | `6e533e931425` |
| `scripts/db-safety/tests/backfill-launcher.test.mjs` | `43c0666b5590e3251b1790191b9134342776f9b67ad3c56444b40d6982a1d441` | `cd81d04a9f0f` |
| `scripts/db-safety/tests/maintenance-tools.test.mjs` | `d3a23ceec7503e7d9929b66dbca1809f5fe1f48b7a5ea703252deacf19b91a14` | `7bab1c710d92` |
| `specs/029-modality-specific-datasets/release/launcher-enable-shared-dev.patch` | `9f648aaccd21c2b7173c80990e9979ea5eeca43959b7d06fe2abeae39798c719` | `4b93b4703097` |
| `specs/029-modality-specific-datasets/release/shared-dev-execution-package.md` | `35e4d82d4b3b1ed3a4a2d913bf4f443167b9aa1cf85b801870dc5a96f2c43485` | `cf307e1b3f3c` |
**Package manifest hash** (sha256 of the nine `sha256␠␠path` lines in the order above): `e5267db431b6e1b9dd2fb3365bff389a98a38a871c62d750167c04251804f28a`. Any later edit to a listed file invalidates this go/no-go.
Other files the launcher pins and that are unchanged from `main`: `maintenance-fence.cjs` `7c263376…`, `prisma-client-stage.mjs` `50d2a5bf…`, `apps/web/scripts/backfill-run.ts` `0ca9d7e7…`, `apps/web/scripts/backfill-approve.ts` `8a7ee03e…`, `modality-backfill.ts` `9aee54e6…`, `modality-backfill-evidence.ts` `57ec3a99…`, `modality-backfill-storage.ts` `3ff84547…`, `packages/domain/src/dataset-modality.ts` `8eb878c1…`, `prisma/schema.prisma` `4fe3d96a…`, `recovery.v2.review.sql` `3bb6389f…`.

## 4. Migration and implementation identities

### 4.1 Frozen bytes
| Migration | sha256 |
| --- | --- |
| M24 `20260930030000_dataset_modality_g2` | `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7` |
| M25 `20261006000000_prepared_import_creation_request_hash` | `a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859` |
Migration tree (25 migrations) `f0da8710b3c874f842de6b686ae5b025dffd59f8acdab74a6e1c00faadb54ca8`; generated-client tree `a750e6b900e00991e818b660f7af67866d1c8ea2ec7774ff2f92f0b40fb54a52`; implementation digest (13 files + both trees) `c131765eed96c2b19d497328e235f76ef0c9b7270cc3fec88f6e5ad0be44909a`. All identical on `19a0341`, `main`, `a5aa248` and the candidate tree; the disposable proofs (`release:phase029-chain` `20261006T084001Z-6fc0de09`, backfill `…T084130Z-075481a1`, maintenance `…T084244Z-7a8b369d`) ran on exactly these.

### 4.2 Build prerequisite found in this checkpoint
`packages/domain/dist/dataset-modality.js` (pinned `a78353a3bd84f8c6cd71ec323da099ba3cfc631956a952d7dc4c1bedd23f2c6b`) is a **git-ignored build output**. A pristine checkout lacks it, so the launcher cannot compute its implementation hash (one offline test also fails) until `pnpm --filter @annotationplatform/domain build` has run in the release worktree. Verified: that build is deterministic — it reproduced the pinned hash byte-for-byte in a pristine worktree. Added to the package (§1 / step 0). The operator step is: release worktree → `pnpm install --frozen-lockfile` (no new packages) → domain build → compare hash → proceed.

## 5. Per-run authorization artifacts (`phase029-backfill-authorization/v2`)
Each is bound to one operation and one run token, expires within 4 h, is private (0600) and contains no secret. **None can validly exist before the window** (token, expiry, observed fingerprints). What can be prepared earlier: the request templates, the credentials-file format, the authorizing person/statement text.

| Artifact | Operation | Earliest generation | Depends on |
| --- | --- | --- | --- |
| A1 | `migrate-m24` | after drained inventory and verified backup (steps 4–6) | system id, 23-row history digest, schema digest 1829, implementation digest, evidence dir |
| A2 | `migrate-m25` | after M24 verified (step 8) | history 24, schema 1841 |
| A3 | `observe` (T029) | after M25 verified (step 10) | history 25, schema 1842, storage endpoint/bucket/config fingerprint |
| A4 | `apply` (T031) | **only after** the window-time observed manifest has been reviewed and the release owner has produced and signed the approved-ID manifest | observed-manifest hash **and** approved-manifest hash |
No approved manifest exists or is pre-created. **The earlier 28-candidate count is not authority**; the window-time T029 run, with a real storage stat, alone determines candidates, and only the owner-approved IDs are applied.

## 6. Backup and restore (logical; no physical base backup)
- **Procedure** (package §5, `scripts/db-safety/backup-proof.mjs <request.json>`): source identity (container id + `pg_controldata` system id) → drained check → read-only observation → `pg_dump -Fc` (0400, SHA-256) → fresh no-network restore container from the source's own image → `pg_restore --list` → real restore → compare history, schema digest, every table's row count and fingerprint, sequences → source-unchanged re-check → negative controls (truncated dump rejected, tamper detected) → exact-id removal → sealed receipt.
- **Proof status:** the tool is tested offline (fake-docker, 63 tests across the maintenance tools) and was run **for real on a throwaway PostgreSQL container**: VERIFIED, both controls true, restore container removed. **No backup of the shared-dev database exists yet** — that is step 5 of the window.
- **Capacity:** `.data/backups` is on a filesystem with 35 GB free (84 % used). The shared-dev database size has not been measured in this checkpoint; measure it at window start and abort the window if the free space is below 3× the database size.
- Restore of production-shaped data into the fresh container is part of the proof receipt; M24 must not start without `status: VERIFIED`.

## 7. Recovery images, release images, build and verification
| Image | Current identity | Status |
| --- | --- | --- |
| web (running) | `annotationplatformdev-web:latest` = `7a802e3e23b2…` (`sha256:7a802e3e23b20b35eecbc5b39cb8bae075baf76c3e6a17900d18476b40c8a182`, built 2026-10-06 16:24 +07, container `annotationplatformdev-web-1` started 09:26 UTC) | **changed since the previous capture** (`f11c370eb37f`); recovery tag must name this id |
| web (older) | `stable-184ddd0` = `83fb8deb207c`; `rollback-pre-stable-20261005` = `bc882a150b0e` | kept untouched |
| worker | `annotationplatformdev-worker:latest` = `fbd81331234f…` (built 2026-09-29) | **pre-Phase-029**: lacks the modality schema/code; a rebuild is mandatory |
| realtime | `annotationplatformdev-realtime:latest` = `026b62ae608b` (2026-09-17) | unchanged by the rollout; no Prisma/modality code (verified) |
- **Recovery tags (not created):** before any build, `docker tag <running-web-id> annotationplatformdev-web:recovery-pre029-<date>`, `docker tag fbd81331234f annotationplatformdev-worker:recovery-pre029-<date>` (by **id**, never by the floating `:latest` name).
- **Release images (not built):** from `git archive <R>` into a clean directory, `docker build -f apps/{web,worker}/Dockerfile` with the revision/service labels of package §6, tags `release-029-<R>`; realtime is not rebuilt.
- **Verification tool status:** `release-image-verify.mjs` (labels, no migrate/seed startup, no credentialed env, byte-identity against `git show <R>`, client/migration trees, modality fields, no `.env`) was exercised against the **real old worker image** as a mechanics check: it correctly **refuses** it (no revision/service labels; schema, migrations, client tree, modality fields and several source files do not match) while the safe checks (no secrets in env, no `.env` files, no migrate/seed in startup) pass and its stopped, network-less container was removed. The positive path on a real *release* image is unproven until the images exist; running the verifier on both is a hard gate before start.

## 8. Fresh hard-stop inventory (HS-01…HS-10)
Procedure (package §7, `scripts/db-safety/backfill-window-inventory.mjs`; read-only: `docker inspect`, one READ ONLY REPEATABLE READ psql transaction, `redis-cli` reads; the output file is created exclusively): `<out> --write-baseline <baseline>` at window start → `--baseline … --mode preflight` before authorization → `--mode drained` after web/worker are stopped → `--expect-history 24|25 --skip-candidates` after M24/M25. **Exit 2 = STOP.** HS-01 system id/database; HS-02 history count/digest/rolled-back; HS-03 schema entries/digest; HS-04 non-terminal jobs; HS-05 PREPARING imports; HS-06 DB-only candidate set; HS-07 container id/image drift; HS-08 queue not empty or job keys present; HS-09 prepared transactions / ungranted locks / idle-in-transaction; HS-10 (drained) sessions, active queries, exclusive locks, web/worker still running.

**Read-only preflight taken for this report (no baseline written):** system identifier `7662655305624969250`, database `fieldframe`, PostgreSQL 16.14; **23** finished migrations (history digest `12a1c86c…`); schema manifest **1829** entries (digest `3d2d3a73…`); Datasets 120 (75 live, 120 unresolved), Assets 615, Annotations 231,770, Jobs 450; 27 non-terminal jobs and 11 PREPARING imports (policy unchanged: no stale-job mutation, F-1/F-3 deferred); sessions 29 client / 0 idle-in-transaction / 0 active; no prepared transactions, no ungranted or exclusive locks; Redis queue `annotation-platform:fieldframe-jobs` empty (wait/active/paused/delayed/prioritized/waiting-children all 0); containers `postgres 4db0342b0643`, `redis e5a8796b0067`, `minio 7fe3ca4b0d6e` (`minio/minio@sha256:a1ea29fa…`), `web 6668c925b234`, `worker 10f5435f48fb`, `realtime b8587dcd68f2`, all running. **A fresh baseline must be written at window start**; the web container/image differ from the previous candidate baseline, which would stop HS-07, so no earlier baseline is accepted.

## 9. PostgreSQL target and expectation
Target: container `annotationplatformdev-postgres-1`, published `127.0.0.1:5433`, system id `7662655305624969250`, database `fieldframe`, role per `printenv POSTGRES_USER` inside the container (not `postgres`). Expected history: **23 → 24 (M24, schema 1829 → 1841, +12 reviewed objects) → 25 (M25, → 1842, +1 column)**. Any other count, checksum or schema digest at any step stops the window.

## 10. Stop/restart authority and failure behavior
- **Stop authority (GN-4):** the owner names who may run `docker compose -p annotationplatformdev stop web worker` (stop, not kill, not remove; realtime untouched) and who may restart. The window may not begin without that named authority.
- **Failure behavior:** every failure leaves web and worker **stopped**, evidence preserved, and requires an explicit recorded recovery decision (package §9 matrix). Nothing restarts automatically, nothing reverses a migration, no `migrate resolve`/`db push`/manual DDL.

## 11. Recovery semantics after M24/M25: FIX-FORWARD
After M24 starts, the default is **fix forward with services stopped**; automatic or silent startup of the old images is not a recovery path. Reason, from the real objects: the worker image on the box predates Phase 029, and after M24 the guards reject Dataset inserts without a modality and Asset inserts into unresolved Datasets, so old writers would fail on creation paths. Restoring the verified dump into a **new** database for comparison, or a release-owner-authored repair plan, are explicit decisions, never defaults. Starting a previous image would be considered only after the owner accepts the specific incompatibilities in writing.

## 12. Private credential contract (no secrets recorded here)
One credentials file per run (`phase029-maintenance-credentials/v1`: `postgresPassword`, and for T029/T031 `storageAccessKey`/`storageSecretKey`), outside the repository, owner-only in an owner-only directory, typed by the operator at window time, hash-pinned by the request, ≤ 4 h old, never passed on a command line, never in a receipt, evidence or log (every evidence file is secret-scanned); no ambient `DATABASE_URL*`/`PG*`/`MINIO_*`/`S3_*`/`REDIS_*`/`NODE_OPTIONS`; no `.env` read. Removed at the end; rotation at the owner's discretion.

## 13. Explicit exclusions
Not in the window: T030 (Cohort-C remediation and deletion), T032 (MIXED), A2/M26 and every A2/S0 file or worker change, EMPTY owner/ADMIN resolution, historical remediation, job/import/queue mutation (F-1/F-3 deferred; no stale-job mutation), Cohort B automatic backfill, Cohort D, `primaryModality` as authority, T027/T028, the post-rollout web change set (response `modality` propagation, Dataset-authoritative AI target, stale-test repair), G3/G5 status, and any production capacity acceptance.

## 14. Remaining owner decisions before a GO
| ID | Decision |
| --- | --- |
| GN-1 | Release basis: `main` @ `96379b1` (includes the visualization viewer delta, untested in this package) **or** `19a0341` (the verified baseline). Recommendation: `19a0341`-based unless you want the viewer change in this window; either way the tree in §2 is recomputed from the chosen parent. |
| GN-2 | Authorize creating the release commit and branch (`commit-tree` recipe in §2). Nothing is committed or pushed by this checkpoint. |
| GN-3 | Authorize creating recovery tags and building the two release images (and running the verifier on both) before the window. |
| GN-4 | Name the stop/restart authority and the person who can abort. |
| GN-5 | Confirm credentials will be supplied privately by the operator at window time. |
| GN-6 | Accept that a fresh baseline is written at window start (previous baselines are void). |
| GN-7 | Window length, communication to users of shared dev, and the abort/hold criteria. |

## 15. Findings of this checkpoint
1. The package's release-commit statement was stale; corrected (§1) — the release source is a dedicated commit, never the A2 branch.
2. `packages/domain/dist/dataset-modality.js` is a pinned, git-ignored build output; step added; reproducibility verified.
3. The shared-dev web image changed again (`f11c370eb37f` → `7a802e3e23b2`); recovery tags are by id.
4. The image verifier works on a real image (negative control on the old worker image); the positive path needs the real release images.
5. T033 is satisfied by M24 on the evidence map (`t033-g-sql-evidence-map.md`); new test `web:test:asset-guard-transitions` 5/5, run `20261006T121655Z-d4baa1f0`.
6. Response-shape propagation (`data.dataset.modality` on repository/local-folder responses) is **not** delivered by G-MIG + G-DEPLOY; it belongs to the post-rollout web change set.

## 16. GN decisions and preparation result (2026-10-06)

**Owner decisions recorded.** T033 CLOSED (satisfied by M24; T034/T035 stay OPEN). GN-1 APPROVED: release basis `19a0341`; no visualization delta; never `a5aa248`. GN-2 APPROVED and executed. GN-3 APPROVED for preparation only and executed (nothing deployed or started). GN-4: the stop/restart operator is the human named by the per-run authorization (no invented `authorizedBy`); abort authority is that operator and the release owner, and every hard-stop independently requires HOLD/ABORT. GN-5: private credential path approved; credentials only at window time. GN-6: a fresh authoritative baseline at window start; today's preflight is not the baseline; state outside the approved drift envelope means HOLD, never a silent refresh. GN-7: the window is bounded; its exact duration must be written in the per-run authorization (not invented here). Frozen HOLD/ABORT criteria = the HS-01…HS-10 stops plus: target/system-id mismatch; migration/history/schema/hash mismatch; release-image verification failure; backup/restore-proof failure or inadequate measured capacity; inability to prove writers/services stopped; unexpected queue or in-flight activity; T029/storage eligibility drift; expired or mismatched authorization; launcher/package hash mismatch; migration or post-migration verification failure; needing an excluded mutation to continue. After M24/M25 begins a failure defaults to services stopped and FIX-FORWARD investigation, never an automatic reversal or an old-image start.

**Release commit (GN-2).** `1ba21bb0545c6417261bd5ed8cd222f327f0b4ec` on branch `release/phase029-rollout`, parent `19a03414e81e529c82becff9433a98d1fc94930d`, tree `715638966323d91fd29a709d6ed8e8e0f416a230` (equal to the reviewed candidate), exactly the nine package files; created with `commit-tree`, no trailer, nothing pushed; the checked-out branch (`a2/s0-storage-authority`) and the working tree were not touched.

**Pristine verification** (detached worktree of the commit, `git status --porcelain` empty; receipt `verification/release-preparation/1ba21bb/pristine-verification.json`): M24 `13f0e977…` and M25 `a8ffbc84…` exact; migration tree `f0da8710…`, client tree `a750e6b9…`, implementation digest `c131765e…` exact; package manifest `e5267db4…` exact; `SHARED_DEV_ENABLED = false`; enable patch applies; `git diff 19a0341 -- apps packages prisma lib` empty; offline launcher + maintenance-tools tests **173/173**. The git-ignored domain dist, built deterministically with `pnpm install --frozen-lockfile --offline --ignore-scripts` then the domain build, reproduced the pinned `a78353a3…`.

**Recovery artifacts (GN-3.1)** — receipt `recovery-capture-receipt.json`. Tags created by image id, each checked absent first (nothing overwritten): `annotationplatformdev-web:capture-pre029-20261006-7a802e3e23b2` (`sha256:7a802e3e…`), `annotationplatformdev-worker:capture-pre029-20261006-fbd81331234f` (`sha256:fbd81331…`), `annotationplatformdev-realtime:capture-pre029-20261006-026b62ae608b` (`sha256:026b62ae…`). These are **captures, not verified known-good images**; `stable-184ddd0` and `rollback-pre-stable-20261005` remain untouched. The running containers and the live `:latest` tags were not changed.

**Release images (GN-3.2–3.5)** — receipt `release-images-receipt.json`; built with `docker build` from `git archive 1ba21bb…` in a clean directory (no `.git`), never from the working tree:
| Image | Image ID | Labels | Real verifier (`release-image-verify.mjs`) |
| --- | --- | --- | --- |
| `annotationplatformdev-web:release-029-1ba21bb` | `sha256:107602f2494aec0b17313cbdda4fa00bb64f7d5adda279d21e76f13a59102a74` | revision `1ba21bb…`, service `web` | **PASS 33/33** (receipt `verify-web.json`) |
| `annotationplatformdev-worker:release-029-1ba21bb` | `sha256:e26aefb6443685357e6f07a01712c912a00be47ca49305a858faf48d2bac456f` | revision `1ba21bb…`, service `worker` | **PASS 33/33** (receipt `verify-worker.json`) |
Locally built images have no registry digest; the content-addressed image ID is the identity. Not started, not deployed, no `:latest` retagged; the stopped verification containers were removed.

**Three-flow behavior on the release application tree** (guarded disposable runs from the pristine worktree of the release commit; copies in `flow-runs/`): `verify:ingestion-replay-summary` PASS `20261006T124111Z-96895580` (direct/prepared local-folder replay, mixed-batch commit summary); `web:test:dataset-patch-route` PASS `…T124146Z-69b47d0b`; `worker:test:ingestion-replay-reuse` PASS `…T124219Z-d150afa7` (repository reuse, four modalities); `web:test:imports-ui:vitest` PASS `…T124248Z-a6d22f21` (imports and local-folder UI). The workspace-engine and AI-target feasibility test (3/3, `20261006T115517Z-08c4ed01`) and the chain plan (`20261006T084001Z-6fc0de09`, `g2:candidate` 7/7) ran in the canonical checkout, whose workspace, schema and client code are identical to the release tree. No new response fields are claimed: current behavior is unchanged by this preparation.

**Findings from the preparation**
1. `release:phase029-chain` fails with `FROZEN_CLIENT_FILE_DRIFT` when run in any checkout other than `/home/aioz-huy/anotations`: the tracked generated client embeds the absolute output path (`lib/generated/prisma/internal/class.ts`), so the plan's regenerate-and-compare step is path-bound. It is not a release defect (the client tree hash pin computed correctly in the pristine worktree before any regeneration), but the chain plan must only be run in the canonical path, and the release worktree must never run Prisma generation.
2. The real-MinIO rehearsal harness for launcher v2 (`backfill-maintenance-rehearsal.mjs` and its `disposable-test.mjs` plan) is not part of the nine package files; its evidence (`release:phase029-backfill-maintenance` PASS `20261006T084244Z-7a8b369d`) is bound to the A2-branch tree. The window itself does not use it.
3. No unverified current image is described as known-good; the capture tags are labelled accordingly.

**Offline suite** (canonical checkout, includes the A2/S0 tests): **402/403 passing; the one failure is the known `runtime-browser-control … diagnostic scope is exact` test.** This is not a full PASS.

**What remains before the window (not done, not authorized):** the per-run authorization naming the operator, window duration and the authorized stop/restart actions; the fresh baseline and HS inventory at window start; the shared-dev backup (capacity measured first); credentials at window time; and the window-time T029/T031 steps with the approved-manifest gate.

**Addendum (drift observed during preparation):** while the images were building, the shared-dev web service was rebuilt and restarted by someone else (container `annotationplatformdev-web-1` started 2026-10-06T12:32:32Z; `annotationplatformdev-web:latest` moved from `7a802e3e…` to `sha256:c9debedf3a2d606e9c906c5d20aa1f9b24d8339c788013441249dce97f9bc984`). This preparation issued no compose or service command. The new image was captured by id as `annotationplatformdev-web:capture-pre029-20261006-c9debedf3a2d` (receipt `recovery-capture-addendum.json`; still not verified known-good). This is exactly what the fresh window-time baseline (GN-6) exists to catch: the baseline and HS-07 must be taken against whatever is running then, and an agreed change freeze on the shared-dev services for the window is recommended.

## 17. Frozen release source, window authority and Gate A (owner decision, 2026-10-06)

**Frozen, by content:** release source commit `1ba21bb0545c6417261bd5ed8cd222f327f0b4ec`, tree `715638966323d91fd29a709d6ed8e8e0f416a230`; web image `sha256:107602f2494aec0b17313cbdda4fa00bb64f7d5adda279d21e76f13a59102a74`; worker image `sha256:e26aefb6443685357e6f07a01712c912a00be47ca49305a858faf48d2bac456f`. No `:latest` substitution, no rebuild from another tree, no Prisma regeneration, no silent image replacement. The pre-029 recovery tags remain **captures only**. Status: **EXECUTION-READY, SUBJECT TO PER-RUN AND WINDOW-TIME GATES.**

**Required per-run authorization (must exist before Gate A; none is invented here):** the named human stop/restart operator; the authorized maintenance actions; the maintenance-window duration; the authorization expiry; the release revision and the two image IDs above. **Not present as of this checkpoint: operator, duration, credentials, per-run authorization, change freeze — Gate A has not begun.**

**Change freeze and baseline:** a shared-dev change freeze is mandatory before the authoritative baseline. At opening, capture and verify the actual running web, worker and realtime container/image identities (the preparation-time captures, including the drift addendum, are not the baseline). A difference from the authorized expected state beyond the documented drift allowance means HOLD. After the baseline is written, any unexpected service/container/image replacement before completion means HOLD — never a silent recapture, retag or baseline refresh.

**Canonical execution path:** `release:phase029-chain` runs only from `/home/aioz-huy/anotations`; the resolved working directory must be recorded and verified before execution and a mismatch fails closed. Never run Prisma generation in the release worktree or modify the tracked generated client.

**Gate A scope (only after the authorization, duration, private credentials and freeze exist):** fresh baseline + HS-01…HS-10 → capacity measurement → shared-dev backup/restore proof → controlled service stop → M24/M25 under the guarded launcher → post-migration verification → start of the exact frozen release images → health/compatibility verification → window-time T029 observation. Every HOLD/ABORT condition stays mandatory; after M24/M25 begins, failure = services stopped and FIX-FORWARD investigation, never automatic reversal or starting captures.

**Human T029/T031 gate:** Gate A does **not** pre-authorize T031. T029 produces a fresh observed manifest from window-time DB evidence and a real storage stat, then **STOP**. The historical 28-candidate count is not authority; no approved-ID manifest is generated or signed in advance. T031 requires a separate review of the exact observed-manifest hash and candidate IDs; only then is the approved-ID artifact created and T031 authorized.

**Still excluded:** T030/T032, Cohort-C remediation, EMPTY and MIXED resolution, unrelated job terminalization, A2/M26, the post-rollout response/AI web change set; G3/G5 status unchanged; offline suite recorded as **402/403 with the known diagnostic failure**; no push.

## 18. The three flows after the rollout: what the frozen release images deliver (read this before expecting `dataset.modality` everywhere)

| Flow | `modality` in the response — frozen release images | Server-side file validation — frozen release images |
| --- | --- | --- |
| `/workspace/{datasetId}` | **Yes.** Page props and `GET /api/datasets/{id}/workspace-state` carry `dataset.modality`; the engine is chosen from it (feasibility run `20261006T115517Z-08c4ed01`); unresolved Datasets return `409 DATASET_MODALITY_UNRESOLVED` with a safe projection. | Selected Asset must belong to the Dataset and match its modality; foreign/stale/forged selections return null; the M24 trigger blocks spoofed Assets. |
| `/datasets/imports` (repository) | **No.** `POST /api/datasets/from-repository` returns `dataset: { id, name }`; the modality is the one the user chose and is returned by `GET /api/datasets/{id}` afterwards. | Worker classifies the downloaded bytes (header, bounded ffprobe) and rejects a class ≠ Dataset modality item by item (`ASSET_MODALITY_MISMATCH`); extension is only a hint (`worker:test:ingestion-replay-reuse` PASS on the release tree, `20261006T124219Z-d150afa7`). |
| `/datasets/local-folder` | **No.** The preparation response (`id, datasetId, jobId, expectedItemCount, deadlineAt, items`) has no modality; `POST /api/datasets` and the Dataset reads do. | `verifyUploadedObject` inspects the stored bytes; declared MIME/extension never decide the class; mismatches and unsupported/ambiguous media are refused with no Asset (`verify:ingestion-replay-summary` PASS on the release tree, `20261006T124111Z-96895580`). Video and Ogg remain refused (T022 limitation). |
**Consequence:** the two missing response fields are exactly the post-rollout web change set; G-MIG + G-DEPLOY will **not** add them, and the frozen images cannot be changed to include them. **One more known gap in the frozen images:** the truncated-PNG fix (a PNG signature without a full header) and the classification refactor exist only on the A2 branch; in the release images such a file is still rejected fail-closed (cleanup runs, nothing is published) but surfaces as a generic 500 instead of `422 INVALID_MEDIA`. It joins the post-rollout change set.

## 19. Gate A decision record (owner, 2026-10-06) — NOT EXECUTED

Gate A is **technically approved subject to five per-run fields, all currently UNRESOLVED**: `authorizedBy` (a real human operator), `windowDuration` (exact, bounded), `expiresAt`, `privateCredentials` (available through the approved private path at window time) and `sharedDevChangeFreeze` (explicitly confirmed). Nothing executes while any field is unresolved. The authorization binds: release commit `1ba21bb0545c6417261bd5ed8cd222f327f0b4ec`; release tree `715638966323d91fd29a709d6ed8e8e0f416a230`; web image `sha256:107602f2494aec0b17313cbdda4fa00bb64f7d5adda279d21e76f13a59102a74`; worker image `sha256:e26aefb6443685357e6f07a01712c912a00be47ca49305a858faf48d2bac456f`; canonical execution path `/home/aioz-huy/anotations`. When all five are concretely satisfied, Gate A is GO under this package and its HOLD/ABORT rules, and it ends **at the window-time T029 observed manifest**: STOP, T031 not authorized, no approved-ID manifest created in advance; the exact manifest hash and candidate IDs are returned for separate human review. If Gate A fails or enters HOLD, the post-rollout web change set stays blocked.

**Mandatory post-rollout handoff (not closed by a successful Gate A / G-MIG / G-DEPLOY):** regression-prove `/workspace/{datasetId}` (already exposes authoritative `Dataset.modality` and selects the engine from it); add `data.dataset.modality` to the `/datasets/imports` creation response (fresh and replay) and `data.dataset: { id, modality }` to the `/datasets/local-folder` preparation response — server-observed content stays the classification authority and filename, extension, declared MIME, request/query modality and selected-Asset state never override the Dataset; the partial-PNG case (current: rejected, nothing published, generic 500; required: rejected, nothing published, `422 INVALID_MEDIA`) is a mandatory acceptance item; no VIDEO/Ogg broadening (T022/A2). Evidence already on the release tree: repository validation `20261006T124219Z-d150afa7`, local-folder stored-byte validation `20261006T124111Z-96895580`.

## 20. Environment preflight finding (2026-10-06): compose-required variables

Checked read-only (variable **names** only; no `.env` value was printed or changed). In this repository the compose files require exactly these variables via `${VAR:?…}`: `docker-compose.yaml` — `GITEA_DB_PASSWORD`, `REALTIME_TICKET_SECRET`, `REDIS_PASSWORD`; `docker-compose.review.yaml` — `REALTIME_TICKET_SECRET`, `REDIS_PASSWORD`; `docker-compose.preflight.yaml` has none (it is an override and is not valid standalone). The local `.env` defines all of them, and `docker compose -p annotationplatformdev -f docker-compose.yaml config --quiet` parses cleanly. `MINIO_PREVIEW_BUCKET` and `DEFAULT_PAGE_SIZE` are **not** compose-required variables anywhere in this repository: `DEFAULT_PAGE_SIZE` is a constant inside two API route files, and `MINIO_PREVIEW_BUCKET` appears in no source or compose file (only in a `repomix-output.xml` dump of another worktree). If a different checkout, host or compose file does require them, that file is not the one in the frozen release commit and must be identified before any window.

**Window precondition added:** on the machine that will start the frozen images, `docker compose -p annotationplatformdev -f docker-compose.yaml config --quiet` must succeed **before** the baseline (compose evaluates every `:?` variable even when starting a subset of services, so a missing value would fail the start step after M24/M25). `.env` is never edited or printed by the operator tooling; a missing variable is a HOLD, supplied through the owner's private path.
