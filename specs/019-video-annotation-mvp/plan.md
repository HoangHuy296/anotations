# Implementation Plan: Video Annotation MVP

**Branch**: `019-video-annotation-mvp` | **Date**: 2026-07-29 | **Spec**: [spec.md](./spec.md)

## Summary

Implement revision-guarded manual VIDEO annotation on the existing shared
workspace. Reuse `VideoObjectTrack` and `Annotation`, add only the minimal
approved track revision/metadata schema support if the audit proves it is
missing, expose bounded safe read and mutation contracts, derive linear
bounding-box interpolation without persistence, and add a timeline-driven
Video engine with conflict-aware autosave. Manual mutations remain synchronous
PostgreSQL transactions and create no Jobs or queue deliveries.

## Technical Context

**Language/Version**: TypeScript 5.x, Next.js App Router, React 19, Node.js 22  
**Primary Dependencies**: Prisma, PostgreSQL, Zod, existing React workspace components, react-konva where already used  
**Storage**: PostgreSQL for metadata/revisions; private MinIO for video bytes; Redis/BullMQ transport only for existing background workflows  
**Testing**: Existing Node test runner/Vitest suites, authenticated HTTP integration tests, workspace UI tests, Prisma validation, web/worker builds  
**Target Platform**: Linux Docker Compose runtime and modern desktop browsers  
**Project Type**: Next.js web application plus private worker  
**Performance Goals**: Bounded annotation responses and timeline DOM; smooth seek/overlay rendering for normal fixtures; no unbounded complete video annotation graph  
**Constraints**: Opaque-cookie auth; concealed authorization; no browser provider access; no binary proxy; exact `{ jobId }` queue payload; no manual-edit Job side effects; schema changes require separate approval  
**Scale/Scope**: One VIDEO Asset at a time, bounded tracks/keyframes/temporal labels, long-video reads via pagination or time windows; IMAGE/VIDEO/AUDIO/TEXT shared workspace remains intact

## Constitution Check

*GATE: Must pass before research and again after design.*

- **I. Architecture** — PASS. Uses the existing Next.js boundary, shared
  workspace route, and private worker; no public worker endpoint.
- **II. Durable state/retry lineage** — PASS. PostgreSQL owns annotation state;
  manual edits create no Job; existing BullMQ data remains `{ jobId }`.
- **III. Canonical annotation/workspace state** — PASS. Geometry remains
  canonical, revision domains are explicit, and `Asset.modality` selects the
  engine.
- **IV. Private storage/security** — PASS. Video is private MinIO with a
  short-lived capability; DTOs exclude storage and credentials.
- **V. Validation/testing/phase discipline** — PASS with migration gate.
  Zod, authenticated tests, rollback/race evidence, and build validation are
  required. Any additive schema change needs explicit approval before coding.

## Phase 0 — Research and audit

1. Audit the current Prisma `VideoObjectTrack`, `Annotation`, `VideoAsset`,
   `Label`, and exact enum/index definitions.
2. Audit Phase 017 annotation service, revision conflict/error mapping,
   permission matrix, concealment policy, workspace read DTOs, and route naming.
3. Confirm whether track `revision`, `annotationType`, `interpolationMode`, and
   `(trackId, timestampMs)` uniqueness/indexes can be added safely. Record
   existing-row backfill/default behavior and obtain migration approval only if
   required.
4. Confirm video view-capability and direct-MinIO browser flow, bounded media
   metadata, and current Video workspace read-only components.
5. Resolve the exact bounded read strategy: pagination or timestamp window.

## Phase 1 — Design and contracts

1. Define safe DTOs for Video Asset, track, keyframe, temporal label, derived
   interpolation, revisions, and conflict states.
2. Define strict Zod schemas for track lifecycle, keyframe lifecycle,
   temporal-label lifecycle, timestamps, normalized bounding boxes, and bounded
   custom properties.
3. Define one canonical server-side service for authorization, concealment,
   validation, transaction boundaries, revision checks, and projections.
