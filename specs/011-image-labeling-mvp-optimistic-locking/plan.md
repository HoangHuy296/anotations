# Implementation Plan: Image Labeling MVP and Optimistic Locking

**Branch**: `011-image-labeling-mvp-optimistic-locking` | **Date**: 2026-07-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-image-labeling-mvp-optimistic-locking/spec.md`

## Summary

Deliver a safe public registration/login entry flow plus the first usable image-labeling loop inside the existing shared Dataset workspace: authorized image preview, normalized manual bounding boxes, selection/edit/delete/relabel interactions, safe image description and label management, image navigation, and conflict-aware autosave. The design reuses the existing opaque HTTP-only cookie / PostgreSQL AuthSession model, existing `Annotation.revision` and `Asset.revision` fields, permission matrix, authorized asset view capability, Label taxonomy, and `Asset.modality` workspace-engine selection. No JWT, data-model change, migration, queue processing, or new dependency is required.

## Technical Context

**Language/Version**: TypeScript with the repository's current Next.js App Router and Node/tsx test environment.

**Primary Dependencies**: Existing React, `react-konva`/Konva, Zod, Prisma client, Tailwind, and existing UI components; no new package.

**Storage**: PostgreSQL is canonical for AuthSession lifecycle, Asset description/revision, Label taxonomy, Annotation geometry/revision, and authorization metadata. MinIO remains binary storage behind authorized short-lived image view capabilities. Redis/BullMQ are not used for authentication or workspace state.

**Testing**: Existing Node built-in test runner with tsx for authorization/service/HTTP integration tests; component and geometry-unit tests using current repository conventions; controlled Compose PostgreSQL/MinIO where browser-facing view/capability behavior is verified.

**Target Platform**: Desktop-first authenticated browser workspace; responsive layout without touch-first drawing gestures in this MVP.

**Project Type**: Web application with server-rendered authorization/data loading, browser canvas interaction, Route Handlers, and Server Actions.

**Performance Goals**: Fit an image and display existing overlays promptly after authorized preview acquisition; maintain usable pan/zoom and selection with at least 100 visible annotations; preserve 100-image result pages and full-Dataset filename search for at least 250 test Assets.

**Constraints**:

- `Asset.modality` selects the engine; preserve the shared workspace route.
- Persist normalized original-image geometry only; viewport transforms are never persisted.
- `Annotation.geometry` remains canonical and every mutable annotation operation uses the current optimistic-lock value.
- Autosave starts only after 1.5 seconds of inactivity and conflicts never overwrite newer state.
- All authorization comes from the current opaque session and Dataset permissions; browser owner, Dataset, Asset, label, or version claims are verified server-side.
- Browser receives only authorized view capabilities, never MinIO/provider credentials, storage keys, raw internal state, or binary response data.
- No new package, external source-connection work, worker processor, Redis state, or modality-specific route.
- Phase 010 is the prerequisite direct-upload/runtime foundation. Feature 011 does
  not change its upload, queue, MinIO, or Compose contracts.
- **Approved schema-alignment exception (2026-07-17):** the local database had
  legacy `Annotation.version` while the locked schema/client use
  `Annotation.revision`. Migration `20260717134447_align_annotation_revision`
  aligns that one column before optimistic-lock testing. Prisma generated a
  drop/add migration, so existing annotations receive revision `1`; prior
  version values are not preserved.

**Scale/Scope**: Public login/registration pages for the existing auth APIs; one IMAGE Asset workspace at a time; first-class bounding boxes; Shapes/Labels/Images management views; 100 image Assets per list page; full Dataset case-insensitive filename filter; at least 250 image Assets in pagination tests.

## Constitution Check

The repository constitution template contains no ratified project-specific rules. The governing checks are therefore `AGENTS.md`, Phase 0 architecture documents, Phase 004 authorization policy, and the Feature 011 specification.

| Gate | Pre-design result | Post-design result |
| --- | --- | --- |
| PostgreSQL is canonical for metadata and optimistic locks | Pass: Annotation/Asset revisions are durable records | Pass |
| MinIO owns binary and credentials remain server-only | Pass: use authorized view capability only | Pass |
| Redis/BullMQ are transport only | Pass: workspace actions create no queue state | Pass |
| Shared workspace route and `Asset.modality` engine selection | Pass | Pass |
| Canonical `Annotation.geometry` and stale-write rejection | Pass: geometry contract and guarded mutation design | Pass |
| No unapproved raw SQL, dependency, schema, or migration | Pass | Pass |
| Authorization and IDOR concealment | Pass: all reads/mutations resolve actor and Dataset permissions | Pass |
| Opaque cookie sessions and server-side revocation | Pass: add UI/proxy only; no JWT/local-storage credential | Pass |

## Research Decisions

See [research.md](./research.md). All initial technical choices are resolved; no `NEEDS CLARIFICATION` remains.

## Project Structure

### Documentation (this feature)

```text
specs/011-image-labeling-mvp-optimistic-locking/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── auth-pages.md
│   ├── workspace-api.md
│   └── geometry-and-locking.md
└── tasks.md                 # Created later by /speckit-tasks
```

### Source Code (repository root)

```text
apps/web/src/
├── app/(app)/workspace/[datasetId]/
│   ├── page.tsx                 # Authorized workspace data boundary
│   └── actions.ts               # Existing annotation mutations; extend safely
├── app/(auth)/
│   ├── login/page.tsx            # Public returning-user entry page
│   └── register/page.tsx         # Public account registration page
├── app/api/
│   ├── assets/[assetId]/view-url/route.ts
│   └── datasets/[datasetId]/... # Existing safe Dataset/Asset/Label boundaries
├── components/workspace/
│   ├── annotation-canvas.tsx
│   ├── canvas-stage.tsx
│   ├── dataset-sidebar.tsx
│   ├── properties-panel.tsx
│   └── toolbar.tsx
├── components/auth/              # Public credentials form and safe redirect UX
├── lib/
│   ├── authorization.ts
│   ├── auth.ts
│   ├── dataset-metadata.ts
│   └── validation/annotation.ts
├── stores/annotation-store.ts
└── types/annotation.ts

