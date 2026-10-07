# A2 contract — durable pre-publication media verification (direct upload and local folder)

**Status: A2 ARCHITECTURE/SPEC — FROZEN (v3, 2026-10-06; release-owner decisions D1–D11 and R1–R8 applied, R5 corrected).** Nothing here is implemented, migrated or enabled. Current synchronous behavior (fail-closed 415 for ambiguous containers) is unchanged until the follow-on increment is implemented. **T022: OPEN — A2 implementation pending; it must not be marked complete.** No M26 SQL bytes are approved by this freeze: any generated M26 migration needs its own exact-byte review and disposable rehearsal.

Written for: the release owner freezing the contract, then the engineers who will implement it.

**Owner decisions recorded.** A2 (durable pre-publication verification Job); no handwritten parser; no MIME/extension/`ftyp`/EBML/weak-header classification; VIDEO stays a valid Dataset modality and empty VIDEO Datasets stay creatable. D1 follow-on increment after the 25-migration rollout. D2 dedicated `VERIFY_UPLOADED_MEDIA` Job kind + `MediaVerification` model. D3 conditional sealing with the ETag **not** treated as strong identity. D4 stop advertising `audio/ogg` for direct/local upload (repository-import Ogg behavior unchanged). D5 codecs H.264/VP8/VP9/AV1, no HEVC, codec alone never sufficient. D6 keep the existing upload/preparation deadline; separate bounded verification allowance (§7). D7 correct the cover-art classifier in the shared policy **and** the repository path, characterization first, no historical rewrite. D8 cap 50 non-terminal verifications per actor and per Dataset (§8). D9 pending verification blocks folder commit with `UPLOAD_VERIFICATION_PENDING`, import Job not failed. D10 deterministic rejection may terminalize the Job as `FAILED` with a non-retryable deterministic reason (§9). D11 disposable runtime uses R-B (receipt-owned worker container pinned to the exact worker image).

**Decision record R1–R8 (all resolved).**
| ID | Decision |
| --- | --- |
| R1 | APPROVED. Allowance = 30 min from the committed PENDING creation; never reset or extended. The folder preparation deadline is preserved; pending verification may extend the folder tail only up to `deadlineAt + 30 min`. |
| R2 | APPROVED WITH QUALIFICATION. Terminal non-PUBLISHED rows may be purged after 30 days **only after** cleanup of both the staged and the sealed object has been positively established (`objectsClearedAt` set, §4); the minimal audit record that survives is the retained `Job` row and its safe summary (existing convention: only `JobEvent`s are retention-purged — to be re-confirmed at implementation); PUBLISHED rows stay. |
| R3 | APPROVED. If the pinned worker image cannot generate an AVIF/HEIC sample, source a deterministic negative fixture (recorded SHA-256). This adds **no** AVIF/HEIC support. |
| R4 | APPROVED. No whole-object re-hash at publication; publication re-validates the sealed identity/provenance (§5.4) and uses the persisted `contentSha256` and probe decision. |
| R5 | **CHANGED.** An exhausted probe timeout or other probe-execution exhaustion is an **operational verification failure**, never an authoritative media rejection. `REJECTED` requires an authoritative *completed* probe that negatively classifies the media (§5.1, §6.2). Terminal matrix revised (§9). |
| R6 | APPROVED. `429 UPLOAD_VERIFICATION_LIMIT_REACHED`; `503 UPLOAD_VERIFICATION_BUSY`. |
| R7 | APPROVED. Remove `audio/ogg` from advertised direct/local capability as task **A2-0**, after the current 25-migration rollout window closes, without touching the rollout package. |
| R8 | APPROVED. Each probe attempt is capped at 120 s. |
| **R9** | **APPROVED: M1** — separate prefix-scoped MinIO identities for the web/staging side and the verification worker. A2 may not claim a sealed immutable namespace while web and worker share root-equivalent MinIO credentials. Storage-authority matrix, acceptance evidence and the static audit baseline: §5.5. Proven first in the disposable runtime; no shared-dev/global MinIO credential is changed by this contract. |
Runtime decisions: separate disposable-HTTP-runtime change set approved in design; reuse the existing pinned MinIO and Redis images; R-B (receipt-owned worker container from the exact worker image); initial worker limits 2 CPUs, 1 GiB memory, 256 MiB tmpfs, read-only root, all capabilities dropped, no host/bind mounts, no external egress (verification-runtime defaults, **not** production capacity acceptance).

## 0. Invariants

No `Asset` row and no modality subtype row may exist for an object until (1) authoritative verification established its class from its bytes, (2) that class equals the **current** `Dataset.modality`, and (3) the object is the exact immutable object that was verified. Client MIME, filename, extension and container prefix may select an upload slot or gate *eligibility* for verification; they never decide the final modality. `VERIFIED` means **positively verified and eligible for publication**; a negative authoritative result is `REJECTED`, never `VERIFIED`.

## 1. Audit findings that shape the design (re-verified in the tree)

| # | Finding | Source |
| --- | --- | --- |
| F1 | Direct upload has **no durable record**: the capability is a stateless AES-GCM token (TTL 10 min); the key is fixed by the token and the presigned POST can overwrite it until expiry. Folder items have `PreparedImportItem` rows with fixed `storageKey`. | `upload-capability.ts`, `presigned-upload/route.ts`, `schema.prisma` |
| F2 | Both synchronous routes delete the staged object on any failure (`cleanupUnpublishedObject`); a pending state must never trigger that. | `complete-upload/route.ts`, `complete-local-folder-item.ts` |
| F3 | Folder accounting is per-item stable `JobEvent` ids (`phase029_import_success_<item>` …) aggregated by commit; the folder's own Job is an `IMPORT_DATASET` receipt job; `deadlineAt` 30 min; `failExpiredPreparedImports` expires it. | `commit-local-folder-import.ts`, `import-timeout-scanner.ts` |
| F4 | Existing job machinery already gives lease/heartbeat/attempts, in-place stale retry, redelivery when Redis lost an entry, cooperative cancel, safe DTOs, retry lineage, and a precedent for "snapshot source identity at enqueue, recheck at commit" (`TEXT_SOURCE_PREPARE`). | worker `queue/*`, `job-claim-lock.ts`, `text-source-prepare-job.ts` |
| F5 | Worker image has ffmpeg/ffprobe and bounded helpers (`runBoundedMediaProcess`, `materializePrivateSource`); the host has no ffprobe. | `apps/worker/Dockerfile`, `media/*` |
| F6 | **Existing defect vs its own contract:** `classifyProbeOutput` counts any `codec_type:"video"` stream as VIDEO and the probe requests only `stream=codec_type`; the contract says cover-art ambiguity is rejected. (An MP3 with an ID3 header is classified AUDIO by the header path before any probe; cover-art in M4A/MP4, FLAC/Ogg pictures and HEIF/AVIF tile streams are not protected.) | `repository-media-classification.ts` |
| F7 | `materializePrivateSource` checks size only, not identity. | `media/source-materialization.ts` |
| F8 | No existing `JobType` can represent verification (§3). | `schema.prisma` |
| F9 | The authoritative classifier contract is stream-based and has no container list, so it does not imply Ogg on the upload path (`audio/ogg` is advertised but refused today). | `creation-ingestion.md`, `research.md` R4 |
| F10 | **ETag is not a strong content identity** (multipart/SSE/alternative-store ETags are not content MD5s). The installed client (`minio` 8.0.7, already a dependency) supports `copyObject` with `CopySourceOptions{MatchETag, MatchUnmodifiedSince, VersionID}`; `statObject` returns etag, size, lastModified (and versionId on versioned buckets). `Asset.checksum` and `Asset.sourceEtag` columns already exist. | `minio@8.0.7` types, `schema.prisma` Asset |
| F11 | **Timing conventions today:** upload capability TTL 10 min; folder `IMPORT_DEADLINE` 30 min; Job lease 5 min with heartbeat; recovery lease grace 60 s (`JOB_RECOVERY_LEASE_GRACE_MS`); global runaway guard `JOB_MAX_RUNTIME_MS` 60 min; `maxAttempts` 3; media `maxProcessMs` 10 min (sized for 2 GiB sources); orphan grace / temp-upload retention 24 h; JobEvent retention 30 d. | `config.ts`, `job-claim-lock.ts`, `media/policy.ts`, `prepare-local-folder-import.ts` |
| F12 | **Retry eligibility is "any `FAILED` Job whose type has a retry context"** (`retry-job.ts` checks only `status === FAILED` and `extractRetryContext`); there is no retryable flag. Non-retryability must therefore be encoded in `extractRetryContext` (return `null`). Precedent for Serializable transactions with `P2034` retry ×3: `retry-job.ts`. | `retry-job.ts` |
| F13 | The rollout tooling pins `prisma/schema.prisma`, the generated client tree, the migration-chain tree and, in the image verifier, `packages/queue/src/job-contract.ts` — all of which A2 necessarily changes. | `backfill-binding.mjs` `IMPLEMENTATION_FILES`, `release-image-verify.mjs` |

