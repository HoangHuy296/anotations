# Phase 029 shared-dev maintenance window — execution package

**Status: PREPARED, NOT EXECUTED, NOT AUTHORIZED.** Nothing in this package has been run against shared dev. Shared-dev capability in the launcher is `SHARED_DEV_ENABLED = false` and stays false until the window is opened. Everything described here was exercised only offline (fake-docker models) or on disposable infrastructure.

Written for: the release owner and the operator who will run the window.

## 1. Release commit

| Item | Value |
| --- | --- |
| Application code proposed for deployment | the application tree of `main` at `96379b1f8ebb8daf5510c7eb83d6c90b7b1437c6`. Relative to the verified launcher baseline `19a03414…` it differs **only** in the completed-dataset visualization viewer (8 files under `apps/web/src/components/visualization/` and `apps/web/tests/visualization/viewer.vitest.spec.ts`); `prisma/schema.prisma`, `prisma/migrations`, `lib/generated/prisma`, `packages/queue/src/job-contract.ts`, `packages/domain/src/dataset-modality.ts`, both Dockerfiles and every Phase-029 web/worker file are byte-identical to `19a0341`. Whether to ship the visualization delta in this window or base the release on `19a0341` is owner decision GN-1 in `final-go-no-go-package.md`. |
| Image build commit | a **dedicated release commit R** (not yet created; creating it needs the owner's authorization): `main` plus exactly the nine execution-package files at the blobs listed in `final-go-no-go-package.md` (tree `e3e89a7749b776875e176702115c6922aca68d32`). **Never** the A2-branch commit `a5aa248` or any working tree: that branch contains worker changes (A2/S0: verify-only `ensureBucket`, routed deletes, classification refactor, upload-verification fix) that are not part of this rollout. Images are built from `git archive R` into a clean directory, so uncommitted documentation or A2 work cannot enter an image; the verifier then byte-compares key files to `git show R:<path>`. |
| Frozen migrations | M24 `20260930030000_dataset_modality_g2` sha256 `13f0e977…`, M25 `20261006000000_prepared_import_creation_request_hash` sha256 `a8ffbc84…` (bytes untouched) |
| Launcher-enable change | **not part of the release commit**: a one-line patch (§2) applied locally only for the window, never committed |

The window must be opened from a dedicated release worktree whose `HEAD` is R plus, at most, the uncommitted enable patch; `git status --porcelain` must show nothing else. **Build prerequisite:** `packages/domain/dist/dataset-modality.js` is a git-ignored build output that the launcher pins (`a78353a3…`); in the release worktree run `pnpm --filter @annotationplatform/domain build` (the output is deterministic — verified byte-identical on a pristine worktree) before the launcher is used, otherwise the implementation hash cannot match.

## 2. Launcher enablement (smallest reviewed change)

[launcher-enable-shared-dev.patch](launcher-enable-shared-dev.patch) is exactly:

```diff
-export const SHARED_DEV_ENABLED = false;
+export const SHARED_DEV_ENABLED = true;
```

It authorizes nothing. With it applied, a shared-dev invocation still needs: a private request, a private credentials file, an exact per-run authorization artifact (§3) whose every field is re-derived and compared by the launcher before any application data or object is touched, matching pinned container ids, and an implementation hash that includes the enabled launcher itself (the request pins the launcher's sha256, so the enabled launcher is a distinct, reviewed hash).

**Enable** (window day, after inventory GO, before the first launcher call): `git apply specs/029-modality-specific-datasets/release/launcher-enable-shared-dev.patch`; record `sha256sum scripts/db-safety/backfill-launcher.mjs`; run the offline launcher suite (`node --test scripts/db-safety/tests/backfill-launcher.test.mjs`): with the patch applied exactly **two deliberate tripwire tests fail** (74 "shared-dev capability is disabled in the committed launcher…" and 110 "the launcher reads no environment target…", both assert the committed constant is `false`) and the other 108 pass (verified 2026-10-06, then the patch was reversed and the launcher sha256 matched the pre-patch value). Any other failure, or a different pair, stops the window. After the disable step all 110 pass again.

**Disable again** (mandatory final step, also after any aborted window): `git apply -R specs/029-modality-specific-datasets/release/launcher-enable-shared-dev.patch`; then `git diff --stat -- scripts/db-safety/backfill-launcher.mjs` must be empty, `grep -n "SHARED_DEV_ENABLED = false" scripts/db-safety/backfill-launcher.mjs` must match, the launcher sha256 must equal the pre-enable value, and `node scripts/db-safety/backfill-launcher.mjs observe <any-shared-dev-request>` must abort `SHARED_DEV_EXECUTION_NOT_ENABLED`. Also: shred/remove the private credentials file, remove the authorization artifacts' private copies, and confirm no `annotation.safety=*` helper containers remain. Authorization artifacts are single-use by construction (bound to run token + operation + expiry ≤ 4 h); an unused one simply expires.

## 3. Per-run authorization artifact — `phase029-backfill-authorization/v2`

One artifact per **(operation, run token)**: `observe`, `migrate-m24`, `migrate-m25`, `apply` each need their own. Private file (0600, private directory), referenced from the request as `authorization: {path, sha256}`. Human-authored fields: `authorizedBy`, `statement`. Everything else is copied from the fresh inventory / manifests and then **re-verified by the launcher**; any mismatch fails closed (`AUTHORIZATION_*`).

```jsonc
{
  "schema": "phase029-backfill-authorization/v2",
  "operation": "observe | apply | migrate-m24 | migrate-m25",
  "targetKind": "shared-dev",
  "runToken": "<same token as the request>",
  "issuedAt": "<ISO>", "expiresAt": "<ISO, lifetime ≤ 4 h>",
  "authorizedBy": "<release owner, human>",
  "statement": "<free text, ≤ 500 chars, human>",
  "postgres": {
    "systemIdentifier": "<pg_control system id>", "database": "<name>",
    "migrationCount": 23 /*m24*/ | 24 /*m25*/ | 25 /*observe, apply*/,
    "historySha256": "<digest of the exact migration history>",
    "schemaManifestSha256": "<reviewed manifest digest>", "schemaEntries": 1829 | 1841 | 1842,
    "m24": {"name": "…g2", "checksum": "13f0e977…"}, "m25": {"name": "…hash", "checksum": "a8ffbc84…"}
  },
  "implementationSha256": "<digest of the 13 pinned files + client tree + chain tree, launcher included>",
  "storage": { "endpointHost", "endpointPort", "useSSL", "bucket", "configFingerprint" } /* null for migrate-* */,
  "manifests": { "observedSha256": "<hash>", "approvedSha256": "<hash>" } /* apply only; null/null otherwise */,
  "evidenceDir": "<exact absolute evidence directory>"
}
```

Bindings covered: PostgreSQL system identifier, database name, exact history (count and digest — 25 records for observe/apply), schema fingerprint, M24/M25 names and checksums, launcher + T029 + T031 implementation hash, storage endpoint identity (host/port/TLS), bucket, non-secret storage config fingerprint (hash over endpoint, bucket, region, SSL flag — never a key), observed-manifest hash, approved-manifest hash (apply), run token, operation, expiry, evidence-directory identity. **No database or MinIO secret appears in the artifact, the request, the binding, the receipt, or any evidence file**; the launcher scans every evidence file for the credential values before sealing and the rehearsal asserts it.

Authorization of `apply` is possible only after the release owner has approved IDs against the observed manifest (§8 step 10) — the approved-manifest hash is not knowable earlier, so it cannot be pre-authorized, and the current 28 DB-only candidates are **not** pre-authorized anywhere.

## 4. Private runtime credential architecture

- A single **credentials file** per run, outside the repository, owner-only (0600) in an owner-only directory (e.g. `~/.config/annotation-maintenance/<run-token>/credentials.json`), schema `phase029-maintenance-credentials/v1` with only `postgresPassword`, `storageAccessKey`, `storageSecretKey` (the storage pair is absent/omitted for `migrate-*`). Refused: any path inside the repo, any `.env*` name, wrong mode/owner, hash differing from the request's `credentials.sha256`, older than 4 h.
- The operator types or pastes the values into that file by hand at window time (from the existing private deployment secret store). Nothing is read from the repo `.env`, from `process.env`, from Prisma config, or from the shell; any inherited `DATABASE_URL*`, `PG*`, `MINIO_*`, `S3_*`, `AWS_*`, `BULLMQ_*`, `REDIS_*`, `NODE_OPTIONS` … variable aborts the run (`AMBIGUOUS_TARGET_ENVIRONMENT`).
- Credentials reach **only** the hash-pinned child (or the guarded Prisma migration step) through its private environment, behind the connection fence (sockets allowed only to the two bound `host:port` pairs).
- **Independent target-identity proof before any application-data access:** container id pinned in the request vs `docker inspect`; published port binding; system identifier from `pg_controldata` inside the container compared with the one the TCP session reports (`SYSTEM_IDENTITY_MISMATCH`); migration history, schema manifest digest (read-only, reviewed CTE), then storage identity via the *same* adapter the operation uses (endpoint, bucket exists, config fingerprint) cross-checked against the authorization.
- Evidence is sealed 0400 with exclusive-create; it contains identities, digests, counts and codes only.
- After the window: remove the credentials file and its directory; rotation is not required unless a secret was ever written outside that file (the tools never do), but the release owner may rotate at their discretion.

## 5. Backup procedure (logical; no physical base backup)

Rationale for **no `pg_basebackup`**: the recovery requirement is "restore the application data and the 23-migration schema if M24/M25/T031 go wrong"; a verified logical dump restored into a fresh PostgreSQL covers it, shared dev has no PITR/WAL-archive requirement, and the Postgres volume contains nothing else. If the release owner names a concrete uncovered requirement (e.g. role/extension state, PITR), a physical backup becomes a separate decision.

Tool: [backup-proof.mjs](../../../scripts/db-safety/backup-proof.mjs) (`node scripts/db-safety/backup-proof.mjs <request.json>`), request schema `phase029-backup-proof-request/v1` (source container name + id + db user/name + expected system id, run token, expiry ≤ 4 h, `backupDir`, `negativeControls: true`, `requireDrained: true`). The dump directory must be under `.data/backups/` (git-ignored; the dump holds user data) or the maintenance-runs evidence root, owner-only.

Order of operations (all enforced and receipted):
1. Source identity: container id matches and is running; `pg_controldata` system id equals the expected one.
2. Drained check (`requireDrained`): zero client sessions and zero prepared transactions.
3. Read-only observation of the source (REPEATABLE READ, READ ONLY): history, table list, per-table `count + md5` row fingerprints, sequence values, schema-only dump digest.
4. `pg_dump -Fc` to `backup.dump` (streamed to a private file), then `chmod 0400`, SHA-256 and size recorded, `PGDMP` magic checked.
5. Fresh disposable PostgreSQL created from the **source's own image id**: `--network none`, no published port, random in-memory password, labels `annotation.safety=backup-proof`.
6. `pg_restore --list` must succeed and contain table data entries (`backup.list` sealed).
7. Actual `createdb` + `pg_restore --exit-on-error` into the fresh instance.
8. Compare restored vs source: migration history, schema digest, table set, every table's row count and row fingerprint, sequences. The source is observed again; it must equal the first observation (`SOURCE_CHANGED_DURING_BACKUP`).
9. Negative controls: a truncated dump must be rejected by `pg_restore --list`; a tampered restored row must be detected by the same comparison.
10. The restore container is removed by exact id (labels re-checked first; a half-created container from a failed `docker run` is adopted by exact name and removed too); `backup-receipt.json` (0400) records `VERIFIED` or `FAILED` + code.

A backup counts as **verified** only when the receipt says `VERIFIED`, `restore.removed` is true, and both controls are true. M24 must not start without it. Verified on a real throwaway PostgreSQL container on 2026-10-06 (VERIFIED, both controls true, restore container removed; throwaway source and output deleted); 63 offline tests cover each failure code.

## 6. Release image build plan (web and worker) — not executed

Preconditions: clean tree at the release commit `R`; recovery tags created **before** any build can overwrite `:latest`:
`docker tag annotationplatformdev-web:latest annotationplatformdev-web:recovery-pre029-<date>` (the *running* web image is `f11c370eb37f`, a user-rebuilt image of 21:03 +07, **not** the stable `184ddd0` image `83fb8deb207c`; both are preserved: tag `recovery-running-<date>` on the running image, keep `stable-184ddd0` as is), likewise `annotationplatformdev-worker:latest` (`fbd81331234f`) → `recovery-pre029-<date>`. Realtime is unchanged and not rebuilt.

Build from a pristine export of `R` so no untracked file can enter the image:
```
git archive --format=tar R | (mkdir /private/build-R && tar -x -C /private/build-R)
cd /private/build-R
docker build -f apps/web/Dockerfile    -t annotationplatformdev-web:release-029-R    --label org.opencontainers.image.revision=R --label annotation.platform.service=web    .
docker build -f apps/worker/Dockerfile -t annotationplatformdev-worker:release-029-R --label org.opencontainers.image.revision=R --label annotation.platform.service=worker .
```
(`.dockerignore` already excludes `.env*`, `.git`, `specs/`, `docs/`, `.data/`; `lib/generated/prisma` is tracked and is the pinned client.) Build-time `DATABASE_URL`-style values must not be passed as build args.

Verify each image **before** it is started: `node scripts/db-safety/release-image-verify.mjs --image <ref> --service web|worker --revision R --out <json>` — checks revision/service labels; no migrate/prisma/seed in Entrypoint/Cmd/Healthcheck; no credentialed URL or secret value in baked ENV; key files byte-identical to `git show R:<path>` (schema, M24, M25, Prisma client models, queue job contract, modality contract, app entry files); generated client tree and migration chain tree equal the pinned hashes (`a750e6b9…`, `f0da8710…`); `Dataset` has `modality` + the three modality fields; `PreparedImport.creationRequestHash`; web `BUILD_ID`; no `.env*` file anywhere. It only creates a stopped, network-less container and removes it. **Web/worker queue compatibility** is the identical `packages/queue/src/job-contract.ts` byte check on both images (payload `{jobId}` only, same queue name/prefix); a mixed web(new)/worker(old) pair is never started.

Start (after postflight-1, §8): a compose override file outside the repo that only sets `image:` for `web` and `worker` to the verified release tags (no `build:`), then `docker compose -p annotationplatformdev up -d --no-build --no-deps web worker`. Neither image has a migrate or seed startup path (checked above), so startup cannot change the schema.

## 7. Fresh read-only inventory — run immediately before authorization and again at each gate

Tool: [backfill-window-inventory.mjs](../../../scripts/db-safety/backfill-window-inventory.mjs). Read-only: `docker inspect`, one READ ONLY REPEATABLE READ psql transaction inside the Postgres container, `redis-cli` read commands (`LLEN`, `ZCARD`, `EXISTS`, `HGET`); output file created exclusively.

```
node scripts/db-safety/backfill-window-inventory.mjs <out.json> --write-baseline <baseline.json>            # first run of the window (23-migration state)
node scripts/db-safety/backfill-window-inventory.mjs <out.json> --baseline <baseline.json> --mode preflight # before authorization
node scripts/db-safety/backfill-window-inventory.mjs <out.json> --baseline <baseline.json> --mode drained   # after web/worker stopped
node scripts/db-safety/backfill-window-inventory.mjs <out.json> --baseline <baseline.json> --mode drained --expect-history 24|25 --skip-candidates
```
It records: DB system id, database/user, server version; migration history (23 rows, checksums, finished/rolled-back) and digest; schema manifest fingerprint (1829 entries); Dataset/Asset/Annotation/Job counts and import statuses; sessions (by application), idle-in-transaction, active queries, longest transaction; locks (ungranted, prepared transactions, ACCESS EXCLUSIVE on app tables); Redis queue sets and per-job-key existence for every non-terminal job; the list of non-terminal jobs and PREPARING imports; the DB-only T029 candidate set (computed with the same eligibility SQL, read-only); container ids/images/state for postgres, redis, minio, web, worker, realtime.

**Exit 2 = STOP** (window stops for review). Hard stops: HS-01 system id/database changed; HS-02 history not exactly the baseline (count/digest/unfinished/rolled-back); HS-03 schema entry count or digest changed; HS-04 non-terminal job set or any job's status changed; HS-05 PREPARING import set changed; HS-06 DB-only candidate set differs from the baseline; HS-07 any container id/image changed (or missing); HS-08 queue not empty or a non-terminal job has a queue key; HS-09 prepared transaction, ungranted lock, idle-in-transaction session; HS-10 (drained mode) client sessions/active queries/exclusive locks present or web/worker still running. Counts growing (annotations, datasets) is informational only. A candidate-set difference vs the 28 IDs recorded earlier is expected to be reviewed, never auto-accepted: the final membership comes only from the window's own T029 observation.

The candidate baseline (a scratch file derived from a real read-only run on 2026-10-06, deliberately not committed) is **not accepted** — the release owner must accept or replace it at window time.

## 8. Maintenance sequence (command level)

Every step writes evidence under `specs/029-modality-specific-datasets/verification/maintenance-runs/<run-token>/` (owner-only; secret-free). A step that exits non-zero ends the sequence at that point and goes to the failure matrix (§9). `L` = `node scripts/db-safety/backfill-launcher.mjs <operation> <request.json>`.

| # | Action | Command / evidence | Proceed only if |
| --- | --- | --- | --- |
| 0 | Open window: release worktree at R with the domain dist built, release owner present, credentials file prepared, recovery tags created (§6), images built **and verified** (§6) — may be done earlier | `release-image-verify` JSON ×2 | both images `ok:true` |
| 1 | Fresh inventory (preflight) + write baseline | inventory CLI | GO; baseline accepted by release owner |
| 2 | Enable launcher (§2); record launcher sha | `git apply …` | tests pass |
| 3 | Stop web, then worker (no restart-policy surprises: stop, not kill; realtime untouched) | `docker compose -p annotationplatformdev stop web worker` | containers exited |
| 4 | Inventory `--mode drained` | inventory CLI | GO (no sessions, no locks, queue empty) |
| 5 | **Verified logical backup** | `backup-proof.mjs` (§5) | receipt `VERIFIED`; dump path + sha recorded |
| 6 | Inventory again (backup must not have moved anything) | inventory CLI | GO, same fingerprints |
| 7 | Authorization A1 (`migrate-m24`) + request; **M24** | `L migrate-m24 …` (guarded `prisma migrate deploy` from the staged, hash-checked chain through a frozen config; 23→24, schema 1829→1841, exactly the 12 reviewed additions) | receipt + verification.json OK |
| 8 | Verify M24 independently | inventory `--expect-history 24 --skip-candidates` | GO; schema fingerprint recorded |
| 9 | Authorization A2 (`migrate-m25`); **M25** | `L migrate-m25 …` (24→25, 1841→1842, one added column) | receipt OK |
| 10 | Verify M25 independently | inventory `--expect-history 25 --skip-candidates` | GO |
| 11 | Authorization A3 (`observe`); **T029 observe** on the real shared-dev MinIO | `L observe …` → `observed-manifest.json` (read-only; object `stat` only) | receipt OK |
| 12 | **STOP — real human gate.** Release owner reviews the observed manifest line by line and runs the offline approver (`apps/web/scripts/backfill-approve.ts`) to produce the approved-ID manifest containing **only** IDs they approve. Nothing is auto-approved; Cohorts B/C/D, TEXT/EMPTY/MIXED never enter by default | approved-manifest.json + sha | release owner signs; window may be suspended here |
| 13 | Authorization A4 (`apply`) binding both manifest hashes; **T031 apply** | `L apply …` (CAS claim per Dataset inside Serializable txn, re-stat of objects, opaque subject `system:phase029-backfill:<run-token>`) | result.json accounts for every approved ID (applied/refused with reasons) |
| 14 | Inventory/DB postflight (§10 rows P1–P5) | inventory + SQL read-only checks | all pass |
| 15 | Start candidate web + worker (override file, `--no-build --no-deps`) | `docker compose … up -d` | healthy (§10 P6–P9) |
| 16 | Postflight smoke (§10) | | pass |
| 17 | **Disable** the launcher capability; remove credentials; final inventory; record container ids | §2 disable | all checks pass |

Between steps 11 and 13 the system stays drained; web/worker are not restarted so the observed manifest is still the state that is applied (T031's compare-and-swap rejects any Dataset whose `modalityContentRevision` moved). No step mutates jobs, imports, queue data or MinIO objects.

## 9. Failure boundaries and rollback matrix

Universal rules: never auto-run a reverse/destructive migration; never `migrate resolve`, `db push`, or manual DDL to "fix" a failed step; preserve all evidence directories and the dump; the receipt/binding of the failing step are the source of truth; web/worker stay stopped until an **explicit, recorded recovery decision**. Recovery options are always *options for the release owner*, not automatic actions.

| Failure point | State | Immediate action | Candidate recovery (needs explicit decision) |
| --- | --- | --- | --- |
| Before backup (steps 0–4) | untouched | abort; restart web/worker from the **old** images/containers only (they were stopped, not removed) | none needed; re-run inventory |
| Backup fails/FAILED receipt | untouched | do not proceed; keep FAILED receipt; remove nothing | fix cause, re-run backup-proof with new token |
| After backup, before M24 | untouched; backup valid | decide to continue or abort; if abort restart old containers | re-inventory before resuming; backup older than the next drain must be re-taken if anything ran |
| During/after M24 (`migrate-m24` non-zero) | **unknown**: Prisma applies M24 in one transaction, so expected = either 23 or 24 rows; the launcher's post-verification classifies | run inventory (read-only); compare history/schema with §3 expectations; do not retry blindly | (a) state 23: fix cause and rerun M24; (b) state 24 verified: continue; (c) any other/unfinished/rolled-back record or schema mismatch: stop; options = restore from the verified dump into a **new** database for comparison, or a release-owner-authored repair plan; no automatic reverse |
| During/after M25 | same classification with 24/25 and 1841/1842 | same | same; M24 remains valid and is not touched |
| During T029 (observe) | read-only: DB unchanged except none; objects untouched | collect `binding.json`; no data changed by definition | rerun observe with a new token |
| After T029, before approval | schema at 25, no backfill | suspend window safely: web/worker remain stopped **or** restart the *new* images (schema 25 is compatible with them; old images are not guaranteed compatible once M24/M25 are applied — see note) | continue later from step 11 with fresh inventory; observed manifest older than any restart must be regenerated |
| T031 partial | each Dataset is atomic; some approved IDs applied, some refused | `result.json`/receipt is the accounting; do not rerun with the same IDs blindly | re-observe (T029), re-approve only the remaining IDs; applied Datasets are never reverted automatically; revert of an applied Dataset requires an explicit owner decision and a reviewed single-purpose script |
| Runtime startup/postflight failure | schema 25, backfill done | stop the new containers; keep evidence | options: fix forward on the new images; or restart **old** web/worker only if the release owner accepts that M24/M25 columns are additive and old code ignores them (G2 compatibility run covers the old client against the 25-chain, but production-like acceptance of the old build on the migrated DB is *not* part of this package); database restore from the dump is the last resort and needs explicit approval |

Note on rollback of images: the old web/worker images remain tagged for recovery (§6). M24/M25 only *add* columns/constraints/triggers; the compatibility proof (`g2:compatibility`, passing in the disposable plans) covers old-client reads against the migrated schema. Dataset rows left unresolved keep working under the legacy behaviour.

## 10. Postflight verification matrix

| ID | Check | Method | Expect |
| --- | --- | --- | --- |
| P1 | History | inventory `--expect-history 25` | 25 finished, none rolled back, M24/M25 checksums frozen |
| P2 | Schema | inventory | 1842 entries, digest equals the authorization's |
| P3 | T031 accounting | `result.json` vs approved manifest | every approved ID applied or refused with a reason; no unapproved Dataset changed |
| P4 | Unresolved remain unresolved | read-only SQL | all non-approved Datasets `modality IS NULL`; legacy `primaryModality` unchanged; no EMPTY/MIXED/Cohort B/C/D resolved |
| P5 | Data counts | inventory vs baseline | Dataset/Asset/Annotation/Job counts equal baseline (+ expected backfill none); job statuses unchanged; no new Job rows |
| P6 | Web | `/api/health`-style probe + a Dataset list request with a test account | 200, modality fields serialized for resolved Datasets, `null`/unresolved UI path unchanged |
| P7 | Worker | container up, logs show it connected to queue `annotation-platform:fieldframe-jobs`, **no** job picked up (queue empty) | healthy, idle |
| P8 | Queue | inventory redis section | empty; payload contract unchanged (`{jobId}`) |
| P9 | Realtime | container id/image identical to baseline | unchanged |
| P10 | Images | `docker inspect` of running web/worker | ids equal the verified release images |
| P11 | Evidence | all evidence files 0400, secret scan, receipts present | pass |
| P12 | Launcher disabled | §2 | `SHARED_DEV_EXECUTION_NOT_ENABLED` |

## 11. Policy preserved (unchanged by this package)

F-1 (stale-job mutation) deferred; F-3 deferred; no stale-job mutation; Cohort B not automatically backfilled; Cohort C unresolved pending T030 (deletion is never a default remediation); Cohort D unresolved; only EMPTY owner/current-ADMIN resolution paths exist and none is executed; MIXED unresolved; legacy `primaryModality` is never used as authority. Production capacity acceptance is a separate production gate and does not block this shared-dev window; **G5 remains open** and prevents declaring Phase 029 fully released.

## 12. Decisions required immediately before opening the window

1. Release owner confirms the release commit `R` (the checkpoint commit, or 19a0341 if no new commit) and authorizes committing this package (not yet committed).
2. Accept or replace the window baseline (the scratch candidate baseline) after the preflight inventory; confirm the 28 DB-only candidates are **observation inputs only**.
3. Who is the named `authorizedBy` and what is the statement text for each of A1–A4; A4 only after the human approval gate.
4. Confirm the logical-backup-only policy (no physical base backup) or name the uncovered recovery requirement.
5. Confirm the rollback preference for runtime failure after M25 (fix-forward vs old images).
6. Approve creating the recovery tags and building the two images (no build was done); confirm realtime stays untouched.
7. Provide the credentials (typed into the private file by the operator); confirm the exact shared-dev MinIO bucket name and endpoint to bind.
8. Confirm the window length and who may stop it.
