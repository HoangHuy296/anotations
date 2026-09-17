# Implementation Plan: TEXT Workspace Engine

**Branch**: `025-text-workspace-engine` (not yet created; specification and planning prepared on `main`) | **Date**: 2026-09-15 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/025-text-workspace-engine/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Make manual TEXT annotation the third complete workspace engine (after IMAGE and VIDEO) inside the existing Next.js application and private worker, reusing the shared Asset Browser, workspace shell, authorization, revision, workflow, and collaboration systems rather than building a parallel product surface. The technical approach, recorded in [research.md](research.md) and [data-model.md](data-model.md), is additive: bind an immutable UTF-8 source with UTF-16-code-unit offsets and a versioned grapheme-boundary artifact (G1); make MinIO the sole binary authority for source content, verified through a `TEXT_SOURCE_PREPARE` common Job (G2); extend the existing generic `Annotation` model with tagged TEXT geometry instead of new domain tables (G3); enforce transactional, revision-checked, idempotent mutations with a per-dataset TEXT policy for classification cardinality and relation compatibility (G4); and defer durable linguistic tokenization until an authoritative tokenizer exists (G5). Contracts for the new routes are proposed in [contracts/workspace.md](contracts/workspace.md) and [contracts/openapi.yaml](contracts/openapi.yaml).

## Technical Context

**Language/Version**: TypeScript (Next.js App Router web app; Node-based private worker), matching the existing `apps/web` and `apps/worker` toolchains.

**Primary Dependencies**: Next.js App Router, Prisma ORM, BullMQ (Redis transport only), MinIO client, react-konva (existing canvas engines, unchanged by this feature), Zod for input validation. No new package is requested by this plan.

**Storage**: PostgreSQL via Prisma (source of truth for `Asset`, `TextAsset`, `Annotation`, `Dataset` policy fields, `Job`, and the new `AnnotationMutationReceipt`); MinIO for original TEXT source objects and a private versioned grapheme-boundary derivative artifact. Redis/BullMQ carries only `{ jobId }` queue payloads.

**Testing**: Node's built-in test runner (`node --test`) invoked through each app's `pnpm test:*` scripts (see `apps/web/package.json`, `apps/worker/package.json`), run against a real PostgreSQL/MinIO/Redis environment per repository convention; Vitest is present in `apps/web` for existing unit-level suites. No mocked substitutes for the approved dependencies per [AGENTS.md](../../AGENTS.md).

**Target Platform**: Server-rendered Next.js web application (browser client) plus a private Node worker process, deployed together as documented in `docs/architecture.md`.

**Project Type**: Web application monorepo (`apps/web` browser-facing Next.js backend/frontend, `apps/worker` private processing worker, `apps/realtime` existing invalidation delivery) — matches "Option 2: Web application" in Project Structure below, adapted to this repository's actual layout.

**Performance Goals**: Reference document of up to 100,000 declared UTF-16 code units with 1,000 spans and 100 relations readable/navigable within 3 seconds in ≥95/100 trials; local selection/focus/search-next feedback within 200 ms in ≥95/100 interactions after load (SC-005).

**Constraints**: No raw SQL; no Job state in Redis; no binary data in PostgreSQL; no provider/storage credentials reachable from the browser; every mutation revision-checked and idempotent; no TEXT-specific workflow, collaboration, or export system; initial whole-document envelope of 1,048,576 bytes / 100,000 UTF-16 code units enforced server-side.

**Scale/Scope**: Three TEXT assets currently exist in the audited configured database (read-only inventory in [research.md](research.md)); design targets the reference 100k-code-unit / 1,000-span / 100-relation document as the minimum performance corpus; the configurable initial reader envelope is enforced separately.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unfilled template (placeholder principle names only). Per [AGENTS.md](../../AGENTS.md) and the checklist's read-only findings ([checklists/requirements.md](checklists/requirements.md)), **AGENTS.md and the Phase 0 architecture-lock docs (`docs/architecture.md`, `docs/job-system.md`, `docs/bullmq-postgres-job-flow.md`, `docs/clone-repository-plan.md`, `docs/phases.md`) are the actual governance authority** for this repository. Gate evaluation therefore checks the plan against AGENTS.md's non-negotiable rules:

