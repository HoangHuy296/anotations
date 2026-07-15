# Implementation Plan: Direct Upload and Multi-modal Metadata Rows

**Branch**: `006-direct-upload-multi-modal-metadata-rows` | **Date**: 2026-07-14 | **Spec**: [spec.md](./spec.md)

## Summary

Implement a controlled direct-to-MinIO upload flow for an already authorized Dataset. The public backend authenticates, authorizes, creates a short-lived object-scoped presigned POST capability, verifies the transferred private object, derives MIME/modality server-side, then transactionally publishes one READY Asset plus exactly one matching child metadata row. Browser access remains forbidden except for the narrowly approved presigned upload/view capability; credentials and private object metadata remain server-only, apart from transient provider-required signed POST fields.

## Technical Context

**Language/Version**: TypeScript 5; Next.js App Router 16; Node 22.  
**Primary Dependencies**: Existing Prisma client, Zod, MinIO SDK, Node `crypto`, and server-only authorization modules; no new package.  
**Storage**: PostgreSQL/Prisma for metadata only; private MinIO for bytes; Redis/BullMQ unused by this synchronous, bounded flow.  
**Testing**: Node/tsx HTTP integration tests with Prisma assertions; no raw SQL.  
**Target Platform**: Existing local Docker Compose and deployed browser/web/MinIO topology.  
**Project Type**: pnpm monorepo; Next.js application with private worker.  
**Performance Goals**: Capability issuance and completion verification are bounded metadata operations; a valid completion becomes visible in the Dataset list within 10 seconds under normal local services.  
**Constraints**: Existing schema is source of truth; no binary in PostgreSQL; no credentials, source/object metadata, or server configuration in browser responses; only server-generated short-lived presigned URLs and their transient provider-required POST fields may call MinIO from a browser; no raw SQL; no new dependencies without approval; no Job/queue/worker processing.  
**Scale/Scope**: One file and one Asset per completion; conservative initial MIME support; metadata extraction scaffold only; no multipart upload, folder upload, preview/transcode, OCR, waveform, frame extraction, or upload-intent table.

## Constitution Check

| Gate | Pre-design result | Evidence |
| --- | --- | --- |
| Next.js owns public API | PASS | All three routes are public application Route Handlers. |
| PostgreSQL remains authoritative | PASS | It stores only Asset/child metadata and idempotency lookup; no queue state is introduced. |
| MinIO owns bytes | PASS | Transfer and view capability target private object storage; bytes are never read into PostgreSQL. |
| Browser credentials/provider boundary | PASS with approved controlled exception | Browser receives only a short-lived object-scoped signed URL generated after backend authorization; no MinIO credential, listing, console, or broad provider access. |
| Dataset authorization root | PASS | Request and completion re-check `asset.upload`; view checks `dataset.read` against the Asset Dataset. |
| Idempotency | PASS | Deterministic server key + signed completion capability + existing unique Asset object-reference constraint. |
| Job/queue boundary | PASS | No Job, full queue payload, Redis state, worker work, or long-running processing. |
| Schema discipline | PASS | Existing Asset and child models are reused; no migration planned. |

**Post-design re-check**: PASS. Data model, contracts, and quickstart retain every gate above. Before implementation, add the approved controlled-exception wording to the Architecture Lock/AGENTS governance text so the source of authority matches this plan.

## Authorization and publication design

1. `presigned-upload` resolves `getSessionActor()`, validates input, requires active Dataset `asset.upload`, assigns a random nonce and deterministic private object key, signs a short-lived POST policy plus opaque `fileId`, and returns no top-level object key or bucket.
2. Browser transfers bytes directly only through that URL and its provider-required signed form fields. Those fields are transient, are never persisted/logged, and are not separate application metadata. MinIO is private; CORS permits only the configured app origin and constrained methods/headers.
3. `complete-upload` resolves the actor, verifies opaque `fileId` signature/purpose/expiry/actor/Dataset and rechecks `asset.upload`. Its strict request schema never accepts a browser object key, bucket, modality, owner, or checksum.
4. The backend uses server credentials to `stat`/boundedly inspect the expected object. It verifies size; derives accepted MIME/modality; computes safe fingerprint context; and rejects unsupported/mismatched content.
5. Before creation, resolve an existing Asset by the deterministic private reference. If found in the same authorized Dataset with its matching child, return it as a replay. Otherwise use one Prisma transaction to create Asset `READY` and the single required child row.
6. If verification/transaction fails, publish no partial metadata. Attempt private server-side orphan cleanup without exposing object identity.
7. `view-url` resolves Asset + Dataset authorization and generates one short-lived object-scoped viewing URL. It returns no separate key/credential.

## Planned files and boundaries

```text
apps/web/src/app/api/assets/
├── presigned-upload/route.ts
├── complete-upload/route.ts
└── [assetId]/view-url/route.ts
apps/web/src/lib/
├── upload-capability.ts          # server-only signed capability and key derivation
├── upload-verification.ts        # bounded MIME/modality detection and metadata scaffold
├── asset-upload.ts               # idempotent Prisma publication transaction
├── providers.ts                  # reuse/extend server-only MinIO client
└── validation/upload.ts          # Zod request validation
apps/web/tests/direct-upload/
├── helpers.ts
├── upload-routes.test.ts
├── authorization.test.ts
└── idempotency-and-secrets.test.ts
packages/domain/src/provider-config.ts  # add validated public presign endpoint/signing config only if needed
compose configuration and .env.example  # documented endpoint/CORS configuration; names only, no secrets
docs/architecture.md and AGENTS.md      # approved controlled presigned-URL exception
specs/006-direct-upload-multi-modal-metadata-rows/
```

## Delivery sequence

1. Record the approved capability exception in architecture governance before endpoint code.
2. Define server-only configuration for internal MinIO, browser-reachable presign endpoint, allowed browser origin, and upload capability signing secret; validate it without exposing values.
3. Add Zod input schemas, server-only capability signing, deterministic key derivation, and bounded verifier/unit tests.
4. Implement the three authorized route handlers and private MinIO operations.
5. Implement idempotent Prisma Asset + child publication using the existing schema and transaction boundary.
6. Configure restrictive MinIO CORS and validate direct browser transfer from the application origin.
7. Add full HTTP integration coverage, Prisma no-side-effect assertions, secret-response review, typecheck, lint, and Compose validation.

## Project Structure

```text
apps/
├── web/                    # browser UI and public authenticated API routes
│   ├── src/app/api/assets/
│   ├── src/lib/
│   └── tests/direct-upload/
└── worker/                 # unchanged; no HTTP and no upload work in this phase
packages/
└── domain/                 # provider configuration validation only if required
prisma/                     # unchanged schema and migrations
specs/006-direct-upload-multi-modal-metadata-rows/
```

**Structure Decision**: Reuse the public Next.js backend and existing server-only provider/authorization modules. No separate upload service, frontend, provider client package, or modality-specific workspace route is created.

## Complexity Tracking

| Exception | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| Browser presigned URL capability | Required to transfer binary directly without passing bytes through the application | A proxy violates the approved feature flow; provider credentials/public bucket violate security rules. |
