# Tasks: Architecture Lock — Phase 0

**Input**: Design documents from `/specs/001-architecture-lock/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md),
[architecture-governance.md](./contracts/architecture-governance.md), and
[quickstart.md](./quickstart.md)

**Tests**: No runtime test tasks are included because Phase 0 is
documentation-only. Every story has a documentation review and path/link
validation checkpoint defined in `quickstart.md`.

**Organization**: Tasks are grouped by user story. No task may add packages,
Docker assets, worker code, Prisma schema/migrations, service credentials, or
mocks; those belong to the separately approved Phase 1 or later.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel once its listed dependencies are complete.
- **[Story]**: Maps the task to a user story in `spec.md`.
- Every task names its exact target file.

## Phase 1: Setup — Documentation Scope and Baseline

**Purpose**: Establish the documentation-only boundary and identify existing
architecture material that Phase 0 must supersede or preserve as history.

- [X] T001 Inventory conflicts between the current architecture guidance and the approved Phase 0 contract in `specs/001-architecture-lock/plan.md`.
- [X] T002 [P] Record the Phase 0 delivery order, mandatory phase report, and explicit no-implementation boundary in `docs/phases.md`.
- [X] T003 [P] Add a supersession/cross-reference notice for the prior architecture baseline in `docs/architecture/README.md`.

**Checkpoint**: The team has one documented scope boundary and knows which
existing documents require alignment before a new architecture baseline is
claimed.

---

## Phase 2: Foundational — Agent Governance and Shared Rules

**Purpose**: Replace conflicting repository instructions before documenting
individual flows. This phase blocks every user story.

**⚠️ CRITICAL**: Do not begin user-story tasks until these governance rules are
complete and reviewed.

- [X] T004 Update architecture, security, storage, job-authority, and phase-report rules in `AGENTS.md` to require PostgreSQL Job authority, MinIO binary storage, queue payloads containing only `jobId`, and a private worker for long-running work.
- [X] T005 Update the canonical entity and workspace rules in `AGENTS.md` to require Dataset centrality, `Asset.modality` workspace selection, `Annotation.geometry` canonical shape, and `Annotation.version` stale-autosave protection.
- [X] T006 Link `AGENTS.md` to the authoritative Phase 0 document set in `docs/architecture.md`, `docs/job-system.md`, and `docs/phases.md` without exposing tokens or storage credentials.

**Checkpoint**: Agent guidance no longer conflicts with the approved architecture
and explicitly prohibits early Phase 1 implementation.

---

## Phase 3: User Story 1 — Approve One Architecture Baseline (Priority: P1) 🎯 MVP

**Goal**: Give the project owner one reviewable architecture baseline defining
all responsibility boundaries, security constraints, and prohibited designs.

**Independent Test**: Review `docs/architecture.md` against FR-001, FR-004,
FR-006 through FR-010, FR-012, and FR-015; confirm each required boundary and
prohibition is explicit without any Phase 1 artifact in the repository.

### Implementation for User Story 1

- [X] T007 [US1] Create the approved component responsibility map and trust boundaries in `docs/architecture.md` using `specs/001-architecture-lock/contracts/architecture-governance.md` as the source contract.
- [X] T008 [US1] Document private binary storage, secret handling, retry-safe object ownership, Dataset centrality, and prohibited designs in `docs/architecture.md`.
- [X] T009 [US1] Link the current architecture history and ADR index from `docs/architecture.md` so superseded local-storage and single-process assumptions are distinguishable from the new lock.

**Checkpoint**: User Story 1 is independently reviewable as the architecture
lock MVP.

---

## Phase 4: User Story 2 — Protect Durable Job State (Priority: P1)

**Goal**: Give operators an auditable job lifecycle in which PostgreSQL is
authoritative and queue transport is minimal and retry-safe.

**Independent Test**: Trace submission, worker execution, retry, cancellation,
and completion in `docs/job-system.md` and
`docs/bullmq-postgres-job-flow.md`; verify every queue message is logically
`{ jobId }` and durable state is only in PostgreSQL.

### Implementation for User Story 2

- [X] T010 [P] [US2] Define the common Job kinds, state transitions, durable input/result ownership, terminal-state handling, and idempotency rules in `docs/job-system.md`.
- [X] T011 [P] [US2] Document the backend-to-PostgreSQL-to-BullMQ-to-worker retry flow and the `{ jobId }` payload rule in `docs/bullmq-postgres-job-flow.md`.
- [X] T012 [US2] Define the private worker repository-clone lifecycle, credential boundary, cleanup ownership, and prohibition on backend cloning in `docs/clone-repository-plan.md`.
- [X] T013 [US2] Cross-check Job terminology, state names, binary-object references, and retry rules across `docs/job-system.md`, `docs/bullmq-postgres-job-flow.md`, and `docs/clone-repository-plan.md`.

**Checkpoint**: User Story 2 is independently reviewable without a specialized
ImportJob, ExportJob, or RepositorySyncJob table.

---

## Phase 5: User Story 3 — Route Each Asset to the Correct Workspace (Priority: P2)

**Goal**: Define a single workspace decision for every asset and a safe,
canonical annotation update rule.

**Independent Test**: From `docs/architecture.md`, determine the workspace
engine for documented asset modalities and verify that a stale annotation save
cannot overwrite newer `geometry` or `version` data.

### Implementation for User Story 3

- [X] T014 [US3] Add the `Asset.modality` workspace-engine decision and the prohibition on modality-specific workspace routes to `docs/architecture.md`.
- [X] T015 [US3] Add canonical `Annotation.geometry`, optimistic version comparison, stale-autosave rejection, and reload behavior to `docs/architecture.md`.

**Checkpoint**: User Story 3 is independently reviewable and does not create a
modality route, database schema, or autosave implementation.

---

## Phase 6: Polish and Cross-Cutting Validation

**Purpose**: Make the document set internally consistent, verifiable, and
ready for approval before Phase 1 planning begins.

- [X] T016 [P] Add an explicit per-phase completion report template and ordered no-skip phase policy to `docs/phases.md`.
- [X] T017 Reconcile all cross-links, terminology, prohibited designs, and delivery paths across `AGENTS.md`, `docs/architecture.md`, `docs/job-system.md`, `docs/bullmq-postgres-job-flow.md`, `docs/clone-repository-plan.md`, and `docs/phases.md`.
- [X] T018 Run every documentation validation scenario in `specs/001-architecture-lock/quickstart.md` and record the results in `specs/001-architecture-lock/tasks.md` by checking completed tasks only after all expected outcomes pass.

**Checkpoint**: Phase 0 is ready for user approval. Stop here; do not begin
Phase 1 until it is explicitly approved.

---

## Dependencies & Execution Order

### Phase Dependencies

```text
Phase 1 Setup
  → Phase 2 Foundational governance
    → Phase 3 US1 architecture baseline (MVP)
      → Phase 4 US2 durable Job flow
        → Phase 5 US3 asset/annotation rules
          → Phase 6 cross-cutting validation
