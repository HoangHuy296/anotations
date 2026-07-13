# Fieldframe Agent Governance

## Architecture authority

The authoritative Phase 0 architecture lock is documented in:

- `docs/architecture.md`
- `docs/job-system.md`
- `docs/bullmq-postgres-job-flow.md`
- `docs/clone-repository-plan.md`
- `docs/phases.md`

The earlier `docs/architecture/` baseline and its ADRs are historical context.
They do not authorize decisions that conflict with this file or the Phase 0
documents.

## Product boundary

Fieldframe is an image annotation product. The public application is a Next.js
App Router application. It owns browser-facing pages and APIs, authentication,
authorization, validation, metadata writes, durable Job creation, and enqueue
requests.

The private worker is a separate execution process in the same product
repository. It owns repository cloning and other long-running processing. It
is not a public backend and must never serve browser requests.

Do not create a separate public frontend, Express/Nest/Fastify API, or
microservice that duplicates the Next.js backend API boundary.

## Required architecture

| Boundary | Required responsibility |
| --- | --- |
| Next.js backend API | Validate, authorize, write metadata, create durable Jobs, enqueue `jobId`, and expose authorized application APIs. |
| PostgreSQL with Prisma | Source of truth for domain metadata, Annotation state, and every Job's input, lifecycle, attempts, result metadata, and terminal outcome. |
| Redis with BullMQ | Queue transport only. Every queue payload contains only `{ jobId }`; it is never an authoritative Job store. |
| MinIO | Private storage for source binaries, cloned repository content, derived assets, and export artifacts. |
| Private worker | Resolve Job state from PostgreSQL, clone repositories, perform long-running processing, and persist safe state/result updates. |

Use Prisma for database access. Do not use raw SQL unless explicitly approved.

## Non-negotiable data rules

- A common PostgreSQL `Job` is the source of truth for every asynchronous
  workflow. Do not create `ImportJob`, `ExportJob`, or `RepositorySyncJob`
  tables.
- Do not use Redis as a Job state store and do not put full `Job.input` in
  BullMQ/Redis.
- Do not store binary data in PostgreSQL. Store binary objects in MinIO and
  persist only safe object metadata/references in PostgreSQL.
- Make retries idempotent. A retry uses the same durable Job and must not
  create a duplicate asset or artifact.
- `Dataset` is the central entity for imported and processed assets.
- `Asset.modality` selects the workspace engine. Do not create workspace routes
  by modality.
- `Annotation.geometry` is the canonical shape. `Annotation.version` is
  required on every autosave/update and must reject stale overwrites.

## Security rules

Never expose provider tokens, MinIO credentials, Redis credentials, database
credentials, encrypted secrets, private repository URLs, or server-only
configuration through:

- browser code, props, Zustand, local/session storage, URLs, logs, or public
  errors;
- queue payloads;
- MinIO object metadata accessible to the browser.

All provider and MinIO access is server-side only. Browser code accesses only
authorized application routes and never calls private providers directly.

## Implementation rules

- Use absolute TypeScript imports such as `@/lib/...`.
- Keep server logic out of UI components.
- Use Zod for request bodies, Server Action inputs, form validation, and export
  parameters.
- Keep shared types in `src/types`, business logic in `src/lib`, Route Handlers
  for browser-facing APIs, and Server Actions for same-origin form mutations.
- Do not add npm packages without explicit permission. Before requesting one,
  state its purpose, existing alternative, and bundle/server impact.
- Do not introduce a workaround mock where the real dependency belongs in an
  earlier approved phase.

## Canvas rules

The annotation canvas uses `react-konva`.

- Persist geometry in original image coordinates; keep viewport state separate.
- Do not update React state or persist data continuously during drag or
  transform loops.
- Commit only at action boundaries: mouse up, drag end, transform end, delete,
  label assignment, explicit save, or versioned autosave.
- Bounding boxes are the first editable geometry. Polygon, keypoints,
  segmentation, and classification remain future-ready through canonical
  `Annotation.geometry`.

## Phase discipline

Do not skip phases or implement later phases early. Before every phase, report
what will be built, files created, files modified, and risks. After every
phase, stop and report:

1. Files created
2. Files modified
3. Commands to run
4. Environment variables needed
5. Database migration changes
6. Known limitations
7. Next recommended phase

Do not delete or rewrite `.env`, `.env.local`, database migrations, or
generated Prisma files without explicit user approval. Keep all credentials out
of documentation and reports.