apps/web/src/proxy.ts              # Protected-page login redirect and safe return target

apps/web/tests/
├── auth-ownership/
├── dataset-metadata/
└── workspace/                  # New focused feature tests
```

**Structure Decision**: Extend the existing workspace, authorization, validation, and Dataset metadata boundaries. Keep Konva interaction and ephemeral viewport/draft state in browser components/store; keep all durable writes and permission checks server-side. Do not create a separate annotation service, public worker endpoint, or modality-specific workspace route.

## Implementation Sequence

1. Add public login/registration page contracts and test safe internal return-target handling against the existing opaque-cookie APIs; change protected page redirect policy without changing auth API/session semantics.
2. Establish safe workspace read models and validate IMAGE modality/Asset/Dataset relationships before changing canvas interaction.
3. Define the bounded normalized-box geometry and optimistic-lock mutation contracts, including Asset-description revision behavior and conflict DTOs.
4. Add authorization/no-side-effect and stale-write regression tests before implementing write paths.
5. Extend server actions/handlers for create, geometry-only update, label-only update, delete, and description save with guarded revision mutations.
6. Replace placeholder canvas/sidebar behavior with image view capability loading, Konva box interactions, selection synchronization, and 1.5-second autosave state machine.
7. Add label defaulting/management and Dataset-wide image pagination/search while preserving existing permission gates.
8. Execute authentication-page, unit, HTTP authorization, optimistic-lock, browser interaction, and controlled MinIO view smoke tests; document no secret leakage and no schema/migration changes.

## Complexity Tracking

No constitution violation or exceptional complexity is introduced.