### 1.1 Separation from the current rollout (D1)
A2 and M26 are a **separate workstream**. Rules, binding on the implementation:
1. No A2 change may land on the branch/commit used to build the rollout images or to run the maintenance window. The rollout is executed from its release commit `R`; A2 work lives on its own branch and merges only after the rollout is complete and G5/closure bookkeeping for Phase 029 is unaffected.
2. A2 never edits M24/M25, `PROPOSAL_CHAIN`, `RELEASE_COUNTS`, the launcher pins, the authorization schema, `release/shared-dev-execution-package.md`, `launcher-enable-shared-dev.patch`, or any file in `IMPLEMENTATION_FILES`, until the rollout is complete. (A2 *will* change `prisma/schema.prisma`, `lib/generated/prisma`, `prisma/migrations` and `packages/queue/src/job-contract.ts`: that is exactly why it cannot share the window.)
3. A2 gets its own chain plan (`release:phase029-a2-chain`, 26 migrations) and its own release artifacts, created later; the existing `release:phase029-chain` plan stays at 25.
4. Documents in this checkpoint (`specs/…`) are not pinned files and do not affect the rollout package.

## 2. Scope and routing

A2 handles exactly: **an uploaded object that the existing bounded synchronous verifier cannot definitively classify, whose declared candidate type is `video/mp4` or `video/webm`, uploaded into a Dataset whose `modality` is VIDEO.** Routing at completion (both routes), server-side, in this order: (1) authorization and capability checks as today; (2) synchronous verifier unchanged — definitive IMAGE/AUDIO/TEXT goes to the existing publisher; (3) `UNSUPPORTED_MEDIA` **and** declared ∈ {`video/mp4`,`video/webm`} **and** parent `modality === VIDEO` ⇒ create a verification (§5.2); (4) everything else keeps today's behavior. The declared type is an eligibility gate that bounds resource use; it is never an input to the verified class.

Fail-closed and unchanged: audio-only containers into AUDIO Datasets, any other declared type, any non-VIDEO Dataset, `audio/ogg` (also removed from advertised capability, D4: `candidateContentTypes`, `schemas/assets.yaml`, `schemas/import-repository.yaml` lose `audio/ogg`; early `400 INVALID_REQUEST`; repository-import Ogg handling untouched).

## 3. Job kind / schema delta (conceptual, = M26)

`JobType.VERIFY_UPLOADED_MEDIA` (new); **no** new `JobStatus` or `JobStage` (stages map to `VALIDATING_INPUT` = seal, `EXTRACTING_METADATA` = probe, `WRITING_ASSETS` = publish). Queue: add the type to `supportedQueueJobTypes`, one router branch; payload strictly `{ jobId }`. `Job.input` (strict Zod in `packages/domain/src/media-verification-job.ts`): `{ "verificationId": "<uuid>", "contractVersion": 1 }` — never keys, URLs or credentials; the authoritative record is the `MediaVerification` row. Why not an existing type: `IMPORT_DATASET` is a receipt/repository dual-purpose type (a third meaning blurs routing and retry allowlists) and direct upload has no import row; `EXTRACT_VIDEO_METADATA` runs after an Asset exists; `TEXT_SOURCE_PREPARE` is Asset-first (design precedent only).

### 3.1 M26 conceptual schema delta (Prisma-generated SQL only)
1. `ALTER TYPE "JobType" ADD VALUE 'VERIFY_UPLOADED_MEDIA'`.
2. `CREATE TYPE "MediaVerificationSource" ('DIRECT_UPLOAD','LOCAL_FOLDER_ITEM')`, `CREATE TYPE "MediaVerificationStatus" ('PENDING','SEALED','VERIFIED','PUBLISHED','REJECTED','STALE','CANCELED','EXPIRED')`.
3. `CREATE TABLE "MediaVerification"` (§4) with its unique constraints, indexes and foreign keys.
Not in M26: no change to `Asset`/`Dataset`/`Job`/`PreparedImport*` columns, no M24 trigger change, no hand-written SQL, no trigger/CHECK (a DB-level verification invariant would be a separate G-SQL approval). The tracked client is regenerated; the reviewed schema-manifest entry count changes by the table/column/index/constraint additions (to be computed in the M26 review, not now). M26 gets its own G-MIG disposable proof (apply/replay on the 26-chain), never shared-dev without approval.

## 4. `MediaVerification` — fields, constraints, indexes

```
model MediaVerification {
  id                    String   @id @default(uuid())
  datasetId             String                              // FK Dataset  onDelete: Cascade
  requestedById         String                              // FK User     onDelete: Restrict
  source                MediaVerificationSource
  preparedImportItemId  String?                             // FK PreparedImportItem onDelete: Cascade; folder only
  currentJobId          String?                             // FK Job onDelete: SetNull; moves on retry successor
  generation            Int      @default(1)                // re-upload after a terminal non-PUBLISHED outcome
  boundDatasetModality  Modality                            // snapshot at request; v1 always VIDEO

  // staging identity (browser-writable object), captured by statObject at the request
  stagedBucket          String
  stagedKey             String
  stagedEtag            String
  stagedSizeBytes       BigInt
  stagedLastModified    DateTime
  stagedVersionId       String?

  // request metadata — hints/audit only, never classification input
  filename              String                              // sanitized
  relativePathHint      String?                             // folder: normalizedPath
  declaredContentType   String
  declaredSizeBytes     BigInt

  // sealed identity (worker-owned object), from an independent statObject after the conditional copy
  sealedKey             String?  @unique
  sealedEtag            String?
  sealedSizeBytes       BigInt?
  sealedLastModified    DateTime?
  sealedVersionId       String?
  contentSha256         String?                             // lowercase hex of the exact materialized sealed bytes

  status                MediaVerificationStatus @default(PENDING)
  verifiedModality      Modality?                           // set only with VERIFIED / PUBLISHED
  resultCode            String?                             // safe, upper-case; terminal non-PUBLISHED
  resultReason          String?                             // safe sub-reason
  probe                 Json?                               // allowlisted facts only (§6.5)
  policyVersion         String?                             // "premedia-verify.v2"
  processorVersion      String?                             // worker image digest + ffprobe version
  // operational (non-authoritative) failure record, R5 — informational, never a decision
  lastFailureCode       String?                             // e.g. VERIFICATION_EXECUTION_EXHAUSTED
  lastFailureReason     String?                             // e.g. UPLOAD_VERIFICATION_PROBE_TIMEOUT
  lastFailureAt         DateTime?
  objectsClearedAt      DateTime?                           // set only after staged AND sealed objects are confirmed absent (R2)
  assetId               String?  @unique                    // FK Asset onDelete: SetNull
  verificationDeadlineAt DateTime                           // allowance end (§7), immutable
  sealedAt DateTime?  verifiedAt DateTime?  publishedAt DateTime?  finishedAt DateTime?
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt

  @@unique([stagedBucket, stagedKey, generation])           // idempotency authority (direct + folder)
  @@unique([preparedImportItemId, generation])              // nullable → direct rows unaffected
  @@index([status, verificationDeadlineAt])                 // expiry scanner
  @@index([requestedById, status])                          // cap per actor
  @@index([datasetId, status])                              // cap per Dataset
  @@index([currentJobId])
}
```
**Field/state consistency (enforced in the compare-and-swap writes and asserted by tests; no DB CHECK, no raw SQL):**
| status | required non-null | must be null |
| --- | --- | --- |
| PENDING | staged* identity, boundDatasetModality, verificationDeadlineAt | sealed*, contentSha256, verifiedModality, assetId, resultCode |
| SEALED | + sealedKey/Etag/Size/LastModified, sealedAt | contentSha256, verifiedModality, assetId, resultCode |
| VERIFIED | + contentSha256, probe, verifiedModality (= boundDatasetModality), policyVersion, processorVersion, verifiedAt | assetId, resultCode |
| PUBLISHED | + assetId, publishedAt, finishedAt | resultCode |
| REJECTED (media-classification) | resultCode, resultReason ∈ **MEDIA_REASONS**, finishedAt; **a completed probe** (`probe` present, `contentSha256` set) | verifiedModality, assetId |
| REJECTED (`INVALID_RELATIVE_PATH`, path policy) | `resultCode=INVALID_RELATIVE_PATH`, `resultReason=RELATIVE_PATH_INVALID` ∈ **PATH_REASONS**, finishedAt; arises only from VERIFIED, so `probe`, `contentSha256` **and `verifiedModality` are retained** (the media *was* positively verified; the *path hint* is what is refused) | assetId |
| STALE / CANCELED / EXPIRED | resultCode, resultReason, finishedAt | verifiedModality, assetId |
`lastFailure*` may be set on any **non-terminal** row (and is preserved when the row later becomes EXPIRED); it never changes `status`. Terminal rows never change. **Retention (R2):** a terminal non-PUBLISHED row is eligible for purge 30 days after `finishedAt` **and only if `objectsClearedAt IS NOT NULL`**; the purger first re-stats both keys, sets `objectsClearedAt` when both are absent (deleting leftovers first), and leaves rows whose cleanup cannot be established. The surviving audit trail is the `Job` row with its safe `summary {outcome, code, reason, generation}` written at terminalization (no separate tombstone table is added by this contract; if a stricter platform audit convention exists the owner must say so before M26). PUBLISHED rows are kept for the Asset's life.

