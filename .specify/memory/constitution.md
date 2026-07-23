<!--
Sync Impact Report
- Version change: template/unversioned -> 1.0.0
- Modified principles: placeholder principles replaced by five Fieldframe principles.
- Added sections: Architecture Authority, Non-Negotiable Data and Security Rules,
  Development Workflow and Quality Gates.
- Removed sections: none.
- Templates reviewed: .specify/templates/plan-template.md ✅ no change required;
  .specify/templates/spec-template.md ✅ no change required;
  .specify/templates/tasks-template.md ✅ no change required.
- Command templates: no .specify/templates/commands directory is present.
- Runtime guidance synchronized: AGENTS.md, docs/architecture.md,
  docs/job-system.md, docs/bullmq-postgres-job-flow.md, and
  docs/clone-repository-plan.md.
- Deferred items: none.
-->

# Fieldframe Constitution

## Core Principles

### I. Architecture Authority and Boundaries

`AGENTS.md` and the accepted Phase 0 architecture documents are authoritative.
The public application MUST remain the Next.js App Router application; the
worker MUST remain private and MUST NOT serve browser requests. Changes that
alter an architecture decision require an explicit approved documentation
amendment before dependent implementation proceeds.

### II. Durable State and Retry Lineage

PostgreSQL with Prisma MUST be the canonical source of truth for metadata,
Annotation state, and Job lifecycle. Redis/BullMQ MUST transport only
`{ jobId }`; it MUST NOT contain canonical state, complete Job input,
credentials, or binary data. An authorized retry MUST create or reuse one
successor Job linked to its predecessor and carrying only allowlisted context.
Duplicate delivery or retry MUST NOT create duplicate assets or artifacts.

### III. Canonical Annotation and Workspace State

`Annotation.geometry` MUST be the canonical saved shape and
`Annotation.revision` MUST guard every annotation autosave or update. A stale
write MUST be rejected without overwriting the durable value. `Asset.modality`
MUST select the workspace engine under the shared workspace route; viewport and
other transient interaction state MUST remain client-only.

### IV. Private Storage, Security, and Authorization

Binary bytes MUST live in MinIO or another approved private object store, never
in PostgreSQL. Browser-visible APIs MUST authenticate and authorize every
request, conceal out-of-scope resources, and never expose credentials, tokens,
private object locations, raw Job data, queue internals, or server-only
configuration. A short-lived, object-scoped upload or download capability is
the only permitted browser storage exception.

### V. Validation, Testing, and Phase Discipline

Server inputs MUST use Zod validation. Durable mutations and background work
MUST have proportionate unit, authorization, and controlled integration tests.
No phase MAY be marked complete without the required runtime evidence. No
schema migration, dependency, raw-SQL exception, mock substitution, or future
phase scope may be introduced without explicit approval. Every phase completion
report MUST state files, commands, environment-variable names, migration impact,
limitations, and the next approved phase.

## Architecture Authority

The Phase 0 lock consists of `docs/architecture.md`, `docs/job-system.md`,
`docs/bullmq-postgres-job-flow.md`, `docs/clone-repository-plan.md`, and
`docs/phases.md`, read with `AGENTS.md`. Historical ADRs and older feature
specifications provide context but cannot override this constitution or the
accepted architecture documents.

## Non-Negotiable Data and Security Rules

- Do not create workflow-specific Job tables such as `ImportJob` or `ExportJob`.
- Do not store binary data in PostgreSQL or use Redis as a Job-state store.
- Do not expose provider, storage, Redis, database, session, or encryption
  credentials in browser state, URLs, logs, public errors, or queue payloads.
- Keep authorization and ownership decisions server-side; never trust a
  browser-supplied owner or storage location.
- Use Prisma for database access. Raw SQL requires explicit documented approval
  limited to its stated operation.

## Development Workflow and Quality Gates

Each feature MUST have a specification, implementation plan, and ordered task
list before implementation. Plans MUST include a Constitution Check. Completion
requires task status backed by the required tests and a non-secret validation
record. Documentation and implementation MUST be amended together when an
approved architecture decision changes terminology or behavior.

## Governance

This constitution supersedes generic Spec Kit template guidance where they
conflict. Amendments require explicit user approval, a rationale, a semantic
version increment, and synchronization of affected architecture documents,
plans, tasks, and runtime guidance. Reviews MUST verify the five principles
before a phase is approved or a new phase begins.

**Version**: 1.0.0 | **Ratified**: 2026-07-22 | **Last Amended**: 2026-07-22
