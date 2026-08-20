# Implementation Plan: Production Hardening and Garbage Collection

**Branch**: `021-production-hardening-garbage-collection` | **Date**: 2026-08-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/021-production-hardening-garbage-collection/spec.md`

## Summary

Harden the existing PostgreSQL + Redis/BullMQ + MinIO Annotation Platform for production operation without changing any existing API contract, domain model, or user-facing behavior beyond two named Properties Panel additions. The repository audit found that most of the required *mechanisms* already exist in a partial or unwired form — a `recovery-scanner.ts` that is fully implemented but never scheduled, an `import-timeout-scanner.ts` that already enforces `PreparedImport.deadlineAt`, per-request lease/lock primitives in `job-lock.ts`/`job.repository.ts`, and a prefix-scoped orphan sweep in `import-cleanup.ts`. The technical approach is therefore mostly **generalize, wire up, and schedule existing idioms** rather than build new subsystems: extend the atomic conditional-`UPDATE` locking pattern to a general stale-`RUNNING` detector, generalize the prefix-scoped MinIO sweep into one reusable "unreferenced object" primitive shared by the orphan scanner/asset cleanup/dataset cleanup/temp-upload cleanup, add BullMQ stalled-job options to the one `Worker` constructor, add a small number of new scheduled `setInterval` passes to `apps/worker/src/readiness.ts` (the existing scheduling mechanism), add Redis-backed per-user rate limiting to the three job-creating API routes, bound the two remaining unbounded `findMany` calls plus any others found during audit, extend the existing `/api/health` and worker startup probes for observability, and add the two named Properties Panel UI changes reusing the existing `label-form.tsx` color-picker component and `AssetNavigator` pagination props.

## Technical Context

**Language/Version**: TypeScript 5 (ESM throughout); Node.js runtime for both apps.

**Primary Dependencies**: Next.js 16 (App Router, `apps/web`) · Prisma 6 / `@prisma/client` (PostgreSQL) · BullMQ 5 + ioredis 5 (`apps/worker`, queue transport) · `minio` SDK 8 (object storage, used by both apps) · Zod 4 (request/config validation) · React 19 + react-konva (canvas, unaffected) · `@annotationplatform/domain` (shared provider config/readiness) and `@annotationplatform/queue` (shared queue contract types) workspace packages.

**Storage**: PostgreSQL via Prisma — sole source of truth for `Job`, `JobEvent`, `PreparedImport`, `Asset`, `Dataset`, `AiTask`. Redis via BullMQ/ioredis — queue transport only, `{ jobId }` payloads only; this feature adds ephemeral per-user rate-limit counters as the only new Redis-resident state, never authoritative. MinIO — binary object storage; this feature adds no new bucket, only a generalized read/delete sweep over existing prefixes.

**Testing**: Node's built-in test runner (`node:test`) via `tsx --test`, invoked through per-suite `pnpm --filter @annotationplatform/web test:<suite>` / `pnpm --filter @annotationplatform/worker test:<suite>` scripts (existing convention — see `apps/web/package.json`, `apps/worker/package.json`); one existing Vitest spec in `apps/web` (`source-access-policy.vitest.spec.ts`) for a case needing Vitest's environment features. No Playwright or other E2E framework exists in this repository. Docker Compose verification (User Story 9) is a documented manual `docker compose up` + health/curl smoke check, matching how the existing `docker-compose.yaml`/`docker-compose.preflight.yaml`/`docker-compose.review.yaml` are already verified, not a new automated E2E suite.

**Target Platform**: Linux server, containerized via the existing Docker Compose configuration (`postgres`, `redis`, `minio`, `web`, `worker`, `gitea` services already defined in `docker-compose.yaml`).

**Project Type**: pnpm monorepo web application — `apps/web` (Next.js App Router: browser-facing pages, API routes, Server Actions) + `apps/worker` (long-running Node process: BullMQ consumer, scheduled scanners) + `packages/domain` (shared provider config/readiness/AI adapter types) + `packages/queue` (shared queue name/job-contract types) + root `prisma/schema.prisma` (single shared Prisma schema, generated client consumed by both apps).

**Performance Goals**: No new raw-throughput target; goals are bounded-latency and bounded-resource guarantees derived from the spec's success criteria — job recovery/failure within a configurable threshold (SC-001/SC-002), import timeout within its deadline (SC-003), garbage collection passes that batch rather than lock large tables (FR-028/FR-035), and list endpoints that return a capped page instead of an unbounded result (SC-010).

**Constraints**: Everything in AGENTS.md's *Non-negotiable data rules* and *Security rules* applies unchanged — PostgreSQL remains the sole Job/JobEvent/state source of truth, Redis stays transport-only (rate-limit counters are the sole, explicitly non-authoritative exception), no binaries in PostgreSQL, no raw SQL beyond the already-approved atomic conditional-`UPDATE` idiom used by `job.repository.ts`/`job-lock.ts`, no second independent locking system, no MinIO deletion without a proven-unreferenced check, no credentials/tokens/signed URLs in logs, React Strict Mode untouched, no new npm package without explicit justification (see `research.md` §"Redis client for `apps/web`" — the one place this feature needs to ask for one).

**Scale/Scope**: 57 functional requirements across 9 independently-testable user stories (P1×4, P2×4, P3×1); touches roughly a dozen existing files (`readiness.ts`, `bullmq-worker.ts`, `recovery-scanner.ts`, `import-timeout-scanner.ts`, `job-lock.ts`, `import-cleanup.ts`, the three under-paginated API routes, `image-properties-tabs.tsx` and siblings) plus a similar number of new worker-side scanner/cleanup modules and one or two new API routes (rate-limit middleware, dead-letter/observability surface); deploys as a single Postgres + single Redis + single MinIO instance behind N horizontally-scaled `apps/worker` replicas.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template (never ratified) — per `CLAUDE.md`, project governance instead comes from `AGENTS.md`, checked into the repository. The table below evaluates this feature against every AGENTS.md rule that applies to it.

| AGENTS.md rule | Status | Notes |
| --- | --- | --- |
| Product boundary — Next.js web owns browser-facing APIs/authz/metadata; private worker owns processing, never serves browser requests | PASS | All new scanners/cleanup passes (recovery, stale-job, JobEvent retention, orphan scan, asset/dataset/temp-upload cleanup) run inside `apps/worker`. New browser-facing surfaces (rate-limit responses, pagination, health/observability reads, the two Properties Panel additions) stay in `apps/web`. No new service is introduced. |
| Required architecture table (Next.js API / Postgres+Prisma / Redis+BullMQ / MinIO / worker responsibilities) | PASS | Unchanged division of responsibility; this feature only hardens each existing boundary in place. |
| `Job` is the single source of truth; no `ImportJob`/`ExportJob`/etc. tables | PASS | No new job-type table. Dead-letter and staleness are derived from existing `status`/`attempts`/`maxAttempts`/`lockedUntil` fields (see `research.md` §"Dead-letter representation"), not a new table or a new `JobStatus` value. |
| Redis is transport only, never a Job store; queue payload is `{ jobId }` only | PASS | Unaffected for job payloads. The one new Redis-resident state (per-user rate-limit counters) is explicitly ephemeral, keyed by user+route, and never consulted as Job state — flagged as new Redis *usage* (not a new Job store) in `research.md`. |
| No binary data in PostgreSQL | PASS | Unaffected — garbage collection only ever reads/deletes MinIO objects and Postgres references, never moves bytes between them. |
| Retries idempotent; one successor Job per authorized retry; no duplicate asset/artifact on duplicate delivery | PASS | Recovery reuses the existing `attempts`/`maxAttempts` counters and retries the *same* Job row in place (no new Job row), matching FR-003/FR-005/FR-009. Dead-letter is a terminal `FAILED` state on that same row, per FR-008/FR-011. |
| `Dataset` is the central entity for imported/processed assets | N/A / PASS | Unaffected; dataset-deletion cleanup (FR-028/FR-029) reads existing Dataset→Asset relationships, does not change what a Dataset represents. |
| `Asset.modality` selects the workspace engine; no per-modality workspace routes | N/A | Unaffected — this feature touches asset *storage lifecycle*, not workspace routing. |
| `Annotation.geometry` canonical, `revision` required/enforced | N/A | Unaffected — annotation behavior is explicitly preserved per the spec's scope statement. |
| Security rules — no credentials/MinIO creds/Redis creds/DB creds/signed URLs/tokens in browser, logs, queue payloads, or public errors | PASS | FR-050 codifies this for the new structured logging; rate-limit and pagination responses carry no secret material; observability surface (FR-051) reports counts/health only, never raw credentials or job `input`/`state` payloads. |
| Browser never calls private providers directly except a short-lived, object-scoped presigned URL | PASS | Unaffected — no new browser-facing storage access path is introduced; the generalized orphan/cleanup sweep is worker/server-side only. |
| Absolute `@/lib/...` imports; server logic out of UI components; Zod for request/Server Action validation; shared types in `src/types` | PASS (design intent) | New rate-limit config, pagination query schemas, and cleanup-threshold env vars follow the existing `z.coerce.number()...default()` policy-schema convention already used in `apps/worker/src/config.ts`. The Properties Panel label-creation form reuses the existing `apps/web/src/components/labels/label-form.tsx` fields rather than re-implementing them inline. |
| Do not add npm packages without explicit permission; state purpose/alternative/impact first | **FLAGGED — needs explicit go-ahead before implementation** | `apps/web` currently has **zero** Redis client dependency (only `apps/worker` depends on `ioredis`). Redis-backed per-user rate limiting (FR-037, explicitly preferred by the spec since Redis is already the platform-wide coordination layer) requires adding `ioredis` (same pinned version already used in `apps/worker`, `5.10.1`) to `apps/web`'s dependencies. See `research.md` §"Redis client for `apps/web`" for the alternative considered (Postgres-backed counters) and why it was rejected. This is the only new dependency this feature needs. |
| Canvas rules (react-konva, commit-only-at-boundaries) | N/A | Unaffected — no canvas/geometry work in this feature. |
| Phase discipline — no skipped/early phases; report files created/modified/etc. per phase | PASS (process) | This plan follows Phase 0 → Phase 1 → `/speckit-tasks` → `/speckit-implement`; the completion report at the end of this command lists artifacts produced. |

**Gate result: PASS**, with one flagged, low-risk dependency addition (`ioredis` in `apps/web`) that needs the user's explicit sign-off before an implementation task adds it to `apps/web/package.json`. No constitution/AGENTS.md violation requires a Complexity Tracking justification.

### Post-Design Re-Check (after Phase 1)

`research.md`, `data-model.md`, `contracts/`, and `quickstart.md` are complete. Re-checked against every row above: **no new violation was introduced by design**. Specifically — `data-model.md` confirms zero Prisma migrations (no new `JobStatus`, no new tables, dead-letter/staleness fully derived); `research.md` decision 6 confirms no second locking system (row-atomic `UPDATE`s plus one `pg_try_advisory_lock` use, a built-in Postgres primitive, not a new system); `contracts/health-observability.md` confirms no credential/secret/signed-URL ever appears in the extended health payload; `contracts/rate-limit-error.md` and `contracts/pagination-envelope.md` confirm the only acknowledged response-shape break is the two currently-unbounded list endpoints gaining a page envelope, which is the minimum necessary change per FR-041/FR-042. The one flagged item (`ioredis` in `apps/web`) is unchanged and still needs explicit sign-off before implementation. **Gate result: PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/021-production-hardening-garbage-collection/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── rate-limit-error.md
│   ├── pagination-envelope.md
│   ├── health-observability.md
│   └── properties-panel-labels-assets.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
prisma/
└── schema.prisma                                   # No migration expected (see data-model.md); reused as-is

apps/worker/src/
├── config.ts                                        # Add new *_MS/*_DAYS/*_HOURS policy schemas (existing z.coerce convention)
├── readiness.ts                                      # Existing scheduling seam — add new unref'd setInterval passes here
├── queue/
│   ├── bullmq-worker.ts                              # Add stalled-job Worker options (lockDuration/stalledInterval/maxStalledCount)
│   ├── recovery-scanner.ts                           # Existing — wire into readiness.ts; extend for stale-RUNNING recovery
│   ├── import-timeout-scanner.ts                     # Existing — already correct; add scheduling + tests only
│   ├── job-lock.ts                                   # Existing atomic-claim primitives — pattern reused, not replaced
│   ├── stale-job-detector.ts                         # NEW — general (non-AI) stale-RUNNING scan + dead-letter transition
│   ├── jobevent-retention.ts                         # NEW — batched JobEvent retention cleanup
│   ├── minio-orphan-scanner.ts                       # NEW — generalizes import-cleanup.ts's sweep; dry-run capable
│   ├── deleted-asset-cleanup.ts                      # NEW — per-asset-delete cleanup queue/consumer
│   ├── deleted-dataset-cleanup.ts                    # NEW — batched dataset-delete cleanup
│   └── temp-upload-cleanup.ts                        # NEW — thin wrapper over minio-orphan-scanner.ts scoped to temp prefixes
├── jobs/job.repository.ts                            # Existing claim primitive — referenced, not changed
└── tests/queue/                                      # New *.test.ts files alongside each new module above

apps/web/src/
├── lib/
│   ├── imports/import-cleanup.ts                     # Existing prefix sweep — becomes a thin caller of the shared primitive
│   ├── rate-limit/                                    # NEW — Redis-backed per-user fixed-window limiter + apiError helper
│   └── jobs/ (existing safe-job-event.ts etc.)        # Extended for dead-letter/stale visibility, same "safe" projection pattern
├── app/api/
│   ├── ai/tasks/route.ts                              # Add rate-limit check before Job creation
│   ├── datasets/route.ts                              # Add bounded pagination (currently unbounded findMany)
│   ├── datasets/[datasetId]/labels/route.ts           # Add bounded pagination (currently unbounded findMany)
│   ├── health/route.ts                                # Extend beyond Postgres-only to the full observability surface
│   └── (import/export initiation routes)              # Add rate-limit check before Job creation
└── components/workspace/
    ├── asset-navigator.tsx                            # Existing Previous/Next pagination — pageSize source changes to 10, component itself unchanged
    ├── image-properties-tabs.tsx (+ video/placeholder) # Labels tab: reuse label-form.tsx's color picker; "Add defaults" gets explanatory copy
    └── properties-panel.tsx                           # pageSize plumbing only

docker-compose.yaml / docker-compose.preflight.yaml / docker-compose.review.yaml
                                                        # Verified (User Story 9); documented only, no structural change expected
```

**Structure Decision**: Single existing pnpm monorepo (`apps/web` + `apps/worker` + `packages/domain` + `packages/queue` + root `prisma/`). This feature adds no new app, service, or package — every new module lands inside `apps/worker/src/queue/` (scheduled scanners/cleanup, following the existing file-per-concern convention already used by `recovery-scanner.ts`/`import-timeout-scanner.ts`) or `apps/web/src/lib/` + `apps/web/src/app/api/` (rate limiting, pagination, observability), matching the "Option 2: web application" shape already in place — no template option needed since the real layout already exists.

## Complexity Tracking

*No unjustified Constitution/AGENTS.md violation exists.* The one item requiring explicit sign-off (adding `ioredis` to `apps/web`) is not a violation — AGENTS.md permits new packages when their purpose, existing alternative, and impact are stated first, which is done here and in `research.md`. No entry is needed in this table.

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| — | — | — |
