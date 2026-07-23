# Implementation Plan: Source Connections Security Layer

**Branch**: `013-source-connections-security-layer` | **Date**: 2026-07-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/013-source-connections-security-layer/spec.md`

## Summary

Deliver a safe, owner-scoped Gitea source-connection foundation for private repositories. The public application validates a connection, stores token material only through the existing authenticated encryption helper, and returns only safe summaries. Source URL and root-path policy runs before provider access and immediately before worker-side access. Existing import flows carry a source-connection identifier plus allowlisted metadata only; tokens, provider diagnostics, and credential-bearing URLs never cross the browser, durable Job, or queue boundary.

The current Prisma `SourceConnection` model already contains owner, provider, encrypted-token, expiry, and status fields. This plan therefore starts with a schema-use audit and does not propose a migration unless that audit reveals a specific approved persistence gap.

## Technical Context

**Language/Version**: TypeScript 5.9; Node.js 22; Next.js App Router public application; private Node worker.  
**Primary Dependencies**: Existing Prisma client, Zod, opaque PostgreSQL-backed auth sessions, Node `crypto`, existing Gitea client; no new package planned.  
**Storage**: PostgreSQL is authoritative for `SourceConnection`, `Dataset`, and `Job`; MinIO is binary-only; Redis/BullMQ is transport-only and payload is exactly `{ jobId }`.  
**Testing**: Node built-in test runner with `tsx`; Prisma-backed authorization/integration fixtures; controlled Compose Gitea/PostgreSQL/Redis/MinIO only where real provider access is required.  
**Target Platform**: Browser-facing web application plus private worker in Linux Docker Compose and local developer environments.  
**Project Type**: Monorepo web application with a public Next.js boundary and a separate private worker.  
**Performance Goals**: Safe connection validation gives a user-visible result within 10 seconds for at least 95% of controlled local runs; denied input completes before a provider request, durable write, or enqueue.  
**Constraints**: Opaque cookie session only; Zod at public boundaries; AES-GCM token encryption only in server-only/worker-only code; no token in response/log/Job/queue; ownership is server-derived; numeric IP literals denied by default; only server-owned exact IP/CIDR allowlists may grant an exception; finite import limits are deployment configuration and browser input cannot override them; no raw SQL; no schema migration or dependency without explicit approval; public browser never calls provider with credentials.  
**Scale/Scope**: First provider is existing Gitea integration. Covers source connection list/create/delete, safe validation, owner/administrator oversight policy, shared SSRF/root-path policy, import-limit gates, and worker revalidation. Repository clone/import processing, OAuth refresh, key rotation, multi-provider UX, and repository browsing redesign are excluded.

## Constitution Check

### Pre-design gate

- **Architecture boundary — PASS**: Next.js remains the only public API; worker remains private. No duplicate backend is planned.
- **Durable state and retry lineage — PASS**: `SourceConnection` and any source-backed Job remain in PostgreSQL. Queue transport stays `{ jobId }`; no credentials or full source state are placed in Redis.
- **Canonical state — PASS**: This feature does not alter `Annotation.geometry`, `Annotation.revision`, or workspace-engine selection.
- **Private storage, security, authorization — PASS**: Token material is encrypted server-side, never browser-visible, and access is owner-scoped. SSRF/root-path checks occur before external access and are repeated by the worker.
- **Validation, testing, phase discipline — PASS**: Zod, safe errors, real authorization tests, and controlled provider integration tests are planned. No unapproved migration, raw SQL, dependency, or future clone/import implementation is proposed.

### Post-design gate

The generated research, data model, and contracts preserve all five principles: the existing model is reused; safe DTOs and error codes prevent secret leakage; provider calls are behind one policy boundary; jobs reference only connection IDs; and validation includes owner, SSRF, token-expiry, no-side-effect, worker-revalidation, and response-redaction evidence. **PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/013-source-connections-security-layer/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── source-connections-api.md
│   ├── source-access-security.md
│   └── source-job-boundary.md
└── tasks.md                 # Created later by /speckit-tasks
```

### Source Code (repository root)

```text
apps/web/src/
├── app/api/source-connections/
│   ├── route.ts
│   └── [id]/route.ts
├── app/api/gitea/           # existing authorized source routes
├── lib/
│   ├── authorization.ts
│   ├── source-connection-crypto.ts
│   ├── source-connection-service.ts       # planned owner-safe lifecycle service
│   ├── source-access-policy.ts             # planned shared URL/path/limit policy
│   ├── gitea-route.ts
│   ├── gitea.ts
│   └── validation/source-connection.ts     # planned Zod boundary schemas
└── tests/
    ├── auth-ownership/
    └── source-connections/                 # planned HTTP, policy, and redaction tests

apps/worker/src/
├── source/
│   └── source-access.ts                    # planned revalidation/decrypt boundary
└── jobs/                                   # existing job processors only

prisma/
└── schema.prisma                            # inspect/reuse; no change planned
```

**Structure Decision**: Keep browser-facing handling in the existing Next.js application, centralize source safety and safe DTO logic in web `lib`, and give the private worker a server-only source-access boundary that repeats policy validation before decryption/provider access. The existing Gitea client is adapted behind those boundaries rather than exposed to browser components.

## Delivery Sequence

1. Audit all `SourceConnection`, Gitea, Dataset import, and Job call sites against the contracts. Freeze the safe response DTO and ensure no route serializes `baseUrl`, encrypted fields, or provider details.
2. Define one shared URL, DNS destination, root-path, and configured-limit policy. Numeric IP host literals default-deny; only a server-controlled exact IP/CIDR allowlist may permit an exception. Establish controlled local provider access only through explicit trusted test configuration; no broad private-network bypass.
3. Implement owner-scoped lifecycle service and Zod schemas. It encrypts only after local safety checks, validates provider credentials server-side, and writes safe status transitions without logging inputs.
4. Expose list/create/delete route handlers that resolve the session actor first and use only safe DTO/error projections. Prevent deletion while non-terminal source-backed Jobs reference the connection.
5. Route existing Gitea/source import selection through the lifecycle and policy service. Preserve the existing canonical import gates: Start/preflight validates item count/logical path/declared aggregate size; capability locks object key/MIME/maximum size; completion verifies MinIO object metadata; commit reconciles completed items/canonical aggregate data. Restrict durable input to `sourceConnectionId` and allowlisted source metadata; do not broaden import/clone processing.
6. Add worker source-access resolver that reloads the authoritative connection, repeats URL/DNS/path/token-state validation, decrypts only in memory, maps expiration to `SOURCE_TOKEN_EXPIRED`, and never returns token material.
7. Add policy, HTTP authorization, denial-side-effect, provider-validation, worker-revalidation, Job-payload, and redaction tests. Run controlled Compose tests and record only non-secret evidence.

## Complexity Tracking

No constitution violation or additional project boundary is required.
