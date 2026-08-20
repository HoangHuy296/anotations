# Implementation Plan: Video and Audio Readiness

**Branch**: `018-video-audio-read-asset` | **Date**: 2026-07-29 | **Spec**: [spec.md](./spec.md)

## Summary

Phase 018 adds per-Asset VIDEO metadata readiness and AUDIO waveform readiness
while extending the shared workspace shell to select an engine by the
server-resolved `Asset.modality`. The public application creates/reuses one
durable Job per eligible Asset and delivers only `{ jobId }`. The private worker
claims that Job, reads its private MinIO source, reconciles safe metadata, and
for audio writes one private versioned waveform derivative. The shared shell,
not ImageCanvas, owns modality selection; non-IMAGE Assets never enter the
image engine.

## Technical Context

**Language/Version**: TypeScript 5.9, Node.js 22, Next.js App Router 16  
**Primary Dependencies**: Prisma, Zod, BullMQ/ioredis through `@annotationplatform/queue`, MinIO client, React/Konva; approved worker image tooling gate for `ffprobe`/`ffmpeg`  
**Storage**: PostgreSQL canonical metadata/Job state; Redis/BullMQ transport only; private MinIO binaries/derivatives  
**Testing**: Node test runner + tsx, controlled Compose PostgreSQL/Redis/MinIO/web/worker tests, browser-facing opaque-cookie HTTP tests  
**Target Platform**: Linux Compose development/runtime; browser workspace  
**Project Type**: Next.js public app plus private worker in a monorepo  
**Performance Goals**: bounded per-Asset work; one source object and at most one canonical waveform derivative per current source identity; UI remains responsive during media processing  
**Constraints**: queue payload exactly `{ jobId }`; one Asset per Job; no credential/raw source/storage data in DTOs, events, queue, or UI; no browser provider access; video/audio source bytes stay private  
**Scale/Scope**: Phase 018 only—media readiness, VIDEO workspace, AUDIO readiness surface, and controlled evidence; no sync scheduler, delete propagation, browser credential storage, or audio editing

## Constitution Check

### Pre-design gate — PASS with recorded implementation gates

- **Architecture boundary**: PASS. Next.js remains the public authorization,
  scheduling, and safe-read boundary. The worker remains private and serves no
  HTTP.
- **Durable state and queue contract**: PASS. PostgreSQL Job is canonical;
  every media delivery is exactly `{ jobId }` and one Job contains one Asset.
- **Privacy and authorization**: PASS. Existing opaque sessions, Dataset guards,
  private MinIO, and short-lived view capability remain mandatory. Tokens,
  lock tokens, bucket/key values, raw tool output, and infrastructure config are
  excluded from public projections.
- **Workspace state**: PASS. The shared shell chooses IMAGE/VIDEO/AUDIO/TEXT
  engines from server-resolved modality. ImageCanvas receives IMAGE-only props.
  Durable video edits use `Annotation.revision`; playback/viewport are client
  state.
- **Schema/dependency/raw-SQL**: PASS only if implementation follows the audit:
  current `Asset.durationMs`, `VideoAsset`, `AudioAsset.waveformKey`, existing
  `VideoObjectTrack`, and annotation temporal fields are first evaluated. No
  migration, new npm package, or raw SQL is authorized by this plan. A worker
  image change for `ffprobe`/`ffmpeg` requires recorded approval before use.

### Post-design gate — PASS

Research confirms the existing schema can represent the MVP: `Asset` holds
duration/current source identity; `VideoAsset` and `AudioAsset` are singleton
children; `AudioAsset.waveformKey` is the canonical private derivative
reference; safe derivative version/source identity belongs in approved safe
metadata. This avoids a migration for the MVP. Any requirement for stronger
database uniqueness than existing Asset/Job boundaries is a separate schema
approval, not an implementation shortcut.

## Project Structure

### Documentation

```text
specs/018-video-audio-read-asset/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── media-processing.md
│   └── workspace-engines.md
└── tasks.md                 # Generated later by speckit-tasks
```