4. Define and test the fixed API route adapters documented in
   `contracts/video-annotation-api.md` as thin wrappers over that service.
5. Define interpolation behavior for boundaries, occlusion, incompatible or
   deleted keyframes, exact timestamps, unreliable fps, and disabled mode.
6. Define timeline/UI state and autosave conflict behavior without duplicating
   server authorization logic.

## Phase 2 — Implementation slices

1. Add approved minimal track schema support and constraints only after the
   migration gate passes; preserve existing data and Phase 017 semantics.
2. Implement the shared Video annotation read service and safe DTO projection.
3. Implement atomic track lifecycle and track revision guard.
4. Implement atomic keyframe lifecycle using the track revision only.
5. Implement temporal-label lifecycle using Annotation revision only.
6. Implement shared interpolation derivation and bounded read/pagination or
   time-window behavior.
7. Connect thin authenticated route adapters and typed browser clients.
8. Extend the Video engine: playback, timeline, track/keyframe controls,
   temporal labels, interpolation preview, bounded rendering, and conflict UI.
9. Add per-resource autosave, navigation flush, reload reconciliation, and no
   forced stale retry.

## Phase 3 — Verification and closure

1. Run unit geometry/time/interpolation/projection tests.
2. Run authenticated owner/member/foreign/malformed/cross-Dataset HTTP tests.
3. Run revision races, rollback, duplicate timestamp, track deletion, and
   independent-resource concurrency tests.
4. Run Video workspace UI tests and long-video bounded-read tests.
5. Run Phase 017 image, audio, import, local-folder, and queue regressions.
6. Run Prisma validate/generate, web typecheck/lint/build, worker checks, and
   `git diff --check`.
7. Audit redaction, no-side-effect behavior, architecture, scope, and normal
   Compose restoration. Update `quickstart.md` and task evidence only from
   executed results.

## Project Structure

### Documentation

```text
specs/019-video-annotation-mvp/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/video-annotation-api.md
└── checklists/requirements.md
```

### Source code

```text
apps/web/src/
├── app/(app)/workspace/[datasetId]/[assetId]/       # shared route/engine selection
├── app/api/assets/[assetId]/video-annotations/      # thin read adapter
├── app/api/assets/[assetId]/video-object-tracks/    # thin track adapter
├── app/api/video-object-tracks/[trackId]/           # track mutation adapter
├── app/api/video-object-tracks/[trackId]/keyframes/ # keyframe create adapter
├── app/api/video-keyframes/[annotationId]/          # keyframe update/delete
├── app/api/assets/[assetId]/temporal-labels/        # temporal create adapter
├── app/api/temporal-labels/[annotationId]/         # temporal update/delete
├── src/lib/annotations/                             # shared service/projection
├── src/lib/validation/                              # Zod contracts
├── src/lib/workspace/                               # interpolation/read model
├── src/components/workspace/video-engine.tsx
└── src/components/workspace/                         # timeline, panels, conflicts
apps/web/tests/
├── annotations/video-annotation*.test.ts
├── workspace/video*.test.tsx
└── auth-ownership/video-annotation*.test.ts
prisma/schema.prisma                                 # only if approved migration
```

**Structure Decision**: Keep the existing Next.js App Router and shared
workspace. Route handlers remain thin; server-only annotation services,
validation, projections, and interpolation live under `apps/web/src/lib`.
The private worker is not extended for manual annotation mutations.

## Complexity Tracking

| Potential exception | Why needed | Simpler alternative rejected because |
|---|---|---|
| Minimal additive `VideoObjectTrack` migration | Current model lacks the track revision and interpolation metadata required for atomic keyframe locking | Reusing `Annotation.revision` would couple unrelated keyframes and violate the approved two-domain concurrency contract |
| Bounded timeline query (pagination or time window) | Long videos cannot safely render an unbounded annotation graph | Loading every keyframe/label would create unpredictable response size and DOM cost |
