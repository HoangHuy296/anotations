# Phase 0 Validation Guide

## Purpose

Validate that Phase 0 has locked the architecture without implementing any
Phase 1 infrastructure.

## Prerequisites

- The feature specification and implementation plan are present in
  `specs/001-architecture-lock/`.
- The reviewer can read the repository documentation.
- No service credentials, Docker services, database migrations, or new
  dependencies are required for this documentation phase.

## Validation scenarios

### 1. Verify the required deliverables

Confirm that the following files exist and are internally consistent:

- `AGENTS.md`
- `docs/architecture.md`
- `docs/job-system.md`
- `docs/bullmq-postgres-job-flow.md`
- `docs/clone-repository-plan.md`
- `docs/phases.md`

Expected outcome: all six documents explicitly describe the same responsibility
map and prohibited designs.

### 2. Trace a Job from submission through retry

Use `docs/bullmq-postgres-job-flow.md` and verify this sequence:

1. The backend validates and creates a durable Job.
2. The queue receives only `jobId`.
3. The worker reads the Job from PostgreSQL before processing.
4. A retry reuses the same Job identity and does not create a duplicate binary
   object.
5. PostgreSQL records the final authoritative state and object reference.

Expected outcome: no step makes Redis or BullMQ the job authority, and no full
Job input appears in the queue payload.

### 3. Verify asset and annotation rules

Use `docs/architecture.md` and verify that:

- Asset.modality selects the workspace engine within one workspace route.
- Annotation.geometry is canonical.
- Annotation.version rejects stale autosave updates.

Expected outcome: a reviewer can determine each behavior without needing an
implementation-specific route or database table.

### 4. Verify security and phase boundaries

Confirm that the documentation prohibits provider tokens and MinIO credentials
from client-visible locations, prohibits binary PostgreSQL storage, and assigns
repository cloning to the private worker.

Expected outcome: Phase 0 contains documentation changes only. There are no
new packages, Docker files, worker processes, migrations, or mocks.

## Commands

Use the repository's normal text/link validation if available. For this plan,
the minimum manual checks are:

```bash
test -f AGENTS.md
test -f docs/architecture.md
test -f docs/job-system.md
test -f docs/bullmq-postgres-job-flow.md
test -f docs/clone-repository-plan.md
test -f docs/phases.md
```

Do not run infrastructure startup commands in Phase 0; they belong to the
approved Phase 1 plan.
