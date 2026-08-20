# Tasks: Authentication + Ownership Guard

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [auth API contract](./contracts/auth-api.md), [ownership guard contract](./contracts/ownership-guard.md), and [mandatory authorization matrix](./contracts/authorization-matrix.md).

**Constraints**: Do not add packages, alter `prisma/schema.prisma`, create a migration, place credentials in browser state/logs, create a public worker endpoint, or implement Job processing. PostgreSQL remains the session and Job authority; BullMQ payloads remain `{ jobId }` only.

**Tests**: Required. Add TypeScript integration tests with the Node built-in test runner and the existing `tsx` loader. The permission matrix is mandatory.

## Phase 1: Setup

**Purpose**: Establish the verified scope and no-new-dependency test entry point before behavior changes.

- [X] T001 Inventory all protected pages, Route Handlers, Server Actions, and resource relationships in `specs/004-authentication-ownership-guard/contracts/route-coverage.md`.
- [X] T002 Add the Phase 004 Node test command without adding a dependency in `apps/web/package.json` for `apps/web/tests/auth-ownership/**/*.test.ts`.

---

## Phase 2: Foundational Authentication and Authorization

**Purpose**: Build the server-only primitives that block all user stories until complete.

**⚠️ CRITICAL**: Do not start user-story endpoint or resource work until this phase is complete.

- [X] T003 Create Zod signup/login validation and safe auth input types in `apps/web/src/lib/validation/auth.ts`.
- [X] T004 Implement server-only password hashing/verification, opaque cookie credential generation/hashing, session creation, session actor resolution, refresh rotation, logout revocation, and safe profile projection in `apps/web/src/lib/auth.ts`.
- [X] T005 Implement safe `401`, `403`, `404`, and `400` response helpers with non-cacheable responses in `apps/web/src/lib/authorization-response.ts`.
- [X] T006 Implement the final `DatasetPermission` map, owner/member role resolution, dataset-scoped authorization, owned SourceConnection guard, and cross-record dataset integrity primitives in `apps/web/src/lib/authorization.ts`.
- [X] T007 Replace proxy-header/default-development-actor browser authentication with the cookie-session route policy in `apps/web/src/proxy.ts`, keeping only `/api/health` and the five public auth operations public.
- [X] T008 Create isolated database/session/resource fixtures without secret values in `apps/web/tests/auth-ownership/helpers.ts`.
- [X] T009 Add foundational unit/integration coverage for session validity, role resolution, 401/403/404 mapping, and no actor/owner data from browser input in `apps/web/tests/auth-ownership/foundation.test.ts`.

**Checkpoint**: The server can resolve a cookie-backed actor and an authorized dataset permission without trusting proxy headers, browser ownership fields, or resource ids alone.

---

## Phase 3: User Story 1 — Create and Use an Account (Priority: P1) 🎯 MVP

**Goal**: A visitor can sign up or sign in, then retrieve only their safe current-user profile.

**Independent Test**: With a new email/password, signup returns `201` and an HTTP-only cookie; login returns `200`; `/api/auth/me` returns only the authenticated user's safe profile; malformed, duplicate, and invalid credential cases make no unsafe disclosure.

### Tests for User Story 1

- [X] T010 [P] [US1] Write contract/integration tests for signup, login, and current-user success/failure responses in `apps/web/tests/auth-ownership/auth-api.test.ts`.

### Implementation for User Story 1

- [X] T011 [US1] Implement `POST /api/auth/signup` with normalized-email uniqueness, password hashing, session creation, safe cookie, and safe response in `apps/web/src/app/api/auth/signup/route.ts`.
- [X] T012 [US1] Implement `POST /api/auth/login` with credential verification, session creation, safe cookie, and safe response in `apps/web/src/app/api/auth/login/route.ts`.
- [X] T013 [US1] Implement `GET /api/auth/me` using only the resolved active session and safe profile projection in `apps/web/src/app/api/auth/me/route.ts`.
- [X] T014 [US1] Record the independently verified signup/login/current-user results and response-secret review in `specs/004-authentication-ownership-guard/quickstart.md`.

