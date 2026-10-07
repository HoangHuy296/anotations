# S0 — M1 storage-authority proof (A2 workstream, disposable MinIO only)

**Status:** implemented. **AUTHORITATIVE disposable run PASS** — `authoritative-20261006T120356Z-127c23c2` (111/111, replay idempotent, audit equal to allowlist, independent cleanup verification true), after the release owner froze the image digests on 2026-10-06 (`frozen-images.json`, `frozen:true`). The earlier run `rehearsal-20261006T115147Z-921a1276` (also 111/111) remains rehearsal evidence only; an `--authoritative` run refuses to start while the pins are unfrozen (verified before the freeze). Nothing here touches shared dev, the application database, G3/G5, M24/M25 or the 25-migration rollout package; A2 architecture/spec stays FROZEN and T022 stays OPEN.

Written for: the release owner reviewing S0 and freezing the provisioning image identity.

## Provisioning-image identity (FROZEN by the owner, 2026-10-06)
| Item | Value |
| --- | --- |
| Provisioning tool | `minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727` (resolved image id equals the digest; amd64; created 2025-09-07) |
| `mc --version` | `RELEASE.2025-08-13T08-35-41Z` |
| MinIO server | `minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e` (tag `RELEASE.2025-04-22T22-12-26Z`, the release already pinned by the maintenance plan) |
| Not used as evidence | `minio/mc:latest` or any floating tag (refused by `checkImagePins`) |
The image lacks `sed`, `grep` and `awk`; the provisioning scripts therefore use only `sh` builtins, `tr`, `cat`, `printf` and `mc`. `mc` is **not** added to any application or release image; it runs as a short-lived container (read-only root, tmpfs, caps dropped, no-new-privileges, pids/memory limits, internal network, no bind mounts, secrets by environment *name*).

## Provisioned authority matrix (policies in `scripts/db-safety/minio-authority/`)
| | I-WEB | I-WORKER | I-VERIFIER |
| --- | --- | --- | --- |
| read objects | all | all | sealed + staging only |
| write/delete/multipart | staging (`direct-uploads/`, `prepared-imports/`) | everything except sealed | **sealed** (put/delete/abort/list-parts); delete on staging; **no write on staging or other prefixes** |
| sealed (`verified-uploads/`) mutation, tags, retention, legal hold, list-parts | explicitly **denied** | explicitly **denied** | allowed only put/delete/multipart/read |
| bucket creation, lifecycle, policy, versioning, delete bucket | none | none | none |
Lifecycle (provisioned by the supervisor, not by an application): the pre-existing rule only — `annotationplatform-expire-direct-uploads`, prefix `direct-uploads/`, 7 days; verified to touch neither the sealed namespace nor the whole bucket.

## Evidence (rehearsal; run `rehearsal-20261006T115147Z-921a1276`, receipts in `verification/s0-storage-authority/`)
- **111/111** checks pass: 33 web, 40 worker, 27 verifier, 4 cross-cutting invariants, 7 root controls. Includes PUT create/overwrite, copy-to, delete, multipart initiate/abort/list-parts, tagging, retention, legal hold, bucket admin (lifecycle read/write, policy, versioning, create/delete bucket), presigned PUT and presigned POST signed by the web identity naming a sealed key (both 403 at use), a tampered POST `key` (rejected), plus positive controls (staging upload via presigned POST, owner conditional seal with an ETag precondition, stale-ETag precondition refused by the store, owner delete, root controls proving each operation kind reaches the store). The sealed object's ETag/size/lastModified/content and the key set are unchanged after the battery.
- **Routing (real worker scanner code, `referenceCheckers: []`):** plain general client cannot delete a sealed key; routed client with no owner fails closed (`SEALED_OWNER_UNAVAILABLE`); routed client deletes sealed keys through the owner chosen by key classification (`sweepUnreferencedObjects`, `sweepSingleObject`, and the `createRoutedWorkerMinio` factory used by bulk-delete/readiness); non-sealed keys use the general client; a case-variant of the sealed prefix is `STORAGE_KEY_INVALID` (refused, never privileged); no `MINIO_VERIFIER_*` ⇒ no fallback.
- **Startup/readiness without admin authority:** the real `probeMinioProvisioning`/`ensureBucket` succeed for I-WORKER on the provisioned bucket; with the bucket removed they fail closed (`MINIO_BUCKET_NOT_PROVISIONED`), and even `MINIO_LEGACY_APP_ADMIN=1` cannot create it without authority; re-provisioning restores readiness. The sealed-write readiness probe passes for web/worker identities and **fails closed for a root credential** (control).
- **Fail-closed provisioning:** a deliberately over-broad web policy is detected (`POLICY_MISMATCH:web`) and makes the sealed-write denial fail (tests are not vacuous); a detached verifier policy is detected and the owner loses authority rather than gaining it; replay restores the exact state.
- **Replay idempotency:** two provisioning runs yield identical snapshot digests (`c57aa040ff672f9c…`).
- **Static audit:** equals the committed allowlist; finds the indirect web→worker deletion path (`import-cleanup.ts` → `queue/minio-orphan-scanner.ts`); `MINIO_VERIFIER_*` is referenced by exactly one module (`providers/sealed-namespace.ts`).
- **Cleanup:** identities and policies removed (listing after removal shows neither), all objects removed, every container (MinIO + each short-lived `mc`), the internal network and the data volume removed by exact id; an independent process (`minio-authority-verify.mjs`, Docker CLI only) re-checked absence by id and by run label.
- **Offline/guarded:** `scripts/db-safety/tests/minio-authority.test.mjs` (11 tests: policy review incl. mutations, snapshot verification, image pins, secrets, audit incl. temp-repo fixtures); worker `sealed-namespace.test.ts` PASS via `worker:test:sealed-namespace` run `20261006T114744Z-80d5a9a0`; db-safety suite 402/403 (the known unrelated failure remains).

## Discovered privilege paths / limitations
1. **`s3:ListMultipartUploadParts`** was granted to I-WORKER on the sealed namespace by its broad allow (first rehearsal: K-7 ALLOWED). Read-only, but now explicitly denied for web/worker; the contract's deny list was extended.
2. **Retention is inert on the S0 bucket.** MinIO rejects retention calls with `InvalidRequest` for *every* identity, root included, because the bucket has no Object Lock configuration — so retention cannot be shown as an IAM denial here. Recorded as "inert (identical to root)"; the explicit Deny statements exist and are statically reviewed. **Re-run S0 on an Object-Lock bucket before Object Lock is ever enabled.**
3. **I-VERIFIER holds unconditioned `s3:ListBucket`** (names of every key, read-only). A prefix-conditioned grant makes `HEAD` of a missing key return 403 instead of 404, which the seal/probe logic must distinguish; documented trade-off.
4. **One worker process holds both I-WORKER and I-VERIFIER** (residual risk already stated in the contract §5.5).
5. **Provisioning performs `mc admin user add` with the secret as an argv inside the throwaway no-egress container** (mc offers no stdin form); the container is removed immediately and logs are secret-scanned.

## How to run
- Rehearsal: `node --import tsx scripts/db-safety/minio-authority-s0.mjs`
- Authoritative (after the owner sets `frozen:true`): `node --import tsx scripts/db-safety/minio-authority-s0.mjs --authoritative`
- Static audit: `node scripts/db-safety/minio-write-audit.mjs`
- Rollout hygiene: the rollout package and the A2 files currently share the history of branch `a2/s0-storage-authority` (commit `a5aa248`); the rollout must still be built from its own release commit on `main` (D1).
