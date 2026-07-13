# Fieldframe Architecture Lock

## Status and scope

**Status: Accepted for Phase 0.** This document is the architecture authority for work begun after Phase 0 approval. It locks responsibilities and data ownership only; it does not introduce runtime infrastructure, dependencies, database migrations, Docker files, or worker code.

The prior [architecture baseline](./architecture/README.md) and its [ADRs](./architecture/adrs/README.md) remain historical implementation context. Where they conflict with this document, this document wins. A material future change requires a new approved architecture decision.

## Approved system boundaries

```text
Browser
  → Next.js backend API
      → PostgreSQL / Prisma (authoritative metadata and Job state)
      → BullMQ / Redis ({ jobId } transport only)
      → MinIO (private binary objects)
  → Private worker
      → PostgreSQL / Prisma
      → MinIO
      → private source provider
```

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Next.js backend API | Authentication, authorization, validation, metadata operations, durable Job creation, and enqueue requests | Repository cloning, long-running processing, public provider or storage credentials |
| PostgreSQL / Prisma | Canonical domain metadata, durable Job lifecycle/input/result metadata, audit-safe state | Binary asset or artifact bytes |
| BullMQ / Redis | Delivery of `{ jobId }` to the private worker | Canonical Job state, full Job input, binary data |
| MinIO | Private source, clone, derived-asset, and export bytes | Browser-visible credentials or authoritative domain state |
| Private worker | Repository cloning, long-running processing, retry-safe work, and durable Job updates | Browser request serving or a duplicate public API |

The private worker belongs to the same product repository but runs as a private execution process. The public product remains the Next.js application; do not add a separate public backend, frontend, or modality-specific workspace application.

## Locked implementation structure

Phase 1 will adopt a pnpm workspace in this single product repository. This is
the target structure only; Phase 0 does not create or move these directories.

```text
apps/
├── web/                         # Next.js UI and public backend API
└── worker/                      # private BullMQ worker; no HTTP server

packages/
├── domain/                      # shared domain types, validation, and contracts
└── queue/                       # minimal queue publisher/consumer contract

prisma/                          # PostgreSQL schema and migrations
docs/                            # approved architecture and operations docs
```

- `apps/web` owns all browser routes, Route Handlers, and Server Actions.
- `apps/worker` may consume only the minimal `{ jobId }` queue contract and
  must read all authoritative work state from PostgreSQL.
- Shared packages must not contain credentials, provider clients, MinIO
  credentials, browser state, or a second authority for Job state.
- MinIO, Redis, PostgreSQL, and Compose configuration are runtime concerns;
  they are introduced in Phase 1, not created in this structure-lock phase.

## Data ownership

### Job lifecycle authority

PostgreSQL is the only source of truth for every Job. A Job has one durable identity, kind, lifecycle state, input, result metadata, attempts, idempotency data, timestamps, and safe audit data. Import, export, and repository synchronization are kinds of this common Job; they must not have separate Job tables.

BullMQ/Redis transports only the durable Job identity:

```text
{ jobId }
```

The worker always reads the Job from PostgreSQL before acting and records state or result changes back there. Queue retention, retries, events, and progress are operational signals, never the authoritative record.

### Binary-object authority

MinIO stores all binary bytes. PostgreSQL stores object references and safe metadata such as content type, checksum, size, retention policy, and provenance only. The application must not store binary values in database rows, use public filesystem paths for private artifacts, or return object credentials to a browser.

Each Job retry reuses the durable Job identity and checks its existing result and deterministic object identity before creating an object. A completed or previously created object must be reused or safely reconciled instead of creating a duplicate asset or artifact.

### Dataset centrality

Dataset is the central organizational entity for imported and processed work. Assets, annotations, and Jobs are scoped or traceable to a Dataset. Provenance records source context without retaining provider tokens or object-storage credentials.

### Workspace selection and annotation concurrency

`Asset.modality` is the sole source of truth for selecting the workspace engine. All assets open through one workspace route; the route selects an appropriate engine from the asset's recorded modality instead of branching application routing by media type. An absent or unsupported modality must result in a safe unsupported state, not a guessed engine.

`Annotation.geometry` is the canonical shape for every annotation. Labels, display properties, and derived UI state must not replace or reinterpret it as the authoritative shape. `Annotation.version` is the required optimistic concurrency value for every annotation update or autosave:

1. A client submits the expected current version with its authorized geometry update.
2. The durable update succeeds only when that version equals the persisted version.
3. A successful update increments the persisted version.
4. A stale update is rejected; the client must reload canonical geometry and version rather than overwriting newer work.

Viewport pan, zoom, in-progress pointer state, and other transient canvas interaction remain outside canonical annotation data. Persist at semantic action boundaries only.

## Security and trust rules

1. Browser clients call only authorized Next.js application routes.
2. Provider access, MinIO access, Redis access, and database access are server-side only.
3. Tokens, private URLs, MinIO credentials, Redis credentials, database credentials, encrypted values, and server-only configuration must not enter props, client state, URLs, logs, public errors, or queue payloads.
4. The backend validates and authorizes every request before writing metadata or creating a Job.
5. The private worker receives no browser requests and obtains work only from an authorized queue delivery plus the durable Job lookup.
6. Provider and storage errors are sanitized before reaching the browser.

## Explicit prohibitions

- Do not clone a repository in the Next.js backend API.
- Do not store binary content in PostgreSQL.
- Do not let Redis or BullMQ replace PostgreSQL Job state.
- Do not put full Job input, tokens, credentials, or binary content in a queue payload.
- Do not create `ImportJob`, `ExportJob`, or `RepositorySyncJob` tables.
- Do not create duplicate binary objects on retry.
- Do not create a separate workspace route for each asset modality.
- Do not create Phase 1 infrastructure, mocks, dependencies, Docker assets, schema changes, or worker code during Phase 0.

## Follow-on architecture documents

- [Job system](./job-system.md) defines the common Job lifecycle.
- [BullMQ/PostgreSQL flow](./bullmq-postgres-job-flow.md) defines submission, transport, retry, and reconciliation.
- [Repository clone plan](./clone-repository-plan.md) defines private worker clone ownership and secret boundaries.
- [Phases](./phases.md) defines the approval and reporting gate.