**Checkpoint**: A user can create and use an account without client-visible credentials or proxy-header identity.

---

## Phase 4: User Story 2 — Maintain and End a Session Safely (Priority: P1)

**Goal**: A valid session refreshes safely and logout/invalid state denies subsequent protected access.

**Independent Test**: A valid session refreshes once with a replacement cookie; replaying its old credential, using a revoked credential, or using an expired credential returns `401`; logout returns `204` and prevents `/me` and refresh.

### Tests for User Story 2

- [X] T015 [P] [US2] Write refresh rotation, replay, expired/revoked session, logout, and protected-route test cases in `apps/web/tests/auth-ownership/session-lifecycle.test.ts`.

### Implementation for User Story 2

- [X] T016 [US2] Implement `POST /api/auth/refresh` with same-origin validation, one-time opaque credential rotation, replacement cookie, and `401` replay denial in `apps/web/src/app/api/auth/refresh/route.ts`.
- [X] T017 [US2] Implement idempotent `POST /api/auth/logout` that revokes only the resolved active session and clears its cookie in `apps/web/src/app/api/auth/logout/route.ts`.
- [X] T018 [US2] Apply server-side active-session checks to protected pages and existing browser-facing API routes listed in `specs/004-authentication-ownership-guard/contracts/route-coverage.md`.
- [X] T019 [US2] Record refresh, logout, stale-session, and protected-route results in `specs/004-authentication-ownership-guard/quickstart.md`.

**Checkpoint**: Session state is revocable, refresh credentials cannot be replayed, and missing/invalid sessions cannot access private routes.

---

## Phase 5: User Story 3 — Access Only Authorized Workspace Data (Priority: P1)

**Goal**: Dataset roles determine every protected data access and mutation, and known identifiers never bypass scope.

**Independent Test**: With two datasets and owner/manager/reviewer/labeler/non-member actors, every permission in the matrix returns its required `200`/`201`, `403`, or `404`; denied operations leave no database, queue, or storage side effect.

### Tests for User Story 3

- [X] T020 [P] [US3] Write the complete role-by-permission, non-member, and cross-dataset test matrix from `contracts/authorization-matrix.md` in `apps/web/tests/auth-ownership/permission-matrix.test.ts`.
- [X] T021 [P] [US3] Write resource-integrity tests for Asset, AssetVersion, Label, Annotation, SourceConnection, and Job dataset isolation in `apps/web/tests/auth-ownership/resource-integrity.test.ts`.
- [X] T022 [P] [US3] Write denial-side-effect tests that assert no durable record, queue delivery, or object operation follows an authorization failure in `apps/web/tests/auth-ownership/denial-side-effects.test.ts`.

### Implementation for User Story 3

