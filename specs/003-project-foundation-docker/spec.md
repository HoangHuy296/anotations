# Feature Specification: Project Foundation Docker

**Feature Branch**: `003-project-foundation-docker`  
**Created**: 2026-07-13  
**Status**: Draft  
**Input**: User description: "Create the Phase 1 runnable project foundation and Docker Compose services for stable provider connections."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start a complete local foundation (Priority: P1)

As a developer, I need one repeatable startup process that brings up the web application, private worker, relational database, object storage, and queue service so I can develop against real dependencies rather than mocks.

**Why this priority**: Every later product capability depends on a stable, shared local foundation.

**Independent Test**: Start the declared local environment and verify that all five required services become healthy and remain reachable through their internal application connections.

**Acceptance Scenarios**:

1. **Given** required environment values are configured, **When** a developer starts the foundation, **Then** web, worker, database, object storage, and queue services start successfully.
2. **Given** the environment has started, **When** a developer restarts it, **Then** service identities and persisted development data remain available according to the declared local lifecycle.

---

### User Story 2 - Use stable private provider connections (Priority: P1)

As an application developer, I need the web application and private worker to connect reliably to database, object storage, and queue providers using server-only configuration.

**Why this priority**: The architecture requires real providers, durable Job state, private binary storage, and queue transport before any import or worker workflow can be implemented.

**Independent Test**: Verify each process can establish a connection to its required provider without exposing any credential in browser-visible output.

**Acceptance Scenarios**:

1. **Given** valid provider configuration, **When** the web application starts, **Then** it can establish required database connectivity.
2. **Given** valid provider configuration, **When** the private worker starts, **Then** it can establish queue and object-storage connectivity.
3. **Given** a browser requests application content, **When** provider setup is inspected, **Then** no provider credential is present in client state, response payloads, or logs.

---

### User Story 3 - Generate database client consistently (Priority: P2)

As a developer, I need the database client generation step to work in the foundation environment so later schema phases can use the prepared schema without ad hoc setup.

**Why this priority**: A consistent generated client prevents divergent local development environments and prepares Phase 2 without changing its schema in this phase.

**Independent Test**: Run the documented generation command against the configured database environment and confirm it completes successfully without altering the prepared schema or migrations.

**Acceptance Scenarios**:

1. **Given** database configuration is available, **When** the generation command runs, **Then** the generated client is available to the web and worker processes.
2. **Given** Phase 1 is being implemented, **When** database setup occurs, **Then** `prisma/schema.prisma` and existing migrations are not modified.

### Edge Cases

- A required provider environment variable is missing, blank, or malformed.
- One provider starts late or is temporarily unavailable when web or worker starts.
- A queue service is reachable but its configured namespace conflicts with an unrelated local project.
- Object storage exists but the configured bucket is absent or inaccessible.
- A browser-facing response accidentally includes provider configuration.
- A developer starts only infrastructure services for database-client generation without starting the web application.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The foundation MUST provide a runnable Next.js App Router web application and a separate private worker process within one product repository.
- **FR-002**: The foundation MUST provide a pnpm workspace and the declared application, worker, and shared-package boundaries without adding a second public backend.
- **FR-003**: The local service topology MUST include exactly the named service roles web, worker, postgres, minio, and redis.
- **FR-004**: The web and worker processes MUST use stable configured connections to PostgreSQL, MinIO, and Redis/BullMQ as required by their responsibilities.
- **FR-005**: The foundation MUST make the following server-only configuration values available: `DATABASE_URL`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, and `BULLMQ_PREFIX`.
- **FR-006**: Missing or invalid required provider configuration MUST prevent the affected process from reporting itself ready and MUST return a safe, actionable error without revealing a credential.
- **FR-007**: The worker MUST start as a private process and MUST NOT expose an HTTP API or browser route.
- **FR-008**: The foundation MUST support database-client generation using the prepared schema without modifying `prisma/schema.prisma` or existing migrations in this phase.
- **FR-009**: Provider credentials and connection secrets MUST remain server-only and MUST NOT be exposed in browser bundles, client state, public responses, queue payloads, or logs.
- **FR-010**: The foundation MUST use real PostgreSQL, MinIO, and Redis dependencies; it MUST NOT introduce workaround mocks for these earlier-phase dependencies.
- **FR-011**: The foundation MUST preserve the Phase 0 ownership rules: PostgreSQL is Job-state authority, MinIO holds binary objects, and Redis/BullMQ transports queue work rather than replacing Job state.

### Key Entities

- **Web application**: The browser-facing application and validation boundary.
- **Private worker**: The non-public process that will later execute durable background work.
- **Database provider**: The durable metadata and Job-state provider.
- **Object-storage provider**: The private binary-object provider.
- **Queue provider**: The transport provider for private worker delivery.
- **Provider configuration**: Server-only connection values required by web and worker processes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can start all five declared service roles with one documented procedure and each reaches a ready state within 3 minutes on a supported local machine.
- **SC-002**: Web and worker each establish their required provider connections on 3 consecutive clean starts without manual configuration changes.
- **SC-003**: Database-client generation succeeds from the documented command with zero changes to the prepared schema or existing migrations.
- **SC-004**: Review of browser output, public responses, and normal startup logs finds zero provider credentials or secret connection values.
- **SC-005**: A missing required configuration value produces a safe readiness failure for the affected process in 100% of tested cases.

## Assumptions

- Phase 0 architecture lock is accepted and remains authoritative.
- This Phase 1 foundation may add the dependencies named by the user because they are necessary real providers; no feature-level import, export, clone, or annotation behavior is included.
- Development credentials are supplied only through ignored local environment files or deployment secrets, never committed values.
- The prepared `prisma/schema.prisma` and existing migrations are read-only in Phase 1; Phase 2 owns any schema evolution after its separate approval.
- The private worker consumes only the minimal queue payload described by the architecture lock; no business Job processor is implemented in Phase 1.