| AGENTS.md rule | Status | Evidence |
| --- | --- | --- |
| Public app (Next.js) owns validation, authorization, metadata writes, durable Job creation, and enqueue; no duplicate public API/microservice | PASS | All TEXT routes stay inside the Next.js app ([contracts/workspace.md](contracts/workspace.md) "HTTP surface"); worker only resolves/processes Jobs. |
| A common PostgreSQL `Job` is the source of truth; no `ImportJob`/`ExportJob`/modality-specific Job tables | PASS | `TEXT_SOURCE_PREPARE` is an additive **type** on the existing common `Job`, not a new table (data-model.md "Source document"). |
| Redis/BullMQ is queue transport only; no full `Job.input` in Redis | PASS | Research D2 states BullMQ receives only `{jobId}`. |
| No binary data in PostgreSQL; binaries in MinIO with safe metadata in Postgres | PASS | MinIO is the canonical binary authority (D2); Postgres stores only verified digest/length/pointer metadata. |
| Retries idempotent; no duplicate assets/artifacts on duplicate delivery | PASS | `AnnotationMutationReceipt` and deterministic derivative keys enforce this (data-model.md "Mutation receipts", "Atomic command algorithm"). |
| `Dataset` is central entity for imported/processed assets | PASS | No parallel dataset concept introduced; `Dataset.textPolicy*` fields extend the existing entity. |
| `Asset.modality` selects the workspace engine; no workspace routes by modality | PASS | TEXT reuses the existing `workspace-engine-registry.tsx` dispatch (research.md D6); no new route family. |
| `Annotation.geometry` canonical; `Annotation.revision` required and rejects stale overwrites | PASS | D3/G3 extends generic `Annotation` with tagged TEXT geometry and reuses existing revision checks; no parallel annotation table. |
| No provider/MinIO/Redis/DB credentials or private locators reachable from browser/queue/logs | PASS | Contracts explicitly exclude storage pointers, boundary artifact keys, and upstream diagnostics from all responses/events (contracts/workspace.md "Failures and concurrency", "Export projection"). |
| Use Prisma; no raw SQL without approval | PASS | D4 explicitly states "No raw SQL is authorized"; relies on Prisma transactions, restrictive FKs, and indexes. |
| Absolute `@/lib/...` imports; server logic out of UI; Zod for inputs; shared types in `src/types` | DEFERRED TO IMPLEMENTATION | Structural convention, not a design decision; no violation identified in the proposed contracts. |
| No unapproved npm packages | PASS | No new dependency requested. |
| No workaround mock replacing an approved-but-unbuilt dependency | PASS | Research explicitly rejects mocking the source of truth; uses real MinIO/Postgres/Job boundary. |
| Canvas rules (react-konva, commit at action boundaries) | N/A | TEXT does not use the spatial canvas; reader is escaped DOM text (contracts/workspace.md "UI and active-engine contract"). |
| Phase discipline: no skipping phases, no implementing later phases early | PASS (see note) | This plan is Phase 025's own Phase 0/1 design work, not implementation. G1–G5 gates explicitly block "migration or durable text implementation" until resolved here. |

**Initial gate result: PASS.** No constitution/AGENTS.md conflict identified. Re-evaluated after Phase 1 design below — still PASS; the design in data-model.md and contracts/ does not introduce any prohibited pattern.

## Project Structure

### Documentation (this feature)

```text
specs/025-text-workspace-engine/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── benchmark/reference.json # Single SC-005 fixture/environment contract
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── workspace.md
│   └── openapi.yaml
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

This is an existing pnpm monorepo (Option 2: web application shape), not a template to fill in from scratch. Affected areas identified by the research/data-model audit:

```text
apps/web/                                  # Next.js App Router application (browser-facing backend + frontend)
├── src/app/api/assets/[assetId]/text/     # NEW: GET source/readiness, POST prepare, GET/POST annotations (Route Handlers)
├── src/app/api/datasets/[datasetId]/text-policy/  # NEW: GET/PUT dataset TEXT policy (Route Handler)
├── src/components/workspace/
│   ├── text-engine.tsx                    # MODIFY: replace placeholder reader with real TEXT reader/store integration
│   ├── text-toolbox.tsx                   # MODIFY: replace image-store-coupled controls with capability-driven TEXT tools
│   ├── workspace-header.tsx               # MODIFY: active-engine flush() contract, not just image/video
│   ├── properties-panel.tsx               # MODIFY: same
│   └── placeholder-properties-tabs.tsx    # MODIFY: complete TEXT properties (details, labels, spans/classifications/relations)
├── src/lib/workspace/
│   ├── workspace-engine-registry.tsx      # MODIFY: register TEXT engine capabilities/flush contract
│   └── workspace-read.ts                  # MODIFY: extend TEXT selection DTO with source/annotation/revision context
├── src/lib/annotations/                          # NEW: TEXT server services (verified source/boundary read, mutation commands, policy read/write) — mirrors existing lib/annotations, lib/ai structure
├── src/types/workspace.ts, src/types/annotation.ts  # MODIFY: TEXT-specific safe DTO types
└── tests/                                 # NEW/MODIFY: TEXT contract, source/Unicode, concurrency, and regression suites (node --test)