- [X] T023 [US3] Apply dataset-scoped Asset read/update guards to image content and dimensions handlers in `apps/web/src/app/api/images/[imageId]/content/route.ts` and `apps/web/src/app/api/images/[imageId]/dimensions/route.ts`.
- [X] T024 [US3] Apply `dataset.read` and `label.manage` checks, server-derived dataset scope, and safe denials to label UI reads/actions in `apps/web/src/app/(app)/labels/page.tsx` and `apps/web/src/app/(app)/labels/actions.ts`.
- [X] T025 [US3] Apply `dataset.read`, annotation create/update/review permissions, creator ownership checks, canonical geometry validation, and required `Annotation.version` concurrency checks to `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx` and `apps/web/src/app/(app)/workspace/[datasetId]/actions.ts`.
- [X] T026 [US3] Apply dataset permission and owned-SourceConnection checks before repository reads/import persistence in `apps/web/src/app/api/gitea/repos/route.ts`, `apps/web/src/app/api/gitea/repos/[owner]/[repo]/tree/route.ts`, `apps/web/src/app/api/gitea/import/route.ts`, and `apps/web/src/lib/dataset-import.ts`.
- [X] T027 [US3] Enforce owner-only Dataset archive and manager non-owner-membership restrictions in `apps/web/src/app/(app)/datasets/actions.ts`.
- [X] T028 [US3] Create a server-only dataset-scoped Job read/cancel/export authorization boundary that stamps `createdById`, permits only `{ jobId }` queue payloads, and performs no worker processing in `apps/web/src/lib/jobs/authorization.ts`.
- [X] T029 [US3] Route all existing Gitea actor checks through the session and dataset authorization boundary instead of global `User.role` helpers in `apps/web/src/lib/gitea-route.ts` and `apps/web/src/lib/auth.ts`.
- [X] T030 [US3] Execute and record the mandatory targeted cases—labeler own-only update, reviewer taxonomy denial/review success, manager ownership/archive denial, owner archive, SourceConnection isolation, Job isolation, and cross-dataset reference denial—in `specs/004-authentication-ownership-guard/quickstart.md`.

**Checkpoint**: The finalized permission matrix is enforced for every covered resource, all cross-dataset identifiers are invisible, and unauthorized requests have no durable side effects.

---

## Phase 6: Polish and Cross-Cutting Validation

**Purpose**: Verify the complete phase without expanding into later processing or storage features.

- [X] T031 Run the Phase 004 Node tests, `pnpm typecheck`, and `pnpm --filter @annotationplatform/web lint`; record exact safe results in `specs/004-authentication-ownership-guard/quickstart.md`.
- [X] T032 Review browser responses, cookies, error paths, logs, and queue payload construction for password, session, provider-token, storage-credential, and encrypted-connection leakage in `specs/004-authentication-ownership-guard/quickstart.md`.
- [X] T033 Confirm all protected routes in `specs/004-authentication-ownership-guard/contracts/route-coverage.md` use the central session/authorization boundary and have a matching test or explicit out-of-scope record.
- [X] T034 Confirm no edits were made to `prisma/schema.prisma`, `prisma/migrations/`, generated Prisma files, worker processors, or binary-storage behavior; record Phase 004 limitations and stop in `specs/004-authentication-ownership-guard/quickstart.md`.

## Dependencies and Execution Order

```text
T001–T002
  → T003–T009 (foundational)
    → US1: T010–T014
      → US2: T015–T019
      → US3: T020–T030
        → T031–T034 (polish)
```

- US2 depends on the account/session capability delivered by US1.
- US3 depends on foundational session resolution; it can begin after T003–T009, but should be integrated only after US1 auth routes are available for end-to-end browser validation.
- No Job processor, repository cloning, bulk import workflow, or storage workflow task is permitted in this phase.

## Parallel Opportunities

- After T002, T003 and the route inventory follow-up portions of T001 can proceed independently.
- After T004–T008, US1 test T010 can run while route files T011–T013 are prepared.
- Within US3, T020, T021, and T022 can run in parallel; after the central guard is stable, T023 and T024 can run in parallel.
- T031 and T032 can run in parallel after all user-story checkpoints pass.

## Implementation Strategy

### MVP First

1. Complete T001–T009.
2. Complete US1 (T010–T014) and validate signup, login, and current-user independently.
3. Stop for review before moving to session lifecycle or ownership coverage if approval is constrained.

### Incremental Delivery

1. Add US2 to make sessions refreshable and revocable.
2. Add US3 as the protected data boundary with the mandatory matrix and no-side-effect assertions.
3. Complete Polish only after all matrix rows pass.

## Task Format Validation

- All 34 tasks use the required `- [ ] T### [P] [US#] description with path` format.
- Story labels appear only on US1, US2, and US3 tasks.
- `[P]` appears only on independently executable test or route tasks.
