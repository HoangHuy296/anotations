# Phase 004 Validation Quickstart

## Preconditions

- Phase 003 services are healthy: web, PostgreSQL, Redis, MinIO, and private worker.
- Prisma client is generated and the existing migrations are applied. This phase adds no migration.
- Use an isolated local development database with two or more test users, two datasets, and memberships representing OWNER, MANAGER, REVIEWER, and LABELER.
- Do not print cookie values, password values, database credentials, provider tokens, or MinIO credentials in terminal output or test fixtures.

## Validate authentication lifecycle

1. Submit valid signup input to `POST /api/auth/signup`; expect `201`, a safe profile, and an HTTP-only cookie.
2. Request `GET /api/auth/me` using that cookie; expect `200` and only the safe profile fields specified in [auth-api.md](./contracts/auth-api.md).
3. Sign out with `POST /api/auth/logout`; expect `204`. Repeat `/me` and refresh with the old browser state; expect `401`.
4. Sign in again, call `POST /api/auth/refresh`, then verify the prior credential no longer authenticates while the replacement credential does.
5. Test malformed, expired, and revoked session state; each must return `401` and establish no new session.

## Validate permission matrix

Run every row in [authorization-matrix.md](./contracts/authorization-matrix.md):

1. For each listed permission, execute it as an allowed role and verify `200` or `201` plus only the intended record change.
2. Execute it as an in-dataset role without permission and verify `403` with no database, queue, or binary side effect.
3. Execute it as a user outside the Dataset and verify `404` with no protected metadata.
4. Execute it with a known resource identifier from another Dataset and verify `404`; assert no cross-dataset relation is created.
5. Run each targeted regression case, including labeler own-only updates, reviewer taxonomy denial, manager ownership/archive denial, owner archive behavior, SourceConnection isolation, Job isolation, and same-dataset reference integrity.

## Required project checks after implementation

Run the existing project checks from the repository root:

```bash
pnpm typecheck
pnpm --filter @fieldframe/web lint
node --import tsx --test apps/web/tests/auth-ownership/**/*.test.ts
```

A passing integration-test result must include every mandatory authentication and authorization matrix case.

## Phase 004 execution record (2026-07-14)

- `pnpm --filter @fieldframe/web typecheck` passed.
- `pnpm --filter @fieldframe/web lint` passed.
- `pnpm --filter @fieldframe/web build` passed outside the restricted shell; the restricted shell cannot bind Turbopack's internal worker port.
- `pnpm --filter @fieldframe/web test:auth-ownership` passed in a short-lived Compose-network container: 13 tests passed, 0 failed. The host command cannot reach the Compose-only `postgres` hostname. Test fixtures use Prisma only, create uniquely named temporary records, and remove them after each case.
- The matrix covers owner/manager/reviewer/labeler/outsider outcomes, session expiry/revocation/rotation, SourceConnection ownership, cross-dataset Asset/Label references, Job denial side effects, and queue payload shape.

## Security review record

- Password hashes, opaque session values, SourceConnection plaintext, encrypted connection values, provider credentials, MinIO credentials, and database/Redis credentials are not returned from route responses or test output.
- `SOURCE_CONNECTION_ENCRYPTION_KEY` is read only by `source-connection-crypto.ts` in server-only code. It is not serialized, logged, or queued.
- PostgreSQL remains authoritative for sessions and durable Jobs. The Job helpers never enqueue; when enqueue is added in a later approved phase, it must call `cleanJobPayload(job.id)` and carry only `{ jobId }`.
- Denied Job creation tests verify, through Prisma assertions, that no Job row is written. These Phase 004 paths do not perform object-storage operations or queue delivery.

## Phase 004 limitations

- No password reset, email verification, rate limiting, external identity provider, or ownership transfer is included.
- SourceConnection creation/rotation UX is outside this phase; existing records must contain authenticated encrypted ciphertext and an active status before Gitea browsing or import is available.
- Job authorization is a server-only durable boundary. Browser Job APIs, enqueueing, worker processing, exports, and repository cloning remain later approved work.
- Annotation actions are guarded server actions; canvas wiring and advanced geometry editors remain outside this authorization phase.

## Expected security evidence

- Browser responses and client state contain no password, session secret, refresh credential, provider token, storage credential, or encrypted source-connection value.
- PostgreSQL remains the authority for sessions and Jobs.
- BullMQ payloads remain `{ jobId }` only.
- Unauthorized requests produce no durable record, enqueue, or MinIO object.
