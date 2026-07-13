# Private Repository Clone Plan

This plan is constrained by [the architecture lock](./architecture.md) and the
[common Job system](./job-system.md).

## Ownership

Repository cloning is a private worker responsibility. The Next.js backend API
may validate a clone request, create its durable Job, and enqueue `{ jobId}`,
but it must not clone a repository or hold a long-running clone process.

## Worker lifecycle

1. Receive `{ jobId }` from BullMQ.
2. Resolve the durable Job and authorized source context from PostgreSQL.
3. Confirm the Job is eligible to run and claim its `running` state.
4. Obtain provider credentials only from server-side/private worker
   configuration.
5. Clone or fetch into a private working location controlled by the worker.
6. Validate the cloned material and write required binary outputs to MinIO.
7. Persist only safe provenance, object references, and result metadata to the
   durable Job and related domain records.
8. Clean up temporary working material according to the future retention
   policy; do not expose it via `public/` or browser-accessible paths.

## Credential boundary

- Provider tokens and repository URLs are never returned by the backend API,
  placed in a queue payload, committed to Job input/result, or logged.
- MinIO credentials remain private to the processes that need object storage.
- The browser receives only authorized application responses and safe object
  metadata; it never receives a provider authorization header or storage
  credential.

## Retry behavior

The worker reloads the same durable Job on retry. Before writing a clone-derived
asset or artifact, it checks the Job's durable result and deterministic object
identity. Existing valid outputs are reused or reconciled. A retry cannot
create a duplicate object merely because the first attempt was interrupted.

## Phase boundary

This is a plan, not a clone implementation. Docker Compose, worker entrypoints,
provider clients, MinIO clients, retention jobs, and credentials are Phase 1 or
later work and must not be mocked in Phase 0.