apps/worker/
├── src/jobs/                              # NEW: TEXT_SOURCE_PREPARE processor (boundary artifact computation, digest verification)
├── src/source/                            # MODIFY/EXTEND: reuse existing source-access patterns for TEXT object verification
└── tests/source/                          # NEW/MODIFY: source preparation and boundary-artifact tests

packages/domain/src/                      # NEW: shared cross-app TEXT authority
├── text-annotation-contract.ts            # Canonical named geometry types and safe serializer contract
├── text-boundary-contract.ts              # Versioned artifact schema
├── text-source-decode.ts                  # Shared fatal UTF-8/BOM rules
└── text-source-limits.ts                  # Central Zod config consumed by web/worker

prisma/
├── schema.prisma                          # MODIFY: nullable TextAsset verification fields; Dataset.textPolicy*; AnnotationMutationReceipt; endpoint FKs/indexes; Job type; outbox enum additions
└── migrations/                            # NEW (after target-inventory preflight, additive only): corresponding migration

specs/api/openapi.yaml                     # MODIFY (post-implementation): merge validated routes from contracts/openapi.yaml
```

**Structure Decision**: Reuse the existing `apps/web` (Next.js backend+frontend), `apps/worker` (private processing), and `prisma/` (shared schema) layout exactly as used by the IMAGE/VIDEO engines. No new app, service, or route family is created; TEXT is delivered as new modules and additive schema/contract surface inside these existing directories, consistent with the "Required architecture" and "Product boundary" sections of AGENTS.md. Detailed data shapes live in [data-model.md](data-model.md); the full route/command surface lives in [contracts/](contracts/).

## Complexity Tracking

*No Constitution Check violations were identified. This section is intentionally empty.*

## Revised execution constraints

Follow the revised tasks.md execution graph. Canonical TEXT shapes/serializers belong to packages/domain; web retains only UI DTOs and server service adapters. Implement the bounded verified boundary reader/cache and authoritative MinIO source service before consumers. Source preparation uses dataset.read, independent of annotation mutation rights. Add an actual label.manage policy write lifecycle and Owner/Manager configuration panels; readers use dataset.read.

Centralize TEXT_WORKSPACE_MAX_SOURCE_BYTES, TEXT_WORKSPACE_MAX_CODE_UNITS and TEXT_WORKSPACE_MAX_ANNOTATIONS validation/defaults in the shared module and wire web/worker/deployments. Schema edits and shared UI/dispatch/history/export changes are sequential. US5 delivers span/label/property inverse commands; US3/US4 extend and test history after their commands exist. Run IMAGE/VIDEO regressions immediately after shared flush changes and again after TEXT save/navigation integration. Dedicated migration, OpenAPI, root typecheck/lint/build, Compose, realtime, concurrency and production browser tasks each produce their own evidence.

## Analysis remediation implementation order

Foundation completion proves only Serializable transaction/revision/receipt/rollback and policy-guard primitives. Command-specific replay-after-update/delete and policy-versus-annotation/classification/relation races execute after the owning story commands. Span endpoint relabeling revalidates all attached relations under the shared dataset/asset transaction guards, with real PostgreSQL rejection and concurrent-create proof.

PolicyWrite uses expectedRevision end-to-end (annotation command expectedPolicyRevision remains a distinct policy reference). Shared bounded custom-property schemas, set/unset patch semantics and the generic typed editor replace unspecified property reuse. Count admission occurs atomically after receipt replay; legacy-over-limit annotations remain readable through shared revision-consistent pagination on both TEXT-specific and generic annotation routes. Generic IMAGE/VIDEO projections remain unchanged.

The sole SC-005 reference is benchmark/reference.json plus quickstart.md's exact protocol. Fixture setup freezes the source/config/runtime/image manifest; story measurement and closure reuse it. Correctness and timing verdicts are separate required gates. See tasks.md's follow-up remediation matrix for renumbered owners.
