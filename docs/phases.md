# Delivery Phases and Completion Gate

The approved rules are defined by [the architecture lock](./architecture.md),
[the Job system](./job-system.md), [the BullMQ/PostgreSQL flow](./bullmq-postgres-job-flow.md),
and [the private repository clone plan](./clone-repository-plan.md).

## Rule: no skipped phases

Work proceeds in the order published here. A later phase must not begin until
the user has approved the preceding phase's completion report. A phase must not
create mocks, substitute dependencies, schema, infrastructure, or behavior
reserved for an earlier phase.

## Phase 0 — Architecture Lock

**Goal**: Approve the architecture, durable Job ownership, binary storage
boundary, worker boundary, workspace selection rules, and future delivery
sequence before implementation.

**Deliverables**:

- `AGENTS.md`
- `docs/architecture.md`
- `docs/job-system.md`
- `docs/bullmq-postgres-job-flow.md`
- `docs/clone-repository-plan.md`
- this document

**Exit gate**: The documents agree that PostgreSQL is the Job authority,
BullMQ/Redis carries only `jobId`, MinIO owns binary objects, the private worker
owns cloning and long-running processing, and no Phase 1 artifact was created.

## Phase 1 — Project Foundation and Docker Compose

**Goal**: Introduce the approved runtime foundation: web application, private
worker, PostgreSQL, MinIO, Redis, BullMQ dependencies, pnpm workspace, and
Docker Compose.

**Required environment variables**:

```text
DATABASE_URL
MINIO_ENDPOINT
MINIO_ACCESS_KEY
MINIO_SECRET_KEY
MINIO_BUCKET
REDIS_HOST
REDIS_PORT
REDIS_PASSWORD
BULLMQ_PREFIX
```

**Exit gate**: The web application, worker, PostgreSQL, Redis, and MinIO start
under the approved compose topology, and Prisma generation succeeds. No
subsequent product phase may compensate with a mock for an unimplemented
foundation dependency.

## Later phases

Later phases must be specified, planned, tasked, and approved in the same
order. They may build on the Phase 1 foundation but may not weaken the rules in
`docs/architecture.md` or `docs/job-system.md` without a new approved
architecture decision.

## Mandatory completion report

After every phase, Codex must stop and report exactly:

| Report field | Required content |
| --- | --- |
| Files created | Every new path created in the phase. |
| Files modified | Every existing path changed in the phase. |
| Commands to run | Commands the user can run to validate or operate the phase. |
| Environment variables needed | Names only; never secrets or credential values. |
| Database migration changes | Migration names and summary, or `None`. |
| Known limitations | Remaining behavior, risks, or deferred decisions. |
| Next recommended phase | The next approved phase only. |

The report must state that the phase did not implement future phases early.
