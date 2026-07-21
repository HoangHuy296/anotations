# Implementation Plan: Job APIs and Progress UI

**Branch**: `009-job-apis-progress-ui` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-job-apis-progress-ui/spec.md`

## Summary

Deliver Dataset-authorized Job monitoring and controls: a safe status view, bounded safe event history, cancellation requests, idempotent retry successors, and a polling progress UI. PostgreSQL remains the only Job status authority. This phase deliberately excludes import commit, preparation, staging, and processing.

## Technical Context

**Language/Version**: TypeScript on Node.js 22

**Primary Dependencies**: Existing Next.js application, Prisma 6.19, Zod, BullMQ/ioredis transport clients, React UI primitives; no new runtime dependency

**Storage**: PostgreSQL Job and JobEvent records; one additive Job retry-lineage migration. Redis/BullMQ transport only; MinIO is not used by this phase.

**Testing**: Node built-in runner with `tsx`, Prisma-backed HTTP/integration tests, UI component tests using existing project conventions

**Target Platform**: Next.js web application and private Linux worker runtime

**Project Type**: pnpm monorepo with web application, domain/queue packages, and private worker

**Performance Goals**: A visible non-terminal Job reflects a saved durable update within 10 seconds; Job status/event reads are bounded and do not require queue inspection

**Constraints**:

- PostgreSQL Job is canonical; queue payload remains exactly `{ jobId }`.
- Browser responses never include raw Job JSON, raw JobEvent data, queue/lock state, provider data, credentials, private storage references, or binary data.
- Phase 008 claim, lease, heartbeat, and worker cancellation acknowledgement semantics remain unchanged.
- Retry creates one successor for one failed original; it never resets or overwrites history.
- `POST /api/jobs/[jobId]/commit-import`, PreparedImport, local-folder staging, and IMPORT_DATASET processing are prohibited in this phase.

**Scale/Scope**: Four Job HTTP read/action surfaces (one pre-existing status endpoint retained), a Job detail/progress UI, one retry lineage migration, safe DTOs, and authorization/concurrency integration coverage.

## Constitution Check

The checked-in Spec Kit constitution is a placeholder. Repository governance in `AGENTS.md`, Phase 007 queue contracts, and Phase 008 worker-safety contracts are the effective gates.

| Gate | Pre-design result | Plan response |
| --- | --- | --- |
| PostgreSQL Job is canonical | Pass | Status, event history, cancellation, and retry eligibility are read or written durably before UI refresh. |
| Redis/BullMQ is transport only | Pass | Retry invokes existing create-then-enqueue behavior; payload remains `{ jobId }`; UI never polls queue state. |
| Safe browser boundary | Pass | Separate safe status/event DTOs omit raw Job, JobEvent, lock, queue, provider, storage, and credential fields. |
| Claim-lock safety preserved | Pass | Browser cancellation only requests cancellation; private worker retains token-gated acknowledgement. |
| No duplicate durable work | Pass | A unique retry lineage relation and transaction ensure one successor per failed Job. |
| No early import processing | Pass | Commit import, preparation, staging, and IMPORT_DATASET delivery are excluded. |

**Post-design re-check**: Pass. The only migration supports retry lineage and does not store binary data, secrets, staging data, or queue state.

## Project Structure

### Documentation

```text
specs/009-job-apis-progress-ui/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── job-api.md
│   └── progress-ui.md
└── checklists/
    └── requirements.md
```

### Source Code

```text
apps/
├── web/
│   ├── src/
│   │   ├── app/api/jobs/[jobId]/
│   │   │   ├── route.ts                 # retain safe status read
│   │   │   ├── events/route.ts          # safe, bounded event history
│   │   │   ├── cancel/route.ts          # authorized cancellation request
│   │   │   └── retry/route.ts           # authorized idempotent successor
│   │   ├── app/(app)/jobs/[jobId]/page.tsx
│   │   ├── components/jobs/
│   │   └── lib/jobs/
│   │       ├── authorization.ts
│   │       ├── safe-job-status.ts
│   │       ├── safe-job-event.ts
│   │       └── retry-job.ts
│   └── tests/job-queue/
└── worker/
    └── tests/queue/                     # regression-only cancellation acknowledgement coverage

prisma/
├── schema.prisma                         # additive retry relation only
└── migrations/
```

**Structure Decision**: Keep authorization and safe projections server-only under the existing web Job boundary. Keep client-safe display types and progress components in the web application. Do not introduce a new service or a public worker endpoint.

## Implementation Approach

1. Add a self-referential, unique retry lineage from a successor Job to its failed original and migrate it. Do not add PreparedImport or any import staging fields.
2. Add Dataset-scoped `job.retry` authorization and define owner/manager/admin grants while retaining existing `job.cancel` behavior.
3. Normalize safe Job not-found/conflict responses and retain the existing safe status DTO. Add a separate, cursor-bounded safe JobEvent DTO that never serializes `JobEvent.data`.
4. Make cancellation state-aware: cancel unclaimed `QUEUED`/unlocked `RETRYING` Jobs atomically as terminal; request cancellation for `RUNNING`; reject terminal and duplicate requests without event or queue side effects.
5. Create a successor only for an authorized failed Job with a queue-supported, allowlisted retry context. Use a transaction and the unique lineage relation to return/reuse one successor under concurrent requests, then follow create-then-enqueue. Unsupported/import Job types return a safe conflict rather than being delivered prematurely.
6. Build the Job detail screen from the safe HTTP contracts. Poll status and events only while a Job is non-terminal and the page is visible; stop polling at terminal state. Render stage, counters, progress, safe event list, controls, and safe error state without raw diagnostics.
7. Verify authorization/IDOR, redaction, cancellation races, retry concurrency, strict queue payload, UI polling, and Phase 008 lifecycle regressions.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Additive retry-lineage migration | A unique durable successor relationship is required to prove concurrent retries create one successor and preserve original history. | An idempotency string alone cannot express retry lineage or enforce one successor per original Job clearly. |
