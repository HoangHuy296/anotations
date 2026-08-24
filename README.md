# Annotation Platform

Annotation Platform is a multi-modal data annotation product for image, video,
text, and audio assets. Teams import data from direct upload, a local folder,
or a remote Git-style repository (GitHub, Gitea, GitLab, Hugging Face);
organize it into datasets; label it by hand or with AI-assisted
pre-annotation; and export the result as a portable, sanitized manifest.

The system is one product repository with two runtime processes: a Next.js
App Router application that owns every browser-facing page and API, and a
private BullMQ worker that owns repository cloning and other long-running
processing. PostgreSQL (via Prisma) is the single source of truth for
metadata and Job lifecycle state; Redis/BullMQ is a transport that only ever
carries a Job ID; MinIO holds every binary object.

> Governance note: [`AGENTS.md`](AGENTS.md) is the authoritative rulebook for
> anyone (human or agent) changing this codebase — architecture boundaries,
> data rules, security rules, and phase discipline are enforced there and in
> [`docs/`](docs/). This README describes the product; AGENTS.md governs how
> it is built.

## Contents

- [Core capabilities](#core-capabilities)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Build and static checks](#build-and-static-checks)
- [Test suites](#test-suites)
- [Security rules](#security-rules)
- [API documentation](#api-documentation)
- [Useful commands](#useful-commands)
- [Delivery status](#delivery-status)

## Core capabilities

### Accounts, datasets, and access control

- Session-based authentication (signup, login, logout, refresh, password
  change) backed by hashed passwords and revocable `AuthSession` rows.
- Platform-level `UserRole` (`ADMIN`, `MANAGER`, `LABELER`, `REVIEWER`) plus
  per-dataset `DatasetMember` roles (`OWNER`, `MANAGER`, `LABELER`,
  `REVIEWER`) so dataset access can be scoped independently of a user's
  platform role.
- `Dataset` is the central organizing entity: every Asset, Annotation, Label,
  Job, and AI task is scoped or traceable to a Dataset. Ownership and
  authorization are always resolved server-side; a client-supplied owner ID
  is never trusted.

### Importing data

Three ways to get assets into a dataset, all producing the same durable
`Asset`/`AssetVersion` rows regardless of source:

- **Direct upload** — the browser requests a short-lived, object-scoped MinIO
  presigned POST from the backend, uploads straight to MinIO, then calls
  `complete-upload` so the backend verifies the object and writes Asset
  metadata. The browser never sees MinIO credentials.
- **Local folder import** — a bulk "prepare, upload, commit" flow
  (`PreparedImport` / `PreparedImportItem`) for uploading a folder tree of
  mixed-modality files as one batch, with per-item fingerprinting and a
  commit signal so a partial or duplicate upload can't corrupt the dataset.
- **Remote repository import** — connect a source with a `SourceConnection`
  (GitHub, Gitea, GitLab, or Hugging Face; encrypted token or OAuth), run a
  lightweight preflight against the provider, then enqueue a
  `CLONE_REPOSITORY` / `IMPORT_DATASET` Job. The private worker clones the
  repository, filters files by include/exclude pattern, mirrors or
  externally-references blobs into MinIO (`DatasetSourceMode`:
  `MIRROR_TO_MINIO`, `EXTERNAL_REF`, or `HYBRID_CACHE`), and upserts Assets in
  batches. Datasets created from a repository can later be re-synced, with
  per-asset `AssetSyncStatus` (added/modified/deleted/renamed/conflict
  upstream) surfaced back to the user.
- Every import path shares one durable `Job`, one retry lineage, and the same
  idempotent, deterministic-object-identity guarantee: a duplicated delivery
  or an authorized retry reuses or reconciles existing assets instead of
  creating duplicates.

### Multi-modal annotation workspace

One workspace route selects its rendering engine from `Asset.modality` —
there is no per-modality route. Current engine status:

| Modality | Status | What it supports today |
| --- | --- | --- |
| **Image** | Full editing | Konva-based canvas; draw, move, and resize bounding boxes; assign labels; per-image status/properties panel; optimistic-concurrency autosave. |
| **Video** | Full editing | Frame-accurate bounding-box tracks (`VideoObjectTrack`) with keyframes, linear interpolation between keyframes, per-track labels/colors, and a temporal-label timeline for scene/segment-level tags. |
| **Audio** | Read-only preview | Streams audio from a presigned view URL and shows waveform-readiness state; annotation editing (transcription, diarization, classification) is schema-ready but intentionally not exposed yet. |
| **Text** | Read-only preview | Document served as a read-only Asset; the future text-annotation contract (NER, relations, classification, sentiment) is deferred. |

- `Annotation.geometry` is the single canonical shape for every annotation
  type. Bounding boxes are the first fully editable geometry; the schema is
  already future-ready for polygon, circle, point, polyline, segmentation
  mask, and keypoint geometries, and for classification, tracking,
  scene/event, text (NER/POS/relation/classification/sentiment/intent), and
  audio (transcript/diarization/speaker ID/acoustic event) annotation types
  across all four modalities.
- `Annotation.revision` enforces optimistic concurrency on every autosave:
  a client submits the revision it last read, the update only applies if it
  still matches the persisted value, and the revision increments on success —
  a stale write is rejected instead of silently overwriting newer work.
  Viewport pan/zoom and in-progress drag state stay client-only and are
  never persisted mid-gesture; commits happen only at action boundaries
  (mouse up, drag end, label assignment, delete, explicit/autosave).
- Labels are dataset-scoped (`Label`), with an optional modality restriction,
  a `LabelScope` (object, segmentation, keypoint, classification, action,
  event, scene, entity, POS, relation, sentiment, intent, transcript,
  speaker, acoustic event, custom), a color, and an optional hotkey.

### AI-assisted pre-annotation

- A user selects one or more assets and an active `AiModel`, and requests
  pre-annotation. The request returns immediately as a trackable `AiTask`
  bound one-to-one to a durable `Job`; the AI provider is resolved from the
  selected model, never from an unrelated repository-source setting.
- The worker submits the task, polls the provider on a bounded
  exponential-backoff schedule with a hard timeout, and checks for user
  cancellation before every provider call — a single worker owns a task's
  polling progress at a time via the same PostgreSQL claim-lock the Job
  system uses.
- Successful predictions are written as new `Annotation` rows with
  `source: AI` and a draft/needs-review status, tagged with model provenance
  and confidence in `properties`. AI output is strictly additive: it never
  modifies or deletes a manually created annotation.
- Task status (`QUEUED` → `RUNNING` → `SUCCEEDED` / `FAILED` / `CANCELED`) and
  failure reasons are always retrievable, so a request never leaves a user
  guessing.

### Durable Job system and progress UI

- Every asynchronous operation — repository clone, dataset import, repository
  sync, dataset export, thumbnail generation, video metadata/frame
  extraction, audio waveform generation, AI submit/poll — is one kind
  (`JobType`) of a single common `Job` model. There are no separate
  `ImportJob`/`ExportJob`/`RepositorySyncJob` tables.
- PostgreSQL is the only Job authority: state, stage (a granular pipeline
  step such as `CLONING_REPOSITORY`, `SCANNING_FILES`, `WRITING_ASSETS`,
  `EXPORTING_DATASET`), progress counts, priority, attempts, and
  idempotency key. BullMQ/Redis transports only `{ jobId }`.
- The worker claims a Job with a PostgreSQL lock (`lockedBy`/`lockToken`/
  `lockedUntil`/heartbeat), so two workers can never process the same Job
  concurrently, and a stalled worker's lock is safely reclaimed.
- Users watch Job progress, per-item counts (processed/succeeded/failed/
  skipped), and a `JobEvent` log (leveled `DEBUG`/`INFO`/`WARN`/`ERROR`) from
  the Jobs UI. An authorized retry creates or reuses one successor Job linked
  to the failed predecessor (`retryOfJobId`); the failed Job stays immutable
  history.

### Dataset export

- A bounded, versioned JSON export (`exportManifestSchemaVersion: "1"`)
  packages dataset metadata, assets, and annotations into one downloadable
  manifest via a durable `EXPORT_DATASET` Job.
- The manifest is sanitized on the way out: any key that looks like a
  credential, token, secret, storage key/bucket, or session value is
  stripped, and raw URLs are excluded — only safe, structural metadata
  reaches the export file.

### Production hardening and lifecycle management

- **Rate limiting** on AI task, import, and export requests (per-minute caps,
  configurable via environment variables).
- **Pagination caps** — every list endpoint enforces a hard maximum page
  size regardless of what a caller requests.
- **Job recovery** — a stale/stalled Job (worker crash, missed heartbeat,
  exceeded max runtime) is detected and safely recovered or failed by a
  background scanner, never left stuck.
- **Retention and garbage collection** — scheduled worker jobs age out old
  `JobEvent` rows, sweep orphaned MinIO objects (dry-run by default; a live
  sweep is a deliberate, explicitly authorized action), clean up expired
  temporary uploads, and reconcile deleted Assets/Datasets with their MinIO
  objects.

## Architecture

```text
Browser
  → Next.js backend API
      → PostgreSQL / Prisma (authoritative metadata and Job state)
      → BullMQ / Redis ({ jobId } transport only)
      → MinIO (private binary objects, via short-lived presigned URLs)
  → Private worker
      → PostgreSQL / Prisma
      → MinIO
      → private source provider (GitHub / Gitea / GitLab / Hugging Face / AI)
```

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Next.js backend API | Authentication, authorization, validation, metadata writes, durable Job creation, enqueue requests, all authorized application APIs | Repository cloning, long-running processing, provider/storage credentials reaching the browser |
| PostgreSQL / Prisma | Canonical domain metadata; every Job's input, lifecycle, attempts, result metadata, and terminal outcome | Binary asset or artifact bytes |
| Redis / BullMQ | Delivery of `{ jobId }` to the private worker | Canonical Job state, full Job input, binary data |
| MinIO | Source binaries, cloned repository content, derived assets, export artifacts | Browser-visible credentials or authoritative domain state |
| Private worker | Resolving Job state from PostgreSQL, cloning repositories, long-running processing, persisting safe result updates | Serving browser requests; a second public API |

`Asset.modality` is the sole source of truth for selecting a workspace
engine — there is no modality-specific route. `Dataset.primaryModality` is
only a UI default; it never constrains what a Dataset can contain.

See [`docs/architecture.md`](docs/architecture.md) for the full architecture
lock, [`docs/job-system.md`](docs/job-system.md) for the Job model,
[`docs/bullmq-postgres-job-flow.md`](docs/bullmq-postgres-job-flow.md) for
submission/retry/reconciliation flow, and
[`docs/clone-repository-plan.md`](docs/clone-repository-plan.md) for the
private worker's clone and secret boundaries.

## Data model

Key Prisma models (see [`prisma/schema.prisma`](prisma/schema.prisma) for the
full schema):

- **User / AuthSession** — accounts and revocable sessions.
- **Dataset / DatasetMember** — the central organizing entity and its
  per-user roles.
- **Asset / AssetVersion** — one row per imported item, modality-tagged, with
  a per-modality detail table (**ImageAsset**, **VideoAsset**, **TextAsset**,
  **AudioAsset**) and source/cache provenance fields for repository-backed
  assets.
- **Annotation** — the canonical, revisioned annotation record for every
  modality and geometry type, with video-specific fields (`frameIndex`,
  `trackId`, keyframe/interpolation) and text-relation self-references.
- **VideoObjectTrack / AudioSpeaker** — per-modality grouping entities for
  tracked objects and diarized speakers.
- **Label** — dataset-scoped label taxonomy with scope, color, and hotkey.
- **Job / JobEvent** — the single durable async-work model and its event log.
- **SourceConnection / ExternalRepository** — encrypted provider credentials
  and normalized repository identity for remote imports.
- **PreparedImport / PreparedImportItem** — the local-folder bulk-upload
  staging flow.
- **AiModel / AiTask** — the AI provider registry and the business-level
  AI unit of work tied one-to-one to a Job.

## Tech stack

- **Web app** — Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS
  4, Zustand, React Hook Form + Zod, `react-konva`/Konva for the canvas.
- **Worker** — Node.js/TypeScript, BullMQ, `ioredis`, `minio` client, Zod.
- **Data layer** — PostgreSQL, Prisma ORM (`packages/domain` and
  `packages/queue` hold shared types and the minimal queue contract).
- **Infrastructure** — Redis (BullMQ transport), MinIO (object storage),
  Docker Compose for local orchestration.

## Repository layout

```text
apps/
├── web/     # Next.js UI, Route Handlers, Server Actions (public backend API)
└── worker/  # private BullMQ worker; no HTTP server

packages/
├── domain/  # shared domain types, validation, and contracts
└── queue/   # minimal { jobId } queue publisher/consumer contract

prisma/      # PostgreSQL schema and migrations
docs/        # approved architecture and operations docs
specs/       # per-feature specs, plans, and tasks (spec-driven delivery)
```

## Getting started

### Prerequisites

- Node.js 22+
- pnpm 11.10+
- Docker Engine + Docker Compose v2

### Configure local environment

Create an ignored `.env` from the example and replace all placeholder
secrets:

```bash
cp .env.example .env
```

For Compose, keep `DATABASE_URL_DOCKER` pointed at `postgres:5432`. For host
Prisma commands, use a host-reachable URL (normally `localhost:5433` when
using the checked-in Compose mapping). Never commit `.env` or expose provider
credentials to browser code.

### Start providers with Compose

```bash
docker compose up -d postgres redis minio
docker compose ps
```

Apply migrations from the repository root. If your `.env` uses the
container-only hostname, provide a host-reachable `DATABASE_URL` for this one
command rather than editing secrets into source control.

```bash
pnpm db:validate
pnpm db:generate
pnpm exec prisma migrate deploy
```

Start the full stack when you want Compose to own web and worker:

```bash
docker compose up --build
```

Web health is available at `/api/health`. The worker has no HTTP listener.

### Run locally in development

Use local Next.js when Compose is only providing PostgreSQL, Redis, and
MinIO:

```bash
pnpm run dev
pnpm run dev:worker
```

Open `http://localhost:3000`. If Compose web already owns port 3000, either
stop it or use Next.js on port 3001:

```bash
docker compose stop web
pnpm run dev
```

If Next reports a permission error acquiring `.next/dev/lock`, a container
has left build output owned by another UID. Fix only this generated
directory:

```bash
sudo chown -R "$USER:$USER" apps/web/.next
rm -f apps/web/.next/dev/lock
```

## Build and static checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Test suites

Unit/schema tests:

```bash
pnpm --filter @annotationplatform/web test:local-folder-import
pnpm --filter @annotationplatform/worker test:queue
```

The web app also has scoped suites per feature area (auth/ownership, dataset
metadata, direct upload, job queue, workspace, source connections,
repository preflight/import, AI, rate limiting, pagination, health, OpenAPI
contract) — run `pnpm --filter @annotationplatform/web run` with no
arguments to list them, or see `apps/web/package.json`.

Full queue integration is intentionally opt-in and must use passworded Redis
bound to `127.0.0.1`, a non-zero dedicated DB, and an isolated key prefix:

```bash
QUEUE_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 \
REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=annotationplatform-test REDIS_TEST_PREFIX=annotationplatform-test \
pnpm --filter @annotationplatform/worker test:queue
```

Do not use the normal `annotation-platform` queue prefix for integration
tests. Use the existing password from your ignored `.env`; never put it in
shell history, documentation, or source code.

## Security rules

- Browser uploads use only short-lived, object-scoped presigned POST forms;
  the browser never receives MinIO credentials, provider tokens, or any
  server-only configuration.
- Dataset and Job authorization is resolved server-side; a client-supplied
  owner ID is always ignored.
- A denied request must not create Assets, Jobs, JobEvents, objects, or
  queue deliveries.
- Provider and storage errors are sanitized before reaching the browser, and
  export output strips anything that looks like a credential.

See [`AGENTS.md`](AGENTS.md) for the full, binding set of security and data
rules that govern this codebase.

## API documentation

The full REST API surface (authentication, datasets, assets, labels,
annotations, media, jobs, AI, repository import) is defined as OpenAPI in
[`specs/api/`](specs/api/openapi.yaml). Build and browse it locally:

```bash
pnpm docs:build          # validate, bundle, and generate a static Swagger UI
pnpm docs:validate-openapi
pnpm docs:bundle-openapi
pnpm docs:swagger-ui
```

## Useful commands

```bash
pnpm db:generate
pnpm db:validate
pnpm db:migrate
pnpm db:studio
docker compose logs -f web worker
docker compose down
```

## Delivery status

This product is built as a sequence of locked, approved phases — see
[`docs/phases.md`](docs/phases.md) for the phase-gate process and
[`specs/`](specs/) for every feature's spec, plan, and tasks. As of this
writing, delivered feature areas span architecture lock and core schema
(001–002); project foundation, auth, and dataset/label/asset metadata
(003–006); the BullMQ/PostgreSQL Job system and progress UI (007–009);
local folder import (010); image labeling with optimistic locking, autosave,
batch navigation, and export (011–012); source connections, provider
preflight, and repository import (013–016); the annotation API foundation
and video/audio asset readiness (017–018); video annotation (019); AI
integration (020); and production hardening plus garbage collection (021).

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/phases.md`](docs/phases.md) for the locked architecture and
implementation sequence.