## 5. State machine

```
 request ──► PENDING ──seal──► SEALED ──positive probe + eligible──► VERIFIED ──publish txn──► PUBLISHED
                │ │              │ │                                   │ │
                │ │              │ └─ negative authoritative probe ─► REJECTED
                │ │              │                                      └ publish-time deterministic rejection (INVALID_RELATIVE_PATH) ► REJECTED
                │ └─ source/Dataset evidence changed ──► STALE (from PENDING, SEALED or VERIFIED)
                └─ canceled / Dataset inactive ──► CANCELED          allowance elapsed ──► EXPIRED   (from any non-terminal)

 Operational failure (probe timeout, process crash, MinIO/DB error, lease loss; attempts exhausted) does NOT change `status`:
   the row stays non-terminal (PENDING/SEALED/VERIFIED), the Job ends FAILED with a distinct code, `lastFailure*` is recorded,
   and the row stays retryable until `verificationDeadlineAt`, after which it becomes EXPIRED.
```
Terminal: `PUBLISHED, REJECTED, STALE, CANCELED, EXPIRED`. Every transition is `UPDATE … WHERE id=? AND status=<from>` (Prisma `updateMany`, count must be 1), and worker transitions also require the Job lease token. Allowed edges only: PENDING→{SEALED,STALE,CANCELED,EXPIRED}; SEALED→{VERIFIED,REJECTED,STALE,CANCELED,EXPIRED}; VERIFIED→{PUBLISHED,REJECTED,STALE,CANCELED,EXPIRED}. A re-upload after any terminal non-PUBLISHED state creates `generation+1`.

