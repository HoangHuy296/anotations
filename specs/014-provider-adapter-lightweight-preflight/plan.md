# Implementation Plan: Provider Adapter + Lightweight Preflight

**Branch**: `014-provider-adapter-lightweight-preflight` | **Date**: 2026-07-23 | **Spec**: [spec.md](./spec.md)

## Summary

Introduce one authenticated, read-only repository-preflight boundary. A
provider-neutral adapter registry will check GitHub or Gitea repository access,
an exact or default ref, and an optional normalized root path. It will reuse
the Phase 013 opaque-session, SourceConnection ownership/encryption, and SSRF
policy controls. The boundary returns a safe transient result or stable
sanitized error; it never creates Dataset/Job/queue/storage state, clones a
repository, downloads source bytes, or persists a manifest.

## Technical Context

**Language/Version**: TypeScript 5.9; Node.js 22; Next.js App Router 16.2.

**Primary Dependencies**: Next.js Route Handlers, Zod 4, Prisma client,
existing opaque-cookie authentication, `@fieldframe/domain` source-access
policy, Node fetch/streams. No new dependency is planned.

**Storage**: PostgreSQL SourceConnection is read-only for this phase; its
credential is decrypted only in server memory after authorization. PostgreSQL,
Redis/BullMQ, and MinIO have no preflight writes.

**Testing**: Node built-in test runner with `tsx`; existing Vitest policy suite
where deterministic resolver coverage is useful; controlled provider fixtures
and authenticated Compose HTTP tests for end-to-end evidence.

**Target Platform**: Server-only web application code and private controlled
provider fixtures; no browser-to-provider call and no worker processing.

**Project Type**: Monorepo web application with a public Route Handler and
server-only provider clients.

**Performance Goals**: A successful bounded preflight completes within 10
seconds in controlled tests; it reads only minimum repository/ref/path metadata
and never lists an unbounded tree.

**Constraints**: Opaque-session authorization first; strict Zod body; no
browser token/policy override; fresh SSRF/DNS validation before provider
access and for every redirect hop; token/URL/provider diagnostic redaction;
zero durable side effects; queue payload prohibition.

**Scale/Scope**: One POST endpoint and two adapters (GitHub, Gitea). GitHub
public anonymous checks and existing owned Gitea credentialed checks are in
scope. Private GitHub access is deliberately denied until an approved GitHub
SourceConnection lifecycle exists.

## Constitution Check

| Principle | Plan assessment |
| --- | --- |
| Architecture authority | Pass. The public Route Handler authenticates, authorizes, validates, and performs only bounded synchronous metadata checks. No worker/public-backend role changes. |
| Durable state and retry lineage | Pass. Preflight creates no Job, queue delivery, retry lineage, or durable manifest. |
| Annotation/workspace state | Pass. No annotation or workspace behavior changes. |
| Private storage, security, authorization | Pass. Existing SourceConnection is resolved server-side; tokens, encrypted fields, private URLs, diagnostics, and configuration never enter DTOs, logs, or browser state. |
| Validation/testing/phase discipline | Pass. Zod, ownership, SSRF, response-redaction, no-side-effect, adapter, and controlled HTTP tests are planned. No migration, dependency, raw SQL, or future import work is authorized. |

**Pre-design gate result**: PASS. The sole deliberate extension is a server-only
provider adapter boundary required by the approved specification.

## Research Decisions

See [research.md](./research.md). All technical decisions are resolved; no
implementation clarification remains.

## Project Structure

### Documentation

```text
specs/014-provider-adapter-lightweight-preflight/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── repository-preflight-api.md
    ├── provider-adapter-contract.md
    └── preflight-security-boundary.md
```

### Source Code

```text
apps/web/src/
├── app/api/source-repositories/preflight/route.ts
├── lib/
│   ├── auth.ts                         # existing opaque-session actor lookup
│   ├── source-access-policy.ts         # existing Phase 013 policy facade
│   ├── source-connection-service.ts    # existing server-only owned-token resolver
│   ├── validation/repository-preflight.ts
│   └── providers/
│       ├── provider.types.ts
│       ├── provider-errors.ts
│       ├── provider-registry.ts
│       ├── preflight-repository.ts
│       ├── token-check.ts
│       ├── github/{github.provider.ts,github.client.ts,github.mapper.ts}
│       └── gitea/{gitea.provider.ts,gitea.client.ts,gitea.mapper.ts}
└── tests/repository-preflight/
    ├── provider-adapters.test.ts
    ├── preflight-route.test.ts
    ├── preflight-security.test.ts
    └── preflight-no-side-effects.test.ts
```

**Structure Decision**: Keep provider protocol code in a new server-only
`lib/providers` boundary, request parsing in `lib/validation`, and the one
browser-facing operation in its Route Handler. Existing legacy Gitea import
and source-job endpoints remain untouched and must not be called by preflight.

## Implementation Sequence

1. Define transient provider types, normalized error taxonomy, registry, and
   strict request schema; extend only safe public error/DTO typing as required.
2. Build a shared server-only preflight coordinator: actor → schema → owned
   connection eligibility when supplied → URL/DNS/redirect validation → adapter
   call → safe result/error projection.
3. Add GitHub and Gitea clients/mappers/adapters. Use bounded repository/ref/
   root metadata operations; `downloadFile` remains declared but unreachable.
4. Add the authenticated POST route with `no-store` responses and concealment
   for foreign/malformed connection identifiers.
5. Add unit, contract, and controlled HTTP test matrices, including provider
   redirect fixtures and before/after PostgreSQL/Redis/MinIO snapshots.
6. Run typecheck, lint, targeted suites, controlled Compose HTTP tests, and
   build. Record only redacted evidence before tasks may be marked complete.

## Post-design Constitution Check

PASS. The final design preserves PostgreSQL as source of truth by avoiding all
durable writes; Redis/BullMQ remain unused; MinIO remains unused; provider
credentials stay server-only; no raw SQL, migration, dependency, or later
clone/import capability appears in the design.

## Complexity Tracking

No constitution exception or additional complexity justification is required.
