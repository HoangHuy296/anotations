# Implementation Plan: Authentication + Ownership Guard

**Branch**: `004-authentication-ownership-guard` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

## Summary

Deliver email-and-password authentication backed by the existing User and AuthSession records, with an opaque rotating session credential held only in an HTTP-only cookie. Add a server-only dataset authorization policy that applies the approved owner/manager/reviewer/labeler permission matrix to every protected route, action, resource relationship, and Job operation. This plan adds no dependency, schema change, migration, public worker endpoint, or queue state.

## Technical Context

**Language/Version**: TypeScript 5; Next.js 16 App Router; Node.js 22 container runtime.  
**Primary Dependencies**: Existing Next.js Route Handlers, Prisma custom-output client (`@internal/db`), Zod, Node built-in cryptography, and existing `server-only` boundary. No package installation is planned.  
**Storage**: PostgreSQL/Prisma holds User, AuthSession, Dataset, DatasetMember, and Job authority. Redis/BullMQ remains queue transport only; MinIO remains private binary storage only.  
**Testing**: Type checks, lint, and integration tests using the Node built-in test runner with the existing `tsx` loader (no new test package), including the mandatory permission matrix in [authorization-matrix.md](./contracts/authorization-matrix.md).  
**Target Platform**: Browser-facing Next.js application behind the existing reverse proxy; private worker remains non-browser-facing.  
**Project Type**: Monorepo web application with a private worker.  
**Performance Goals**: Authentication, guard resolution, and denial responses complete within 5 seconds under normal local operating conditions; denial occurs before any durable write or enqueue.  
**Constraints**: HTTP-only cookies; opaque session credential only; rotate refresh credentials; no plaintext password or token exposure; Zod validates browser inputs; authorization is server-derived; no raw SQL; no schema/migration changes; queue payload remains `{ jobId }` only.  
**Scale/Scope**: One authenticated user and one dataset-scoped role per request. Covers signup, login, logout, refresh, current-user, protected pages, and server-side authorization for Dataset, Asset, AssetVersion, Label, Annotation, SourceConnection, and Job operations. Password reset, external identity providers, MFA, and ownership transfer are out of scope.

## Constitution Check

The Spec Kit constitution is a placeholder. `AGENTS.md` and the Phase 0 architecture lock are authoritative.

| Gate | Result | Evidence |
| --- | --- | --- |
| Public boundary stays in Next.js | PASS | Authentication and authorization are browser-facing Route Handlers/server actions only; the worker serves no browser traffic. |
| PostgreSQL remains authoritative | PASS | User/AuthSession and every Job lifecycle remain in PostgreSQL; Redis carries no session or Job authority. |
| Credentials stay server-only | PASS | Passwords are never stored plaintext; opaque session credentials are HTTP-only cookies and only their hash is persisted. |
| Dataset is the authorization root | PASS | Every protected resource is resolved with its dataset scope before access or mutation. |
| No unauthorized side effect | PASS | Identity, dataset membership, permission, and relationship integrity checks precede writes, MinIO work, Job creation, or enqueue. |
| No unauthorized schema work | PASS | Existing schema is the source of truth; no migration is planned. |

**Post-design re-check**: PASS. The contracts and test matrix preserve these gates. No complexity exception is required.

## Permission Policy

The following permission vocabulary and matrix are final for this phase. `OWNER` is inferred from `Dataset.ownerId`; a DatasetMember record is not allowed to elevate or replace that fact. The `User.role` global field is not a substitute for dataset authorization.

| Permission | OWNER | MANAGER | REVIEWER | LABELER |
| --- | :---: | :---: | :---: | :---: |
| `dataset.read` | yes | yes | yes | yes |
| `dataset.update` | yes | yes | no | no |
| `dataset.delete` (archive only) | yes | no | no | no |
| `member.manage` (non-owner memberships only) | yes | yes | no | no |
| `asset.upload` | yes | yes | no | no |
| `asset.delete` | yes | yes | no | no |
| `label.manage` | yes | yes | no | no |
| `annotation.create` | yes | yes | yes | yes |
| `annotation.updateOwn` | yes | yes | yes | yes |
| `annotation.updateAny` | yes | yes | yes | no |
| `annotation.review` | yes | yes | yes | no |
| `repository.sync` | yes | yes | no | no |
| `job.createExport` | yes | yes | yes | no |
| `job.cancel` | yes | yes | no | no |

Policy invariants:

- `dataset.delete` means soft archive only. The phase exposes no ordinary hard-delete path.
- Managers cannot archive/delete datasets, change ownership, or create, modify, remove, or otherwise affect an OWNER membership.
- Reviewers may accept/reject through `annotation.review`; they cannot manage label taxonomy.
- Labelers may create and update only annotations they created; they cannot update another user's annotation.
- No user may select, view, use, or attach another user's SourceConnection, even if the identifier is known.
- Dataset-scoped Job views and cancellation require the Dataset authorization result, not `Job.createdById` or a known Job id alone.

## Security Response Policy

| Condition | Result | Disclosure / side effect rule |
| --- | --- | --- |
| Missing, malformed, expired, or revoked session | `401` | Clear only browser authentication state where applicable; reveal no protected data. |
| Authenticated actor is not owner/member of target dataset | `404` | Treat the target as absent within the actor's scope; create no record, queue message, or object. |
| Dataset member lacks the required permission | `403` | Do not return protected metadata beyond the policy denial; create no side effect. |
| Related resource belongs to another dataset | `404` | Treat as absent in the requested dataset; never trust the supplied id or repair the relation implicitly. |
| Invalid request body or impossible same-dataset relationship | `400` | Report only safe validation detail; do not mutate. |

## Project Structure

```text
apps/web/src/
├── app/
│   ├── api/auth/                         # signup, login, logout, refresh, current-user handlers
│   ├── api/                              # existing and future protected Route Handlers
│   └── (app)/                            # protected pages and same-origin actions
├── lib/
│   ├── auth.ts                           # session actor resolution and secure credential lifecycle
│   ├── authorization.ts                  # DatasetPermission matrix and dataset/resource guards
│   ├── db.ts                             # Prisma client
│   └── validation/                       # Zod schemas for auth and protected input
└── types/                                # safe server/client shared type declarations only

apps/web/tests/
└── auth-ownership/                       # Node integration tests for auth and the mandatory matrix

specs/004-authentication-ownership-guard/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── auth-api.md
    ├── authorization-matrix.md
    └── ownership-guard.md
```

**Structure Decision**: authentication and authorization stay in server-only `apps/web/src/lib` modules. Route Handlers and Server Actions call those modules before reading protected records or writing anything. UI components never determine identity, ownership, or permission. The legacy proxy-header identity mechanism is retired as a browser actor source: the five public auth operations and health endpoint remain reachable without it, and every protected browser request resolves identity from the database-backed cookie session. There is no proxy-header/cookie precedence path.

## Complexity Tracking

No constitution violations or complexity exceptions are planned.
