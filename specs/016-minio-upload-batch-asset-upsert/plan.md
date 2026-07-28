# Implementation Plan: MinIO Upload + Batch Asset Upsert

**Branch**: `016-minio-upload-batch-asset-upsert` | **Date**: 2026-07-28 | **Spec**: [spec.md](./spec.md)

## Summary

Implement the first real repository-import worker processor. It receives only
the existing durable Job ID, claims/reloads PostgreSQL state, revalidates
source access, lists and downloads files server-side, mirrors supported files
to private MinIO, and batch-reconciles Assets using deterministic
`sourceFingerprint`. PostgreSQL remains canonical; Redis/BullMQ only delivers
`{ jobId }`.

## Technical Context

**Language/Version**: TypeScript 5.9; Node.js 22.

**Primary Dependencies**: Existing Next.js 16 App Router, Prisma 6, Zod 4,
BullMQ, MinIO SDK, and Phase 014 provider adapters. No dependency planned.

**Storage**: PostgreSQL for Job/Asset metadata and lifecycle; MinIO for binary
objects; Redis/BullMQ for transport only.

**Testing**: Node built-in runner with `tsx`; controlled Compose PostgreSQL,
passworded isolated Redis, MinIO, GitHub fixture, Gitea fixture, and private
worker integration.

**Target Platform**: Private Node worker in Compose; public Next.js API only
for existing safe status and asset access.

**Project Type**: pnpm monorepo web application plus private worker.

**Performance Goals**: Batch-level progress; policy-sized non-final batches
between 50–200 candidates; no unbounded manifest/object buffering.

**Constraints**: No schema migration, no new dependency, no browser provider
access, no binary PostgreSQL storage, no raw Job/provider/object data in UI or
Redis, and no worker HTTP endpoint.

**Scale/Scope**: Repository files are streamed/reconciled in bounded batches;
full clone, persisted manifest, repository sync history, thumbnails, and UI
features beyond existing safe progress are out of scope.

## Constitution Check

| Gate | Result |
| --- | --- |
| Next.js public boundary/private worker | Pass — no worker HTTP route. |
| PostgreSQL canonical Job state | Pass — all lifecycle/progress uses lock-token PostgreSQL mutations. |
| Queue payload `{ jobId }` only | Pass — no manifest, credential, or file data enters Redis. |
| Private binary storage | Pass — bytes stream only to MinIO; PostgreSQL stores metadata. |
| Retry/idempotency | Pass — existing Dataset/fingerprint uniqueness and deterministic object key are reconciled. |
| Authorization and secrecy | Pass — source connection is re-resolved/decrypted only in worker memory; safe status remains existing API. |
| Phase discipline | Pass — no clone/browser worker endpoint/new schema assumed. |

## Design Plan

### Phase 0 — establish bounded worker contracts

1. Audit the actual Phase 015 safe Job input and distinguish repository import
   Jobs from existing local-folder `IMPORT_DATASET` Jobs.
2. Define server-only candidate, source-access, fingerprint, deterministic key,
   batch-policy, safe outcome, and compensation helpers.
3. Replace the current receipt-only repository import path without changing
   local-folder behavior or queue payload shape.

### Phase 1 — source access and provider iteration

1. Reuse `RepositoryProviderAdapter.listFiles()` and `downloadFile()` only
   after lock claim.
2. Revalidate private `SourceConnection` status/ownership/token and provider
   access in worker memory.
3. Resolve public GitHub/Gitea roots from server configuration/allowlist rather
   than `Job.input`; fail safely if no approved public resolution exists.
4. Apply root-path, file count, total-byte, MIME/modality, and per-file policy
   limits before source/download work.

### Phase 2 — mirror and Asset reconciliation

1. Stream each eligible file to a deterministic private MinIO key and verify
   object metadata.
2. Compute fingerprint from immutable source provenance.
3. Reconcile Asset by Dataset/fingerprint with Prisma, set `MIRROR_TO_MINIO`,
   storage/provenance metadata, and upsert only the matching child row.
4. Use scoped guarded cleanup after failed durable publication; never delete a
   referenced or out-of-scope key.

### Phase 3 — durable worker lifecycle

1. Process policy-sized batches; heartbeat around long work and check cancel
   before each batch/candidate boundary.
2. Update aggregate PostgreSQL counters/stage/progress with current lock token
   and emit one safe JobEvent per batch.
3. Complete with allowlisted aggregate summary, or fail/cancel through current
   lifecycle helpers. Preserve partial safe counts.

### Phase 4 — validation and runtime evidence

1. Unit-test fingerprint/key/modality/child reconciliation and summary
   redaction.
2. Run real Compose provider → worker → MinIO → PostgreSQL tests for happy
   path, mixed modality, retry/redelivery, cancellation, source invalidation,
   MinIO/Prisma failure, and cleanup idempotence.
3. Test authorized asset view/status and foreign concealment; snapshot isolated
   PostgreSQL IDs, Redis prefix, and MinIO prefix for denials/failures.
4. Run Prisma validation, typecheck, lint, builds, and scope audit; restore
   normal Compose runtime.

## Project Structure

```text
apps/worker/src/
├── jobs/
│   ├── import-dataset.ts             # repository processor orchestration
│   ├── repository-import-source.ts   # access/list/download policy
│   ├── repository-asset-mirror.ts    # MinIO mirror + guarded cleanup
│   ├── repository-asset-upsert.ts    # Prisma Asset/child reconciliation
│   ├── source-fingerprint.ts
│   └── job-claim-lock.ts
├── providers/minio.ts
├── source/source-access.ts
└── queue/queue-router.ts

apps/worker/tests/repository-import/
├── fingerprint.test.ts
├── asset-upsert.test.ts
├── import-processor.test.ts
└── worker-minio-runtime.test.ts

apps/web/tests/repository-import-worker/
└── safe-status-and-asset-access.test.ts

specs/016-minio-upload-batch-asset-upsert/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
```

**Structure Decision**: Keep browser APIs unchanged and place all provider,
binary, and long-running work in the private worker. Existing local-folder
import handling remains explicitly separate inside the shared Job type router.

## Post-Design Constitution Check

Pass. The plan uses existing Prisma schema/lock lifecycle and MinIO provider,
keeps secrets and binary data server-side, and contains no unapproved raw SQL,
dependency, migration, queue-contract, or future UI work.

## Complexity Tracking

No constitution violation requires justification.
