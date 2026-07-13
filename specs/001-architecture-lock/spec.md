# Feature Specification: Architecture Lock

**Feature Branch**: `001-architecture-lock`  
**Created**: 2026-07-10  
**Status**: Draft  
**Input**: User description: "Create the Phase 0 architecture lock for an annotation platform, establishing the approved system boundaries, job ownership rules, asset and annotation canonical data rules, and the required Phase 1 foundation." 

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Approve one architecture baseline (Priority: P1)

As a project owner, I need one clear architecture baseline before development so every later phase follows the same ownership, security, and processing rules.

**Why this priority**: Conflicting architectural assumptions would make all later work risky and expensive to reconcile.

**Independent Test**: Review the architecture documentation and verify that every required system responsibility, data-ownership rule, and prohibited design is explicitly stated.

**Acceptance Scenarios**:

1. **Given** the project has no approved architecture lock, **When** the owner reviews the Phase 0 documentation, **Then** it identifies the application boundary, metadata authority, binary storage boundary, queue transport boundary, and long-running processing boundary.
2. **Given** a proposed implementation decision, **When** it conflicts with an explicitly prohibited design, **Then** the documentation identifies it as out of scope for the approved baseline.

---

### User Story 2 - Protect durable job state (Priority: P1)

As an operator, I need every import, export, and repository-processing task to retain durable, auditable state so retries and worker outages do not lose the job's authoritative record.

**Why this priority**: Reliable background processing depends on an authoritative record that survives queue and worker failures.

**Independent Test**: Review the documented flow for a submitted job and confirm that its durable record remains authoritative while queue messages carry only an identifier for that record.

**Acceptance Scenarios**:

1. **Given** a job is submitted, **When** it is queued for background work, **Then** the durable job record is created before processing and remains the source of truth for state and result metadata.
2. **Given** a queue delivery is retried, **When** the worker receives the retry, **Then** it resolves the job from the durable record using only the job identifier and does not require a duplicated full job input in the queue.

---

### User Story 3 - Route each asset to the correct workspace (Priority: P2)

As an annotator, I need a consistent workspace decision for every asset so different media types can use an appropriate editing experience without fragmenting the product into separate routes.

**Why this priority**: A central asset rule enables future media types while retaining one coherent workspace experience.

**Independent Test**: Review the documented entity rules and verify that an asset's modality determines the workspace engine and that annotation geometry remains the canonical representation of its shape.

**Acceptance Scenarios**:

1. **Given** an asset has a recorded modality, **When** it opens in the workspace, **Then** the documented rule selects its workspace engine from that modality.
2. **Given** an annotation is saved or autosaved, **When** a stale client attempts to overwrite it, **Then** the documented rule requires version checking and preserves the canonical geometry.

### Edge Cases

- A worker receives a queue message for a missing, cancelled, or already-completed job.
- A retry is delivered more than once, including after the prior attempt created binary output.
- A client attempts to save an annotation using an older version than the current persisted version.
- An asset's modality is unsupported or absent.
- A request attempts to expose provider tokens, object-storage credentials, or binary content through metadata or browser state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Phase 0 documentation MUST define one approved architecture in which the application backend validates requests, manages metadata, and submits long-running work without performing repository cloning itself.
- **FR-002**: The documentation MUST define a durable relational Job record as the sole authoritative source for job state, inputs, results, retry history, and terminal outcome.
- **FR-003**: The documentation MUST define queue infrastructure as transport only; every queue payload MUST contain only the durable job identifier and MUST NOT contain the full job input or authoritative state.
- **FR-004**: The documentation MUST define private object storage as the location for binary assets and generated artifacts; binary content MUST NOT be stored in the relational database.
- **FR-005**: The documentation MUST define a private worker as the owner of long-running processing, including repository cloning, and require the worker to read and update durable job state.
- **FR-006**: The documentation MUST designate Dataset as the central organizational entity for imported and processed assets.
- **FR-007**: The documentation MUST require Asset.modality to determine the workspace engine and MUST prohibit separate workspace routes by modality.
- **FR-008**: The documentation MUST define Annotation.geometry as the canonical annotation shape and Annotation.version as the concurrency value that prevents stale autosave overwrites.
- **FR-009**: The documentation MUST prohibit provider tokens, object-storage credentials, and other server-only secrets from browser responses, browser state, logs, or client configuration.
- **FR-010**: The documentation MUST prohibit duplicate binary assets or artifacts when a job is retried.
- **FR-011**: The documentation MUST prohibit specialized job tables for imports, exports, and repository synchronization; these workflows MUST use the common Job record.
- **FR-012**: The documentation MUST include the approved architecture choice of a Next.js backend API, PostgreSQL, Prisma, MinIO, Redis, BullMQ, and a private worker, including the responsibility of each boundary.
- **FR-013**: The documentation MUST include a phased delivery plan and require a completion report after every phase containing files created, files modified, commands to run, required environment variables, database migration changes, known limitations, and the next recommended phase.
- **FR-014**: The Phase 0 deliverable set MUST include `AGENTS.md`, `docs/architecture.md`, `docs/job-system.md`, `docs/bullmq-postgres-job-flow.md`, `docs/clone-repository-plan.md`, and `docs/phases.md`.
- **FR-015**: The architecture lock MUST explicitly limit this feature to documentation and governance; it MUST NOT implement Phase 1 infrastructure, install dependencies, create Docker assets, alter the database schema, or introduce mock substitutes for required dependencies.

### Key Entities

- **Dataset**: The central grouping of source assets and their annotation work.
- **Asset**: A source or derived item associated with a dataset; its modality selects the workspace engine.
- **Annotation**: A user-created description of an asset; geometry is the canonical shape and version protects against stale writes.
- **Job**: The durable record representing an asynchronous operation, its state, input, outcome, and retry lifecycle.
- **Job message**: A transient queue instruction containing only the identifier of a Job.
- **Binary object**: Private asset or generated artifact stored outside relational metadata storage.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All six required Phase 0 architecture documents are present and each approved responsibility and prohibition in FR-001 through FR-014 is explicitly covered.
- **SC-002**: A reviewer can trace a submitted background job from submission through retry and completion in one documented flow, with exactly one durable authoritative job record and a queue payload containing only one identifier.
- **SC-003**: A reviewer can determine the workspace engine for 100% of documented asset examples from Asset.modality without selecting a separate route per modality.
- **SC-004**: A reviewer can verify, from the documentation alone, that all five secret/binary safety rules in FR-004, FR-009, and FR-010 are satisfied.
- **SC-005**: The Phase 0 review identifies zero implementation artifacts for Phase 1 or later, including dependency changes, database migrations, container definitions, or mock services.

## Assumptions

- This specification governs Phase 0 only; Phase 1 is the next approved implementation phase and is not performed as part of this feature.
- The existing application will be reconciled with the approved architecture only through later, explicitly approved phases.
- The detailed schema for Job, Asset, Dataset, and Annotation will be designed in a later phase after this architecture lock is accepted.
- A retry-safe binary naming and idempotency strategy will be specified before any worker or object-storage implementation begins.
- Existing project instructions remain in force until Phase 0 explicitly updates them through an approved documentation change.