### Source Code

```text
apps/web/src/
├── app/api/assets/[assetId]/media-processing/
├── components/workspace/
│   ├── workspace-engine.tsx
│   ├── image-engine.tsx
│   ├── video-engine.tsx
│   ├── audio-engine.tsx
│   └── text-engine.tsx
├── lib/media-processing/
├── lib/workspace/
└── types/

apps/worker/src/
├── jobs/
│   ├── video-metadata.ts
│   ├── audio-waveform.ts
│   └── media-process.ts
├── media/
│   ├── policy.ts
│   ├── source-materialization.ts
│   ├── subprocess.ts
│   └── waveform.ts
└── queue/queue-router.ts

packages/queue/src/
└── job-contract.ts
```

**Structure Decision**: Reuse the public app/private worker boundary. Shared
workspace read services stay under `apps/web/src/lib/workspace`; modality
engines are presentation components, and neither engine nor ImageCanvas owns
authorization or durable media scheduling.

## Delivery Plan

### 018.1 — Audit and contract lock

Audit JobType values, queue routing/recovery, current child fields, source
fingerprint/checksum authority, Job idempotency, Asset commit boundaries,
worker image, and current subprocess helpers. Record exact outcomes in
`research.md`; verify and record the `ffprobe`/`ffmpeg` worker-image approval
before any image change.

### 018.2 — Media scheduling and safe projections

Define processor-version/request identity constants and a canonical
`ensureMediaProcessingJob` boundary. It authorizes the actor, revalidates an
eligible single Asset/current source identity, creates or reuses the durable
Job transactionally, and enqueues only after commit. Add safe readiness
adapters and reconcile eligible pre-018 Assets without changing existing import
payloads.

### 018.3 — Worker media safety foundation

Add approved media tooling to the worker image, bounded process execution,
job-scoped temporary materialization, cancellation checks, finite policy,
safe errors, and exact cleanup. Worker source access remains private and all
results are claim-token guarded.

### 018.4 — Video metadata processor

Route `EXTRACT_VIDEO_METADATA`, reload the Job/Asset after claim, validate
VIDEO/current source, inspect private media, validate output, atomically
reconcile VideoAsset/Asset metadata, and complete/fail/cancel with the active
lock token. Include retry, stale fingerprint/lock, and redaction evidence.

### 018.5 — Audio waveform processor

Route `GENERATE_AUDIO_WAVEFORM`, validate AUDIO/current source, extract safe
metadata, generate bounded versioned waveform peaks, upload one immutable
attempt object, atomically reconcile AudioAsset/waveform reference, and
compensate only an exact unreferenced object. Cover retry, cancellation, stale
lock/fingerprint, and duplicate delivery.

### 018.6 — Modality-selected workspace

Replace the current Image-only fallback in `WorkspaceEngine` with explicit
IMAGE/VIDEO/AUDIO/TEXT engine dispatch. Add shared server-side modality reads;
never pass VIDEO/AUDIO/TEXT records to ImageCanvas. Implement the requested
VIDEO player/canvas/timeline/sidebar/toolbox/bottom controls and revision-safe
track/keyframe/temporal editing. Provide an AUDIO waveform/readiness surface
and retain IMAGE shapes; mask is visibly scaffolded/read-only.

### 018.7 — Controlled evidence and closure

Run unit, PostgreSQL, MinIO, isolated Redis, two-worker, cancellation,
stale-fingerprint, HTTP authorization/redaction, repository/local-folder
regression, workspace, build, and scope-audit suites. Record only executed,
non-secret evidence and restore the normal Compose namespace.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Worker image media tooling | Required to inspect private VIDEO/AUDIO source and generate a waveform without browser/provider access | Browser-side media inspection would expose private source and violate the architecture lock |
| VIDEO engine beside Image engine | Asset modality must select an engine and video needs frame/timeline semantics | Routing VIDEO through ImageCanvas would mix incompatible state and cause the current unavailable-engine failure |
