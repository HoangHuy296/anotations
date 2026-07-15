# Phase 5 Validation Quickstart: Direct Upload and Multi-modal Metadata Rows

This guide validates the planned Phase 5 feature after explicit implementation approval. It does not authorize implementation now.

## Prerequisites

- Phase 004 authentication/ownership guards and Phase 005 Dataset/Asset list behavior remain healthy.
- PostgreSQL, Redis, MinIO, web, and worker Compose services are healthy.
- A browser-reachable MinIO endpoint and restrictive CORS origin are configured separately from the server-internal endpoint.
- Server-only configuration supplies MinIO access credentials and upload-capability signing material; neither is exposed to browser code.

## Validation scenarios

### 1. Authorized image upload

1. Sign in as an owner or Dataset manager.
2. Create or select an active Dataset.
3. Request an upload capability for a supported PNG/JPEG/WebP file.
4. Upload the binary only through the returned short-lived URL.
5. Complete with opaque `fileId`.
6. Verify `GET /api/datasets/[datasetId]/assets` includes one READY IMAGE Asset within 10 seconds, and Prisma confirms exactly one ImageAsset row.
7. Verify PostgreSQL contains metadata/reference fields only; MinIO contains the binary.

### 2. Other supported modalities

Repeat the same flow for one supported video, text, and audio object. Verify each result has exactly one matching child row (VideoAsset, TextDocument, or AudioAsset) and no other child row. Confirm `TextDocument.content` remains empty.

### 3. Authorization and disclosure

1. As a non-member, use a known Dataset id to request an upload capability: expect safe `404` and no object/Asset write.
2. As a known read-only member, request an upload capability: expect `403` and no side effect.
3. As a non-member, request `view-url` for a known Asset id: expect safe `404`, no view capability.

### 4. Verification and idempotency

1. Try an unsupported, empty, type-mismatched, expired, or missing upload: expect a safe failure and no published Asset/child row.
2. Send `complete-upload` twice with the same valid `fileId`: verify both responses resolve to the same Asset and one child row only.
3. Simulate a client timeout after the first completion and retry: verify no duplicate object reference or Asset appears.

### 5. Secret and boundary review

Verify normal API responses, browser state, logs, queue payloads, and Dataset asset-list responses omit MinIO credentials, provider tokens, top-level storage keys/buckets, source URLs, and private object metadata. The only exception is the short-lived signed URL and the provider-required fields used transiently for its single POST submission; neither may be persisted or logged.

## Expected commands after implementation

```bash
pnpm typecheck
pnpm --filter @fieldframe/web lint
pnpm --filter @fieldframe/web test:direct-upload
docker compose up --build
```

If integration tests must resolve the Compose-only database host, run them in the Compose network using the established short-lived test-container pattern from Phase 005.

## Expected results

- Supported objects are private in MinIO; PostgreSQL has no binary body.
- Exact authorization status and no-side-effect assertions pass for owner/manager/read-only member/non-member cases.
- All four modalities create exactly one matching child row.
- Replayed completion is idempotent.
- No Job, queue payload, worker process, schema migration, or modality-specific workspace route is introduced.

## Phase 5 execution record (2026-07-14)

- The approved direct-transfer exception is limited to backend-generated, short-lived, object-scoped MinIO presigned POST policies and view URLs. Upload completion capabilities are authenticated-encrypted with server-only signing material. The POST policy binds its exact object key, exact accepted content type, size range, and expiry; no credential is returned.
- Required configuration names are `MINIO_PUBLIC_ENDPOINT`, `MINIO_CORS_ALLOWED_ORIGIN`, and `UPLOAD_CAPABILITY_SECRET`. They are server/runtime configuration; values are not placed in browser code or this document. `UPLOAD_CAPABILITY_SECRET` must contain at least 32 bytes of entropy; local tests inject one only into the process environment. MinIO CORS must return the configured origin and allow `POST`.
- `pnpm --filter @fieldframe/web test:direct-upload` passed in a short-lived Compose-network container using a temporary process-only upload signing secret: 8 tests passed, 0 failed. Coverage uses real PostgreSQL and MinIO, Prisma assertions, opaque-cookie authentication, IMAGE/VIDEO/TEXT/AUDIO child rows, replay, expiration/tampering, denied no-side-effects, invalid media, authorized view URLs, strict POST-policy MIME/size rejection, CORS POST preflight, publication-failure orphan cleanup, published-object retention on replay, and HTTP Dataset asset-list visibility of a READY IMAGE within 10 seconds after completion.
- `pnpm typecheck`, `pnpm --filter @fieldframe/web lint`, and `pnpm --filter @fieldframe/web build` passed. The production build needs the normal unsandboxed Turbopack worker-port permission.
- Audit confirmed no changes to `prisma/schema.prisma`, `prisma/migrations/`, generated Prisma client, `apps/worker/`, queue contracts, Redis Job state, or modality-specific workspace routes.