### 5.1 Exact meaning of each state
- **VERIFIED:** sealed object classified from its bytes by `premedia-verify.v2` as a publishable class **and** that class equals `boundDatasetModality` (VIDEO) **and** every policy gate passed. Nothing negative is ever stored as VERIFIED.
- **REJECTED — two kinds with distinct meaning, never conflated:** (1) *media-classification rejection* (below) and (2) the frozen **`VERIFIED → REJECTED(INVALID_RELATIVE_PATH)`** path-policy exception, whose reason (`RELATIVE_PATH_INVALID`), Job `errorDetails.kind` (`PERMANENT_REJECTION_PATH`, not `PERMANENT_REJECTION`) and audit summary mark it as a refusal of the request's path, not a verdict on the bytes. Code reads `resultReason` against the two constant sets `MEDIA_REASONS` / `PATH_REASONS`; no consumer may treat every REJECTED row as a classifier result. **If implementation would require that conflation, STOP and return for review.** (Implementation note, not architecture: the web request validates `normalizeAssetRelativePath` up front and answers `422 INVALID_RELATIVE_PATH` before creating a verification, so this edge is defensive only.)
- **REJECTED (media-classification, deterministic negative, R5):** an authoritative **completed** probe (§6.2 step 9) negatively classified the media — unsupported container/codec, still/cover-art-only, malformed/truncated/unreadable *as reported by a completed probe*, size/duration/resolution policy, or verified class ≠ bound modality (e.g. audio-only) — or the deterministic `INVALID_RELATIVE_PATH` at publish. Re-running cannot change the answer. **A timed-out, killed, crashed, output-capped or otherwise non-completed probe is never REJECTED.**
- **STALE (narrow):** the *bound evidence* changed — exactly: (S1) the staged object no longer equals the recorded staging identity at seal time (missing, etag, size, lastModified or versionId differs, or the conditional copy's precondition fails); (S2) the sealed object no longer equals the recorded sealed identity at probe or publish; (S3) the Dataset's `modality` no longer equals `boundDatasetModality` (should be impossible by immutability/M24; defensive). STALE is never used for operational errors, malformed media or a Dataset that became inactive.
- **CANCELED:** requested cancellation (cooperative, Job `cancelRequestedAt`/`CANCELING`), the owning import expired/failed, or the Dataset became archived/deleted (reason `DATASET_INACTIVE`).
- **EXPIRED:** `now` passed `verificationDeadlineAt` (§7) before reaching a terminal state. If a `lastFailure*` record exists the status endpoint reports it as the cause.
- **State-model adjustment for R5 (smallest coherent):** *no new `MediaVerificationStatus` value.* Operational failure is expressed by (a) the Job's terminal `FAILED` with a distinct transient `errorCode`, (b) three informational columns `lastFailureCode/Reason/At`, and (c) a **derived** API status `VERIFICATION_FAILED` (verification non-terminal ∧ current Job `FAILED` with a transient code ∧ `now < verificationDeadlineAt`). A new terminal status was considered and rejected: terminal rows are immutable, but an operational failure must stay retryable inside the allowance, and a terminal `FAILED` would force a re-upload for a fault that is not the user's file.

### 5.2 Web — completion request (direct `POST /api/assets/complete-upload`; folder `POST /api/imports/{preparedImportId}/items/{itemId}/complete`)
After §2 routing selects A2: `statObject` the staged object (identity captured *before* the transaction; size must equal the capability's declared size else `409 UPLOAD_NOT_READY` as today); then one **Serializable** transaction (P2034 retry ×3, `retry-job.ts` precedent): replay lookup by `(stagedBucket, stagedKey, generation)` / `(preparedImportItemId, generation)` → if found return it; cap checks (§8); create `MediaVerification(PENDING, verificationDeadlineAt = now + 30 min)` and `Job(VERIFY_UPLOADED_MEDIA, QUEUED, createdById=actor, input={verificationId,contractVersion})`, set `currentJobId`. After commit: `enqueueExistingJob` (Redis outage ⇒ `QUEUE_DELIVERY_PENDING`, recovery scanner redelivers). The route does **not** delete the staged object and never creates an Asset.

### 5.3 Worker — `processVerifyUploadedMedia(db, jobId, lockToken)` (idempotent per recorded status)
Boundary guard at every step: Job not cancel-requested; Dataset not archived/deleted (else CANCELED); `now < verificationDeadlineAt` (else EXPIRED); `Job.input.verificationId` row's `datasetId/requestedById` equal the Job's.
1. **SEAL** — protocol in §5.4. PENDING → SEALED.
2. **PROBE** — §5.4 P2 then classification (§6). SEALED → VERIFIED or REJECTED (or STALE per S2). The decision, `contentSha256`, `probe`, `policyVersion`, `processorVersion` are written in the **same** CAS.
3. **PUBLISH** (VERIFIED) — one database transaction: re-read verification (status VERIFIED, lease valid, deadline not passed, Job not cancel-requested); re-read Dataset (not deleted/archived; `modality === boundDatasetModality === verifiedModality`, else STALE S3 / CANCELED if inactive); independent `statObject(sealed)` equals the recorded sealed identity (else STALE S2); `assertAssetWritesNotQuiesced` (quiescence ⇒ no write, Job `RETRYING` with `runAfter`, verification stays VERIFIED); `normalizeAssetRelativePath(relativePathHint ?? filename)` (invalid ⇒ REJECTED `INVALID_RELATIVE_PATH`); create `Asset` + subtype using **only persisted verification evidence**: `storageKey = sealedKey`, `checksum = "sha256:" + contentSha256`, `sourceEtag = sealedEtag`, `sizeBytes = sealedSizeBytes`, `mimeType` = container-derived (`video/mp4|video/webm`, never declared), width/height/duration from `probe`, `sourceFingerprint = sha256("a2v1:" + sealedKey + ":" + contentSha256)`; set verification `PUBLISHED, assetId`; folder: link `PreparedImportItem.assetId/completedAt` and write the stable `IMPORT_ITEM_SUCCEEDED` event on the folder's Job (aggregation helper extracted to `packages/domain` so web and worker share one implementation); an in-transaction duplicate returns the existing Asset after the same parent check. M24's trigger remains the DB backstop. After commit: `completeJob`. A crash between commit and `completeJob` resumes on PUBLISHED and only completes the Job.
4. **Terminal side effects:** REJECTED/STALE/CANCELED/EXPIRED ⇒ remove sealed and staged objects (best effort; GC covers leftovers); folder: write stable `IMPORT_ITEM_REJECTED` for REJECTED, STALE/EXPIRED/CANCELED items remain "not completed" (retryable by re-upload) and are reported in `retryable`/`unprocessed` per §9.

### 5.4 Sealing and content-identity protocol (D3)
Identities: **staging identity** `Is = {bucket, key, etag, size, lastModified, versionId?}` from `statObject` at request (§5.2). **Sealed identity** `Ic = {sealedKey, etag, size, lastModified, versionId?}` from an *independent* `statObject` after the copy. **Content identity** = SHA-256 of the exact bytes the probe reads. The ETag is recorded as a *bound observation*, never as the content identity.
- **P1 — conditional seal (PENDING):**
  a. `statObject(staged)` must equal `Is` on every recorded field, else STALE (S1).
  b. `copyObject(source={Bucket, Object: stagedKey, VersionID=stagedVersionId?, MatchETag=stagedEtag, MatchUnmodifiedSince=stagedLastModified}, dest={Bucket, Object: sealedKey})` with `sealedKey = verified-uploads/<datasetId>/<verificationId>/source` (deterministic ⇒ a retried copy rewrites the same key idempotently). A precondition failure (HTTP 412) ⇒ STALE (S1); any other error is transient.
  c. `statObject(sealed)` (independent of the copy response): `size === stagedSizeBytes`, else treat as transient failure and delete the partial sealed object; record `Ic`.
  d. CAS PENDING→SEALED persisting `Ic` and `sealedAt`.
  e. Only after (d): delete the staged object (best effort). Crash before (d) is safe: staged is untouched and the copy repeats.
- **P2 — bounded materialization and probe (SEALED):**
  a. `statObject(sealed)` equals recorded `Ic` (all fields) else STALE (S2).
  b. Refuse if `sealedSizeBytes` > the A2 source cap (100 MiB); stream `getObject(sealed[, versionId])` into a private temp file through a SHA-256 hasher with a byte counter; abort if the count exceeds the recorded size; at end the count must equal `sealedSizeBytes`.
  c. `statObject(sealed)` again must still equal `Ic` (mid-read replacement ⇒ STALE S2).
  d. `ffprobe` runs **only** on the temp file; classify (§6); CAS to VERIFIED or REJECTED persisting `contentSha256` with the decision.
- **P3 — publication:** uses persisted evidence only (§5.3 step 3). The staging key is never read, hashed, referenced by an Asset/event/DTO, or trusted after P1(d). The sealed prefix is writable only by worker credentials; no presigned POST/capability names it.
Residual risk (stated, R4 approved): content identity is established over the bytes the probe read; publication re-binds by sealed-object identity (etag/size/lastModified/versionId) and the persisted SHA-256/probe decision — it does **not** re-hash the object.

### 5.5 Sealed-namespace write protection — R9 APPROVED: M1 (separate prefix-scoped MinIO identities)

**Audit fact (2026-10-06).** Web and worker construct their MinIO clients from the same `MINIO_ACCESS_KEY/SECRET_KEY` (`apps/web/src/lib/providers.ts`, `apps/worker/src/providers/minio.ts`; compose passes the root pair to both). A MinIO root user is not subject to bucket policies, so key naming gives no immutability. M1 removes root from every application process and makes `verified-uploads/` writable by exactly one identity.

#### Identities (three, each least-privilege; none root-equivalent)
Prefix sets: **S** = `verified-uploads/*` (sealed); **T** = `direct-uploads/*` and `prepared-imports/*` (browser-writable staging); **O** = every other key.

| Identity | Used by | Allowed | Explicitly denied (Deny overrides Allow) |
| --- | --- | --- | --- |
| **I-WEB** | web process (incl. presign signing) | `GetObject`, `ListBucket`, `GetBucketLocation` on the bucket; `PutObject`, `DeleteObject`, `AbortMultipartUpload`, `ListMultipartUploadParts` on **T** only | **all** write/delete/multipart/tag/retention/legal-hold on **S**; all write/delete on **O**; every bucket-level admin action (lifecycle, policy, versioning, CORS, create/delete bucket) |
| **I-WORKER** | all existing worker jobs and scanners (mirror, exports, waveform, visualization, text artifacts, orphan/temp cleanup of T and O) | `GetObject`, `ListBucket`, `GetBucketLocation` on the bucket; `PutObject`, `DeleteObject`, multipart verbs on **T** and **O** | **all** write/delete/multipart/tag/retention/legal-hold on **S**; every bucket-level admin action |
| **I-VERIFIER** | *only* the A2 verification processor and the sealed-namespace GC adapter (a second client object, constructed in one module) | `GetObject`, `ListBucket` (prefix-conditioned to S and T), `GetBucketLocation`; `DeleteObject` on **T** (staging cleanup); `GetObject`, `PutObject`, `DeleteObject` on **S** (seal via server-side copy, probe reads, sealed cleanup/GC) | `PutObject`, `AbortMultipartUpload`, tagging/retention/legal-hold on **T**; **everything** on **O**; every bucket-level admin action |
| *root* | the provisioning supervisor only (creates the bucket, identities, policies, lifecycle; verifies) | all | — never given to a web, worker or test process |
Policy form: MinIO IAM policies attached to users/service accounts, with explicit `Deny` statements on `arn:aws:s3:::<bucket>/verified-uploads/*` for the actions `s3:PutObject, s3:DeleteObject, s3:DeleteObjectVersion, s3:AbortMultipartUpload, s3:PutObjectTagging, s3:DeleteObjectTagging, s3:PutObjectRetention, s3:PutObjectLegalHold, s3:BypassGovernanceRetention` **and `s3:ListMultipartUploadParts`** (added after the first S0 rehearsal showed the broad worker allow let I-WORKER read the part list of an in-flight sealed multipart upload) for I-WEB and I-WORKER. Copy needs `PutObject` on the destination, so **copy-to-S is denied by the same statement**. Presigned URLs and POST policies are authorized by MinIO at use time as the *signing identity*, so a capability signed by I-WEB can never write S even if the key field were altered (and an altered key also breaks the signed policy).

**What the browser/web side can do:** upload to T by presigned POST (key fixed by the signed policy), delete staged T keys, read published objects. **What the verifier can do:** read T, delete T, and own S (copy-in, read, delete). **What nobody else can do:** create, overwrite, copy over, delete, tag, lock or multipart-write anything under S.

**Required application changes implied (implementation tasks, not architecture):**
1. **Sealed-owner routing for deletions.** Deleting sealed keys (orphan scan, deleted-Asset/Dataset cleanup, verification cleanup) must use I-VERIFIER: `sweepUnreferencedObjects`/`sweepSingleObject` (and the whole-bucket default scan, `prefixes = [""]`) take a key→client router so any key under S is removed with the verifier client and every other key with I-WORKER; the scanner's reference checker gains the `MediaVerification` rules of §11. Without this, published-Asset and abandoned sealed objects could never be collected.
2. **Config.** New worker-only variables `MINIO_VERIFIER_ACCESS_KEY/SECRET_KEY` (added to the provider-config schema, the secret-redaction list and readiness); `MINIO_ACCESS_KEY/SECRET_KEY` keep their names but carry I-WEB in the web process and I-WORKER in the worker process.
3. **Bucket administration leaves the application.** `ensureBucket` (create bucket) and `ensureTempUploadLifecyclePolicy` (lifecycle) are denied to app identities; they become provisioning-time actions (an ILM rule is itself a deletion mechanism that bypasses object IAM, so no app identity may set one). Worker startup becomes verify-only (bucket exists / lifecycle present).
4. **Web write surface stays minimal** and is pinned by the static audit below.

#### Static audit — baseline recorded 2026-10-06 (to be turned into a failing test)
- **Web (`apps/web/src`), mutating MinIO calls:** exactly three direct sites — `lib/asset-upload.ts:187` `removeObject` (staged cleanup), `lib/imports/local-folder-upload.ts:28` and `app/api/assets/presigned-upload/route.ts:45` `presignedPostPolicy` (both fixed to staging keys) — plus one **transitive** deletion path: `lib/imports/import-cleanup.ts` imports `sweepUnreferencedObjects` from the worker's `queue/minio-orphan-scanner.ts` and calls it with prefix `prepared-imports/<datasetId>/` (T only). No web path writes, copies or deletes under S.
- **Worker (`apps/worker/src`), mutating sites:** `jobs/repository-asset-mirror.ts` (put/remove), `queue/minio-orphan-scanner.ts` (two `removeObject` sites; **default scan prefix is the whole bucket**), `media/minio-compensation.ts`, `media/audio-derivative.ts`, `source/text-boundary-derivative.ts` (remove), `jobs/audio-waveform.ts`, `jobs/visualization.processor.ts`, `jobs/text-source-prepare.processor.ts`, `jobs/export-dataset.ts`, `jobs/bulk-export-selected.ts` (put/remove), and `providers/minio.ts` (`makeBucket`, `setBucketLifecycle`). Deleted-Asset/Dataset cleanup reaches MinIO only through `sweepSingleObject`. `apps/realtime` has no MinIO usage.
- **Acceptance test (failing-by-default):** a scan of `apps/web/src`, `apps/worker/src` and `packages/*/src` for the mutating-method set (`putObject, fPutObject, copyObject, composeObject, removeObject, removeObjects, removeIncompleteUpload, presignedPostPolicy, presignedPutObject, initiateNewMultipartUpload, setBucket*, makeBucket, setObject*`, plus the transitive modules above) must equal this allowlist exactly; any new site fails the test until classified. Constructing a client from `MINIO_VERIFIER_*` is allowed in one module only.

#### Required negative evidence (disposable runtime, **before** any A2 code uses the sealed namespace)
Using each identity's **own** credentials against a sealed key that exists and one that does not: (a) `PutObject` overwrite and create — I-WEB, I-WORKER denied; (b) `CopyObject` with S as **destination** (source a T or O object) — denied; (c) `DeleteObject` and `RemoveObjects` — denied; (d) multipart: `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListMultipartUploadParts` — denied; (e) tagging, retention and legal-hold writes — denied; (f) presign: a presigned PUT URL and a presigned POST signed by I-WEB naming a sealed key are generated successfully (signing is local) and **fail with 403 when used**; a presigned POST for a staged key whose `key` form field is tampered to a sealed key fails; (g) bucket-level admin (lifecycle, policy, versioning, delete bucket) — denied for all three app identities; (h) **positive controls** so denials cannot pass vacuously: I-WEB can upload/delete in T and read S; I-WORKER can write O and read S; I-VERIFIER can copy T→S, read S, delete S and T, and **cannot** write T or O. Every negative result is recorded with the MinIO error code, and the sealed object's ETag/size/lastModified are re-stat'ed unchanged after the whole battery.

#### Residual risk and boundary (stated)
M1 protects the sealed namespace from the web process, the browser and every non-A2 worker code path. A **single compromised worker process holds both I-WORKER and I-VERIFIER** and could still write S; separating the verifier into its own deployment role is a possible later hardening and is not required by this contract. M1 gives no protection if an operator re-introduces a shared/root credential: the readiness check must fail closed if the process's identity can write S (a harmless probe: attempt a conditional `PutObject` of a fixed sentinel key under S with the web/worker identity at startup and require 403; if it unexpectedly succeeds the process fails closed, and the sentinel — an unreferenced object under S — is collected by the sealed-owner GC).

#### Scope of this checkpoint and of the implementation
**No shared-dev or global MinIO credential is changed by this checkpoint** (documentation only). Identity provisioning is first built and proven in the disposable runtime (`release/disposable-http-runtime-plan.md`, step S0); applying M1 to any persistent environment is a separate, explicitly authorized infrastructure change. If any of (1)–(3) above proves impossible, or the negative evidence cannot be obtained, the sealed-immutability claim is **not** made and implementation stops for design review.

## 6. Shared classifier policy `premedia-verify.v2`

One pure module (`apps/worker/src/media/classification-policy.ts`) consumed by this processor **and** the repository path (replacing `classifyProbeOutput`). `policyVersion` and the ffprobe version are persisted on every decision.

### 6.1 Probe invocation (fixed, bounded)
`ffprobe -v error -hide_banner -probesize 10000000 -analyzeduration 5000000 -show_entries format=format_name,duration,size,nb_streams:format_tags=major_brand,compatible_brands:stream=index,codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration:stream_disposition=default,attached_pic,still_image,timed_thumbnails -of json <temp file>`. Limits: A2 uses a lowered `maxProcessMs` of **120 s** and a 100 MiB source cap (policy may only be lowered), output ≤ 64 KiB, existing temp-space limit, no user-controlled argument.

### 6.2 Algorithm (all gates must pass; an allowlisted codec alone is never sufficient)
1. **Container:** `format.format_name` must be exactly `mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`. Anything else (`ogg`, `avi`, `mpegts`, `image2`, `gif`, …) ⇒ REJECTED `UNSUPPORTED_MEDIA/CONTAINER_UNSUPPORTED`.
2. **Picture streams:** a stream is a *picture stream* if `disposition.attached_pic=1` or `disposition.still_image=1` or `disposition.timed_thumbnails=1`, or its codec is an image codec (`mjpeg, png, bmp, gif, webp, tiff, jpeg2000, jpegls`) with `nb_frames ≤ 1`. Picture streams are **never** video tracks.
3. **Usable video track:** `videoTracks = streams where codec_type=video and not a picture stream`. Require ≥ 1 with `width,height ∈ [16, 8192]` and (`nb_frames ≥ 2` or `duration ≥ 0.1 s`).
4. **Codec:** every counted video track's `codec_name ∈ {h264, vp8, vp9, av1}` (HEVC and everything else ⇒ REJECTED `CODEC_UNSUPPORTED`).
5. **Still-image brands (negative evidence only):** if `format_tags.major_brand`/`compatible_brands` contains `heic, heix, mif1, msf1, avif, avis` ⇒ REJECTED `STILL_OR_COVER_ART`. Brands never accept anything.
6. **Class outcome:** (a) `videoTracks ≥ 1` and all gates pass ⇒ class VIDEO (audio streams optional, recorded, unrestricted); (b) no video tracks, ≥ 1 audio stream ⇒ class AUDIO (picture streams ignored); (c) no video tracks, no audio, only picture streams ⇒ `STILL_OR_COVER_ART`; (d) nothing usable ⇒ `UNSUPPORTED_MEDIA`.
7. **Eligibility vs bound modality:** class must equal `boundDatasetModality`. In v1 the only publishable upload class is VIDEO: class AUDIO into the VIDEO Dataset ⇒ REJECTED `ASSET_MODALITY_MISMATCH` (audio-only MP4 **never** publishes as AUDIO under this contract); audio-only into an AUDIO Dataset is not eligible at §2 and stays `415`.
8. **Limits:** size ≤ 100 MiB, duration ≤ policy maximum, ≤ 16 streams ⇒ otherwise REJECTED `INVALID_MEDIA/MEDIA_POLICY_REJECTED`.
9. **Authoritative vs operational outcomes (R5).** A probe is *completed* only when the ffprobe process exited by itself within the 120-s cap with (a) exit status 0 and bounded JSON that parses (the policy then classifies, including "no usable streams" ⇒ REJECTED), **or** (b) a non-zero exit that matches an **exact, characterized, version-pinned demuxer-invalid marker** (below) ⇒ REJECTED `INVALID_MEDIA/MEDIA_UNREADABLE`. Everything else is **non-completed → operational**: timeout/kill at 120 s, termination by signal, spawn failure, output over the 64-KiB cap, non-zero exit without a marker, unparseable output of a zero exit. A non-completed attempt consumes an attempt and is retried in place; when attempts are exhausted the Job ends `FAILED` with `VERIFICATION_EXECUTION_EXHAUSTED` and `lastFailureReason` `UPLOAD_VERIFICATION_PROBE_TIMEOUT` (timeouts) or `UPLOAD_VERIFICATION_PROBE_FAILED` (other non-completions). It is **never** REJECTED. Implementation must confirm the bounded-process helper exposes exit status, signal, timeout and stderr distinctly; if stderr cannot be obtained, case (b) is dropped and every non-zero exit is operational (strictly safer, worse UX).

**G-PROBE acceptance (clarified):** exit 0 with parseable bounded JSON is the **primary** authoritative path. A marker may produce a deterministic REJECTED only if the characterization, run on the pinned worker image and recorded with its exact ffprobe version, shows for that exact string/exit-status pair (i) it occurs for genuinely malformed/truncated *content* fixtures, and (ii) it does **not** occur — by fault injection — for I/O error, permission denied, missing file, truncated-by-infrastructure materialization, disk/tmpfs exhaustion, memory/resource exhaustion, signal kill or timeout. The marker table is a frozen, version-keyed constant (`ffprobeVersion → markers`); a different ffprobe version has **no** markers until re-characterized (all its non-zero exits are operational). A marker whose non-overlap cannot be proven is **dropped**, even if that turns a malformed fixture into an operational failure — the list is never loosened to classify fixtures. Unknown or uncharacterized non-zero exits remain operational verification failures.
10. **Attached-picture handling (two distinct cases):** (i) *genuine usable video plus an attached picture* (a counted video track exists besides picture streams) ⇒ VIDEO may still qualify — picture streams are ignored, not penalized; (ii) *audio or still media whose only video-like stream is attached/cover art* ⇒ never VIDEO (class AUDIO under outcome (b), or `STILL_OR_COVER_ART` under (c)).

### 6.3 Repository path (D7) — characterization first
The repository import keeps accepting audio-only containers as AUDIO (existing contract line) and the existing header-first path (PNG/JPEG/WebP/WAV/MP3/UTF-8 text before any probe). What changes: probe arguments and the container-stream classification use the shared policy so picture streams stop counting as VIDEO (M4A/MP4/FLAC-with-picture/HEIF/AVIF-tile files). Mandatory protocol, executed in the worker image with the real ffprobe, **before** any behavior change:
1. **Characterize**: commit tests that pin today's output for a fixture corpus — MP3 with ID3+cover (header path ⇒ AUDIO), M4A with cover art, MP4 with a video track, MP4 audio-only, FLAC with picture, AVIF/HEIC, WebM, truncated MP4, data-only container — recording the *current* result for each (the M4A-with-cover and HEIF/AVIF rows are expected to expose the defect). These are the "before" evidence with run ids.
2. **Change** the shared policy and repository path.
3. **Diff**: the same corpus re-run; the commit message and `tasks.md` list each row whose result changed and why; every other row must be byte-identical. The offline `classification-boundary` tests keep the old `classifyProbeOutput` cases as the legacy-shape characterization until the function is removed in the same change set.
Historical Assets/Datasets are **never** rewritten; at most a read-only report of Assets whose subtype/MIME disagree may be produced later, outside this increment.

### 6.4 Result codes
Existing route-contract codes are reused: `UNSUPPORTED_MEDIA` (415), `INVALID_MEDIA` (422), `ASSET_MODALITY_MISMATCH` (409), `DATASET_MODALITY_UNRESOLVED` (409), `INVALID_RELATIVE_PATH` (422), `UPLOAD_NOT_READY` (409), `ASSET_WRITES_PAUSED_FOR_MIGRATION` (503). New: `UPLOAD_VERIFICATION_PENDING` (202 / folder commit 409), `UPLOAD_SOURCE_CHANGED` (STALE), `UPLOAD_VERIFICATION_EXPIRED`, `UPLOAD_VERIFICATION_CANCELED`, `UPLOAD_VERIFICATION_LIMIT_REACHED` (429, R6), `UPLOAD_VERIFICATION_BUSY` (503, R6, Serializable retries exhausted); operational Job codes `VERIFICATION_INFRASTRUCTURE_FAILED`, `VERIFICATION_EXECUTION_EXHAUSTED`. Operational reasons (`lastFailureReason`, never the `resultReason` of a REJECTED row): `UPLOAD_VERIFICATION_PROBE_TIMEOUT`, `UPLOAD_VERIFICATION_PROBE_FAILED`, `UPLOAD_VERIFICATION_STORAGE_FAILED`, `UPLOAD_VERIFICATION_LEASE_LOST`. Authoritative sub-reasons (`resultReason`): `CONTAINER_UNSUPPORTED, CODEC_UNSUPPORTED, STILL_OR_COVER_ART, MEDIA_UNREADABLE, MEDIA_POLICY_REJECTED, CLASS_MISMATCH, SOURCE_STAGED_CHANGED, SOURCE_SEALED_CHANGED, DATASET_EVIDENCE_CHANGED, DATASET_INACTIVE, REQUESTED, IMPORT_ENDED, ALLOWANCE_ELAPSED`.

### 6.5 Persisted `probe` (allowlisted facts only; no tags, paths or URLs)
`{ formatName, durationMs, sizeBytes, streams:[{index,type,codec,width,height,picture:boolean}] (≤16), negativeBrandHit:boolean, ffprobeVersion }`.

## 7. Verification allowance (D6)

**Frozen (R1): `VERIFICATION_ALLOWANCE = 30 minutes`, starting at the commit of the PENDING creation transaction (§5.2), immutable, stored as `verificationDeadlineAt`; never reset or extended.**

Derivation from existing conventions (F11): worst-case work for a ≤ 100 MiB object — seal ≤ 2 min, materialize + hash ≤ 2 min, probe cap 120 s, publish seconds — is ≈ 6 min per attempt; `maxAttempts` 3 with two crash recoveries each costing a 5-min lease + 60-s grace ⇒ ≈ 2 × 6 + 3 × 6 ≈ 30 in the extreme case without queue wait, so 30 min covers a normal run with large headroom and *one* crash recovery comfortably; it equals the existing folder `IMPORT_DEADLINE` (30 min), and is half the runaway guard (`JOB_MAX_RUNTIME_MS` 60 min) so the guard never pre-empts it. Configurable only downward (like the other policies), default 30 min. The per-attempt probe cap is 120 s (R8).

Transition semantics (frozen):
- Starts once, at PENDING creation; **never reset or extended** by retry, redelivery, RETRYING, seal, or probe progress.
- Checked at every boundary in §5.3 (before seal, before probe, before the publish transaction, and inside it): `now ≥ deadline` ⇒ CAS to EXPIRED (no publish ever happens after the deadline).
- Scanner `expireStaleMediaVerifications` (modeled on `import-timeout-scanner`, same periodic task cadence): expires non-terminal rows with `verificationDeadlineAt + JOB_RECOVERY_LEASE_GRACE_MS < now` **and** no valid Job lease, so an in-flight step observes its own boundary first; cancels the Job; removes objects.
- **Folder deadline interplay (preserved, not hard-coded to a new duration):** `PreparedImport.deadlineAt` keeps governing (a) refusal of *new* item-completion requests after it and (b) commit when the import has no non-terminal verification. With non-terminal verifications, `failExpiredPreparedImports` must not expire the import before the latest non-terminal `verificationDeadlineAt`, hard-capped at `deadlineAt + 30 min` (a verification can only start before `deadlineAt`); commit remains allowed in that tail only to settle already-requested verifications. Expiry of the import cancels its remaining verifications (`IMPORT_ENDED`).
- Direct upload has no import deadline; the allowance is the only bound after the completion request. The pre-request bound remains the 10-min capability TTL and the 24-h orphan/temp retention.

## 8. Cap: 50 non-terminal verifications per actor and per Dataset (D8, frozen semantics)

- **Counted (non-terminal):** `status ∈ {PENDING, SEALED, VERIFIED}`. **Released** the instant a row CASes to `PUBLISHED, REJECTED, STALE, CANCELED, EXPIRED` (the status column is the only source of truth; there are no counters to drift).
- **Scopes:** (a) per `requestedById` across all Datasets, **and** (b) per `datasetId` across all actors; both must be `< 50` for a new request to be admitted. Limit constant `MEDIA_VERIFICATION_MAX_NON_TERMINAL = 50`, configurable only downward.
- **Replay never consumes a slot:** inside the admission transaction the replay lookup runs first — `(stagedBucket, stagedKey, generation)` for direct, `(preparedImportItemId, generation)` for folder, `generation` = latest. A hit returns the existing record regardless of the cap and creates nothing. A re-upload after a terminal non-PUBLISHED outcome is `generation+1` and counts as a new request.
- **Concurrency-safe enforcement without raw SQL or new tables:** one `Serializable` transaction (isolation level and `P2034` retry ×3 exactly as `retry-job.ts`): replay lookup → `count` (actor) → `count` (Dataset) → create `MediaVerification` + `Job`. Two concurrent admissions at 49 conflict under SSI; the loser retries, observes 50, and is refused. A unique violation (`P2002`) is treated as a replay. Retry exhaustion ⇒ `503 UPLOAD_VERIFICATION_BUSY` (retryable).
- **Before any work exists:** refusal happens inside the same transaction, before the Job row is created and before any enqueue; no Redis/MinIO side effect precedes commit.
- **Refusal:** `429 UPLOAD_VERIFICATION_LIMIT_REACHED` with `{ scope: "ACTOR"|"DATASET", limit: 50 }` and `Retry-After`; the staged object is **not** deleted (it stays protected by the capability window/24-h retention) and a folder item stays uncompleted so the client retries.
- **Folder effect:** a 1,000-item folder of A2-eligible files proceeds in waves of ≤ 50; only A2-eligible items consume slots; the client must back off on 429.
- **Tests required:** replay at cap returns the record; terminal release admits the next; per-actor vs per-Dataset independence; refused request leaves zero Job/verification rows; **and a DB-backed contention test on real PostgreSQL (disposable)** firing enough *distinct* concurrent requests to cross the limit in each scope — ≥ 120 distinct staged objects from one actor into one Dataset; ≥ 120 requests from distinct actors into one Dataset (Dataset scope); ≥ 120 from one actor across several Datasets (actor scope) — proving, by sampling during the run and by a final query, that **committed non-terminal rows never exceed 50 for either scope**, with exactly the surplus refused (`429`) or `503 UPLOAD_VERIFICATION_BUSY`, never over-admitted.
- **G-CAP acceptance evidence (all required, real PostgreSQL, disposable):** in addition to "committed non-terminal rows ≤ 50 per scope at every sampled instant and at the end", the run must establish: (1) **replay consumes no additional slot** (a replay at exactly 50 returns the record, row/Job counts unchanged); (2) **a limit refusal creates no new Job** (Job count for the type unchanged by every refused request); (3) **no orphan PENDING verification without its Job** — after the run every non-terminal row has a non-null `currentJobId` referencing an existing `VERIFY_UPLOADED_MEDIA` Job and every such non-terminal Job references a verification, including under injected failure between the two creates (transaction rolls back both); (4) **actor and Dataset scopes enforced independently** (saturating one scope does not admit past or block the other); (5) **retry exhaustion maps to the approved `503 UPLOAD_VERIFICATION_BUSY`** (forced `P2034` ×3 yields 503, no partial rows); (6) **terminalization releases capacity** — after CASing a row to a terminal status a subsequent request acquires the freed slot, and the count returns to ≤ 50.
- **STOP rule (owner):** if the Prisma/Serializable count-and-create pattern cannot enforce the invariant in that test, implementation **stops and returns for design review**; it must not silently introduce raw SQL, advisory locks, counter rows or any other locking mechanism.
- **Known limit:** DB-level enforcement of the cap is not provided (that would need a trigger — separate G-SQL decision); enforcement is the single admission transaction, which is the only creator of rows.

## 9. Terminal Job / retry matrix (D10)

Mechanism (F12): the retry route retries any `FAILED` Job whose type has a retry context; for this type `extractRetryContext` returns a context **only** when `errorCode ∈ {VERIFICATION_INFRASTRUCTURE_FAILED, VERIFICATION_EXECUTION_EXHAUSTED, RECOVERY_EXHAUSTED, MAX_RUNTIME_EXCEEDED}` **and** the verification is non-terminal with `now < verificationDeadlineAt` (the `errorCode` must be added to the retry-context select). Everything else returns `null` ⇒ `409`. A retry successor carries only allowlisted `{verificationId, contractVersion}` and moves `currentJobId`.

| Outcome | Verification `status` | Job status | `Job.errorCode` (`errorDetails.kind`) | `lastFailure*` / reason | Retryable via lineage | Recovery |
| --- | --- | --- | --- | --- | --- | --- |
| Published | PUBLISHED | COMPLETED | — | — | n/a | — |
| **Authoritative** rejection from a *completed* probe (unsupported container/codec, still/cover-art-only, malformed per a characterized marker, policy limits, class mismatch) | REJECTED | FAILED | the result code, e.g. `UNSUPPORTED_MEDIA` (`PERMANENT_REJECTION`) | `resultReason ∈ MEDIA_REASONS` | **No** | user uploads again (`generation+1`) |
| Path-policy refusal at publish (`VERIFIED → REJECTED`) | REJECTED (path kind; media evidence retained) | FAILED | `INVALID_RELATIVE_PATH` (`PERMANENT_REJECTION_PATH`) | `resultReason=RELATIVE_PATH_INVALID ∈ PATH_REASONS` | **No** | re-upload with a valid name |
| Changed bound evidence (S1/S2/S3) | STALE | FAILED | `UPLOAD_SOURCE_CHANGED` (`STALE_EVIDENCE`) | `resultReason` set | **No** | user uploads again |
| Canceled (user / import ended / Dataset inactive) | CANCELED | CANCELED | — | `resultReason` set | **No** | user uploads again |
| Allowance elapsed | EXPIRED | FAILED | `UPLOAD_VERIFICATION_EXPIRED` (`ALLOWANCE_EXPIRED`) | earlier `lastFailure*` preserved as the cause | **No** | user uploads again |
| **Probe timeout / probe process failure, attempts exhausted (R5)** | **unchanged, non-terminal** | FAILED | `VERIFICATION_EXECUTION_EXHAUSTED` (`EXECUTION_EXHAUSTED`) | code `VERIFICATION_EXECUTION_EXHAUSTED`, reason `UPLOAD_VERIFICATION_PROBE_TIMEOUT` or `UPLOAD_VERIFICATION_PROBE_FAILED` | **Yes**, only while `now < verificationDeadlineAt` | retry route (successor Job) or recovery scanner; otherwise EXPIRED at the deadline. **Never REJECTED.** |
| Other transient failure (MinIO/DB error, lease lost), attempts exhausted | unchanged, non-terminal | FAILED | `VERIFICATION_INFRASTRUCTURE_FAILED` / `RECOVERY_EXHAUSTED` / `MAX_RUNTIME_EXCEEDED` (`TRANSIENT`) | reason `UPLOAD_VERIFICATION_STORAGE_FAILED` / `…_LEASE_LOST` | **Yes**, same window | same |
| Failure within `maxAttempts` | unchanged | RETRYING in place (existing stale/lease logic, `maxAttempts` 3) | — | recorded per attempt | in place | — |
| Quiescence window | VERIFIED | RETRYING with `runAfter` | — | — | in place | resumes at publish |
| Duplicate delivery of the same Job | CAS no-op | unchanged | — | — | — | no second Asset |

API: while the row is non-terminal and its current Job is `FAILED` with a transient code, the status endpoint reports the **derived** status `VERIFICATION_FAILED` with `{ code, reason, retryable:true, retryUntil: expiresAt }`. It is a view, not a stored state, and it keeps the cap slot (§8) until the row is terminal. No path represents an operational failure as a deterministic rejection.

Folder accounting: REJECTED ⇒ stable `IMPORT_ITEM_REJECTED` (counts as `rejected`); STALE/EXPIRED/CANCELED ⇒ item stays unlinked and is counted `retryable` (re-upload possible while the import is open) or `unprocessed`; PUBLISHED ⇒ `IMPORT_ITEM_SUCCEEDED`. Commit while any item's verification is non-terminal ⇒ `409 UPLOAD_VERIFICATION_PENDING` with `{accepted, unchanged, rejected, retryable, unprocessed, verifying}` and the import Job is **not** failed; once none is pending the existing `IMPORT_INCOMPLETE` logic applies.

## 10. API / UX

- `POST /api/assets/complete-upload` and the folder item-complete route: add **202** `{ data: { verification: { id, status:"PENDING", expiresAt, pollAfterMs } } }`; `429 UPLOAD_VERIFICATION_LIMIT_REACHED`, `503 UPLOAD_VERIFICATION_BUSY`; existing 200/201/4xx unchanged.
- **New** `GET /api/uploads/verifications/{verificationId}`: `{ data: { id, status:"PENDING|VERIFYING|VERIFICATION_FAILED|PUBLISHED|REJECTED|STALE|CANCELED|EXPIRED", code?, reason?, retryable?, expiresAt, asset? } }` (`VERIFYING` = SEALED/VERIFIED; `VERIFICATION_FAILED` is the derived operational-failure view of §9). Requester **and** still holding `asset.upload`; dataset `dataset.read` holders may read. Never returns keys, buckets, ETags, hashes or probe internals; `asset` is the existing safe DTO. Foreign/unknown ⇒ 404. HTTP stays 200 for any recorded state.
- Cancel: existing Job cancel route/permission (requester or dataset manager), cooperative at §5.3 boundaries.
- Client: 202 = "not published"; poll with capped backoff until terminal or `expiresAt`; never show an Asset before PUBLISHED; 429 ⇒ back off.
- Capability advertising: `video/mp4` and `video/webm` stay advertised (honored for VIDEO Datasets once A2 ships; advertised-with-415 until then, per owner); `audio/ogg` removed (D4, task **A2-0**, independent of M26, not to land before the rollout window closes unless the owner says otherwise); local-folder file input `accept` narrowed to the supported types.
- OpenAPI: new 202/429/503, new GET, new codes; `docs:validate-openapi` is the gate.

## 11. Staging ownership, cleanup, crash recovery

- **Ownership:** staged key is user-writable until the 10-min capability expires; the sealed key is worker-only and is the Asset object after publish (no rename).
- **Cleanup:** terminal non-PUBLISHED ⇒ delete sealed + staged. The orphan scanner/`temp-upload-cleanup` learn `verified-uploads/` (added to `DEFAULT_TEMP_UPLOAD_PREFIXES`); a **non-terminal** `MediaVerification` (staged or sealed key) protects its objects, a terminal one releases them; `PUBLISHED` objects are protected by the Asset reference as today. Import expiry cascades to pending verifications.
- **Crash matrix:** web dies after commit before enqueue ⇒ recovery scanner redelivers; Redis loses the entry ⇒ same; worker dies mid-seal/probe/after VERIFIED ⇒ lease expiry → in-place retry → resume at recorded status (re-validating sealed identity); dies after publish commit ⇒ only `completeJob`; duplicate delivery ⇒ CAS no-op; duplicate request ⇒ unique-key replay. No path creates an Asset outside the §5.3 step-3 transaction.

## 12. Authorization and security
Capability checks as today at request time (actor equality, dataset binding, `asset.upload`); the worker acts on the verification row and trusts nothing from the browser; `Dataset.modality` re-read at publish. DTO/Job redaction as today (no keys, buckets, ETags, hashes, probe internals). Queue payload `{jobId}` only. MinIO credentials stay in server processes; the browser still receives only the presigned POST. Bounded resources: 100 MiB, ≤ 1,000 items per folder, 120-s probe, cap 50 (§8).

## 13. Integration-test plan (structure frozen; unsupported assumptions not frozen)

Principles: one Dataset per modality; every success case uses a matching Dataset; every case asserts Asset **and** subtype counts across all fixture Datasets; statuses from §6.4/§10; no assertion that audio-only MP4 publishes.

**Audit of the stale suites (not rewritten in this checkpoint):**
- `apps/web/tests/direct-upload/upload-routes.test.ts`: single IMAGE fixture Dataset; "all initial modalities…" uploads video/text/audio into it (invalid under the Dataset-authoritative invariant; video also contradicts the current fail-closed behavior); spawns its own `next start` on 3115 with `MINIO_PUBLIC_ENDPOINT=http://minio:9000` and a CORS test fetching `http://minio:9000/` (compose-only host name); `presign()` hardcodes one `datasetId`; `createDirectUploadActors` creates/cleans one Dataset; the video fixture is a 12-byte fake `ftyp` header.
- `apps/web/tests/local-folder-import/modality-assets.test.ts` + `http-fixtures.ts`: `start()` posts no `modality` (required ⇒ 400); four modalities through one Dataset; own server on 3113. `foundation.test.ts` (offline) asserts the manifest schema accepts `video/mp4` — stays true.

| # | Suite | Dataset | Input | Expected |
| --- | --- | --- | --- | --- |
| 1–3 | complete-upload | IMAGE / AUDIO / TEXT | valid PNG / WAV / text | 201, one matching subtype only; replay 200 |
| 4 | complete-upload | mismatched | WAV→IMAGE, PNG→AUDIO, text→IMAGE | 409 `ASSET_MODALITY_MISMATCH`, zero rows anywhere, object removed |
| 5 | complete-upload | IMAGE | garbage declared PNG; truncated PNG | 415; 422 `INVALID_MEDIA`; no rows |
| 6 | complete-upload | VIDEO, A2 off | real MP4 | 415 (regression guard for the pre-A2 state) |
| 7 | complete-upload (A2) | VIDEO | H.264 MP4, VP9 WebM | 202 → poll → PUBLISHED; one Asset + `videoAsset`; container-derived MIME; **no rows before PUBLISHED**; `checksum` = persisted `contentSha256` |
| 8 | (A2) | VIDEO | fake `ftyp`-only, truncated MP4, HEIC/AVIF, M4A with cover art, MKV/Ogg/AVI declared mp4, HEVC MP4, data-only container | terminal REJECTED with the §6.2 reason; zero rows at every poll; Job FAILED non-retryable; retry route 409 |
| 9 | (A2) | VIDEO | audio-only M4A declared `video/mp4` | REJECTED `ASSET_MODALITY_MISMATCH` |
| 9a | (A2) | VIDEO | genuine H.264 MP4 **with** an attached cover picture | PUBLISHED as VIDEO (picture ignored) |
| 9b | (A2) | VIDEO | audio-only M4A/MP3 whose only video-like stream is cover art | never VIDEO: REJECTED `ASSET_MODALITY_MISMATCH` (class AUDIO) or `STILL_OR_COVER_ART` |
| 9c | (A2, worker image) | VIDEO | probe exceeding 120 s (injected slow ffprobe) and a probe killed by signal | in-place retries, then Job FAILED `VERIFICATION_EXECUTION_EXHAUSTED` with reason `UPLOAD_VERIFICATION_PROBE_TIMEOUT`/`…_FAILED`; verification **not** REJECTED, still non-terminal; derived status `VERIFICATION_FAILED`; a retry succeeds once the probe works, otherwise EXPIRED at 30 min; nothing published or rejected from it |
| 9d | (A2, worker image) | VIDEO | ffprobe non-zero exit with a demuxer-invalid marker (truncated MP4) vs non-zero without a marker | REJECTED `MEDIA_UNREADABLE` vs operational (never REJECTED) |
| 10 | complete-upload | AUDIO | audio-only MP4 declared `video/mp4` | 415 (not eligible); no AUDIO-publication assertion |
| 11 | (A2) | VIDEO | staged object replaced after request, before seal | STALE `UPLOAD_SOURCE_CHANGED` (S1); non-retryable; no rows |
| 12 | (A2) | VIDEO | sealed object tampered between probe and publish | STALE (S2); no rows |
| 13 | (A2) | VIDEO | replay of the same fileId while PENDING / after PUBLISHED | 202 / 200, same record, no duplicates |
| 14 | worker | VIDEO | kill worker at SEALED, VERIFIED, after publish | resumes; exactly one Asset |
| 15 | worker | VIDEO | cancel at PENDING/SEALED; Dataset archived mid-run | CANCELED, objects removed, no rows |
| 16 | (A2) | VIDEO | allowance elapsed (clock-injected) | EXPIRED, no publish after the deadline, objects removed |
| 17 | cap (real PostgreSQL) | VIDEO | ≥ 120 distinct concurrent requests per scope (§8); replay at cap; terminal release; actor vs Dataset independence | committed non-terminal rows never exceed 50 for either scope at any sampled instant or at the end; surplus gets 429/503; replay returns the record; zero extra Job rows; failure ⇒ STOP for design review |
| 17a | sealed namespace | VIDEO | web-identity credentials attempt put/copy-over/delete under `verified-uploads/`; tampered presigned POST naming a sealed key | all refused (§5.5); required before implementation closure |
| 18 | folder | one new Dataset per modality | matching files start→capabilities→complete→commit | exact counts; VIDEO via 202→poll→commit |
| 19 | folder append | wrong-modality file | item rejected; commit 409 `IMPORT_INCOMPLETE`, valid items kept |
| 20 | folder (A2) | VIDEO | commit with a pending item | 409 `UPLOAD_VERIFICATION_PENDING`; Job not failed; commit succeeds after resolution |
| 21 | folder (A2) | VIDEO | import deadline passes with pending items (tail rule §7) | settles within `deadlineAt+30 min` cap or expires; no orphans |
| 22 | unchanged | IMAGE | denied/outsider/read-only, view-url, POST-policy, CORS (runtime MinIO), orphan cleanup, publication conflict | as today |
| 23 | offline | — | policy table tests (picture streams, brands, codecs, dims, frames, timeouts, garbage JSON); repository characterization + diff (§6.3) | pure / worker-image |
Fixtures: small real files generated once **inside the worker image** and checked in with a SHA-256 manifest (H.264 MP4, VP9 WebM, AV1 WebM, HEVC MP4, M4A, M4A+cover, MP3+cover, FLAC+picture, truncated MP4, AVIF/HEIC sample — sourcing recorded if the image's ffmpeg cannot encode it, risk R3).

## 14. Decisions and gates
D1–D11 and R1–R9 are resolved (decision record at the top). Remaining items are **implementation gates**, not architecture questions:

| ID | Item | Needed before |
| --- | --- | --- |
| G-STORAGE | M1 storage-authority matrix proven in the disposable runtime (§5.5 negative evidence, positive controls, static audit test). First deliverable of the runtime work (step S0). | any A2 code that touches the sealed namespace; implementation closure |
| R10 | Approve a **pinned `minio/mc` image digest** (receipt-owned, short-lived, internal-network, no secrets on the command line) as the provisioning tool for identities/policies. Not in the earlier approved image list; the locally present `minio/mc:latest` is unpinned. | S0 |
| R11 | Approve moving bucket creation and lifecycle management from application startup to provisioning (§5.5 change 3). | implementation |
| G-M26 | Exact-byte review and disposable rehearsal of the generated M26 migration (no SQL approved). | any application of M26 |
| G-CAP | Real-PostgreSQL contention proof with the six extra evidence items (§8); stop for design review if it fails. | implementation closure |
| G-PROBE | Marker characterization per §6.2 step 9 (version-pinned, non-overlap proven); exit-0 JSON remains primary. | classifier implementation |
| G-FIX | Fixture corpus generated in the pinned worker image; deterministic AVIF/HEIC negative sample if needed (R3). | integration tests |

## 15. Frozen status and what this checkpoint changed
**A2 architecture/spec: FROZEN. T022: OPEN — A2 implementation pending.** The R9/M1 and G-PROBE/G-CAP/INVALID_RELATIVE_PATH clarifications are acceptance criteria *within* the frozen architecture, not a reopening of it. This checkpoint changed documentation only (this contract, `release/disposable-http-runtime-plan.md`, and the T022 pointer in `tasks.md`). No application code, Prisma schema, generated client, queue contract, route, OpenAPI file, test, M24/M25, launcher pin, rollout execution-package file, G3/G5 artifact or shared-dev resource was touched; M26 does not exist.