```

- **Phase 1**: starts immediately.
- **Phase 2**: depends on T001–T003 and blocks all user stories.
- **US1**: depends on T004–T006.
- **US2**: depends on the approved US1 responsibility map, because its flow
  must use the architecture's named boundaries.
- **US3**: depends on US1 because the workspace and annotation rules are part
  of the canonical architecture document.
- **Phase 6**: depends on all desired user stories.

### User Story Dependencies

- **US1 (P1)**: The MVP. It can be reviewed after foundational governance.
- **US2 (P1)**: Requires US1's approved responsibility map; it may begin only
  after that review checkpoint.
- **US3 (P2)**: Requires US1's canonical architecture document; it does not
  require a Job implementation.

### Parallel Opportunities

- T002 and T003 may run in parallel after T001 because they edit different
  files.
- T010 and T011 may run in parallel after US1 because they edit different
  documents; T012 follows their shared terms, and T013 reconciles all three.
- T016 may run in parallel with the final cross-link review only after all
  user-story documents exist.

## Parallel Example: User Story 2

```text
Task: "Define the common Job lifecycle in docs/job-system.md"
Task: "Document the BullMQ/PostgreSQL flow in docs/bullmq-postgres-job-flow.md"
```

After both tasks are complete, continue with the private worker cloning plan
and then the terminology reconciliation task.

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 setup and Phase 2 governance.
2. Complete T007–T009 to publish one architecture baseline.
3. Review US1 independently against its acceptance criteria.
4. Stop for approval before documenting additional flows.

### Incremental Delivery

1. Add US1: common boundaries and prohibitions.
2. Add US2: durable Job and worker flow, then review retries and secrets.
3. Add US3: modality and annotation concurrency rules, then review the single
   workspace decision.
4. Complete cross-cutting validation and stop for Phase 1 approval.

## Notes

- All tasks use the required checklist format, task IDs, and exact file paths.
- Phase 0 changes only documentation and `AGENTS.md`; it does not modify
  `prisma/schema.prisma`, migrations, `.env` files, package manifests, or
  runtime source code.
- Use the completion report required by T016 after this phase: files created,
  files modified, commands to run, environment variables needed, database
  migration changes, known limitations, and next recommended phase.

## Phase 0 Validation Record

- **Documentation paths and links**: Passed. All six Phase 0 deliverables
  exist, are non-empty, and all local Markdown links in the document set
  resolve.
- **Architecture rules**: Passed. The document set explicitly requires a
  PostgreSQL Job source of truth, `{ jobId }` queue payload, MinIO binary
  storage, a private worker clone boundary, Asset.modality workspace selection,
  and Annotation.geometry/version rules.
- **Phase boundary**: Passed. No Docker/Compose files, workspace directories,
  worker code, schema/migration changes, or package changes were created.
- **Lint**: Passed with `npm run lint`.
- **Type check**: Not a Phase 0 acceptance condition. `npx tsc --noEmit`
  still reports the pre-existing missing `tool` and `onToolChange` props at
  `src/components/workspace/canvas-stage.tsx:171`; defer this to its approved
  canvas phase.
