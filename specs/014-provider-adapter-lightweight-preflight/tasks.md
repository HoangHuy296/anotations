# Tasks: Provider Adapter + Lightweight Preflight

**Input**: [spec.md](./spec.md), [plan.md](./plan.md),
[research.md](./research.md), [data-model.md](./data-model.md), and
[contracts](./contracts/)

**Tests**: Required. The specification and constitution require adapter,
authorization, redaction, no-side-effect, and controlled authenticated HTTP
evidence. Do not mark a runtime task complete without its redacted evidence.

**Scope guard**: Phase 014 must not create/update a Dataset, Job, JobEvent,
SourceConnection, ExternalRepository, Asset, persisted manifest, Redis/BullMQ
delivery, or MinIO object. Do not clone or download source bytes. Do not change
`prisma/schema.prisma`, create a migration, add a dependency, or alter a legacy
Gitea import/source-job route.

## Phase 1: Setup and Scope Guards

**Purpose**: Establish test locations and make the phase boundary executable.

- [X] T001 Record the no-schema/no-migration/no-dependency/no-durable-write scope guard and required validation commands in `specs/014-provider-adapter-lightweight-preflight/quickstart.md`.
- [X] T002 [P] Create the provider-preflight test directory and server-only test registration convention in `apps/web/tests/repository-preflight/helpers.ts`.
- [X] T003 [P] Add the targeted provider-preflight test command without changing unrelated test commands in `apps/web/package.json`.

---

## Phase 2: Foundational Provider Boundary

**Purpose**: Build the shared, server-only contract all user stories require.

**⚠️ CRITICAL**: Complete this phase before implementing any route or provider
adapter. It is the boundary that prevents legacy import code from being used.

- [X] T004 Define transient preflight, resolved-ref, bounded-listing, credential-context, and safe-result types; keep `downloadFile` declared but Phase-014-unreachable in `apps/web/src/lib/providers/provider.types.ts`.
- [X] T005 [P] Define internal provider errors and the one-way mapping to safe preflight/error envelopes in `apps/web/src/lib/providers/provider-errors.ts` and `apps/web/src/lib/api-response.ts`.
- [X] T006 [P] Implement strict Zod validation that accepts only provider/repository/ref/rootPath/sourceConnectionId and rejects tokens, owner/policy/queue/storage/manifest fields in `apps/web/src/lib/validation/repository-preflight.ts`.
- [X] T007 Build the server-only provider registry that supports only GitHub and Gitea and rejects all other providers in `apps/web/src/lib/providers/provider-registry.ts`.
- [X] T008 Implement the server-only owned-connection token resolver wrapper that reuses Phase 013 ownership/ACTIVE/revoked/expiry controls and never returns a token to callers outside provider code in `apps/web/src/lib/providers/token-check.ts`.
- [X] T009 Implement shared preflight coordination order—actor result, normalized request, concealed connection resolution, policy validation, adapter call, safe projection—in `apps/web/src/lib/providers/preflight-repository.ts`.
- [X] T010 [P] Add contract/unit tests for strict schema, registry selection, safe error mapping, and the prohibition on calling `downloadFile` in `apps/web/tests/repository-preflight/provider-contract.test.ts`.
- [X] T011 [P] Add reusable controlled-provider, opaque-cookie HTTP, PostgreSQL/isolated-Redis/MinIO snapshot, and sentinel-redaction helpers in `apps/web/tests/repository-preflight/helpers.ts`.

**Checkpoint**: One server-only typed boundary exists; it has no persistence,
queue, storage, clone, download, or legacy import path.

---

## Phase 3: User Story 1 — Preflight an Accessible Repository (Priority: P1) 🎯 MVP

**Goal**: An authorized user can obtain a safe transient confirmation that an
accessible GitHub or Gitea repository, exact/default ref, and optional root
path are usable.

**Independent Test**: Through normal opaque-cookie login and the real route,
a controlled public GitHub/Gitea fixture and an owned active Gitea connection
return the safe DTO while all durable/queue/storage snapshots remain unchanged.

### Tests for User Story 1

- [X] T012 [P] [US1] Write controlled provider-client contract tests for repository existence, supplied/default ref, and bounded root-path metadata checks in `apps/web/tests/repository-preflight/provider-adapters.test.ts`.
- [X] T013 [P] [US1] Write authenticated HTTP success tests for public GitHub, public Gitea, and owned active Gitea connection preflight in `apps/web/tests/repository-preflight/preflight-route.test.ts`.
- [X] T014 [P] [US1] Write snapshot assertions proving every successful preflight leaves Dataset, Job, JobEvent, SourceConnection, ExternalRepository, Asset, isolated Redis/BullMQ, and MinIO prefix unchanged in `apps/web/tests/repository-preflight/preflight-no-side-effects.test.ts`.

### Implementation for User Story 1

- [X] T015 [P] [US1] Implement bounded, redirect-aware GitHub metadata/ref/root client operations with anonymous-public access only in `apps/web/src/lib/providers/github/github.client.ts`.
- [X] T016 [P] [US1] Implement GitHub response-to-safe-result/error mapping and the GitHub adapter in `apps/web/src/lib/providers/github/github.mapper.ts` and `apps/web/src/lib/providers/github/github.provider.ts`.
- [X] T017 [P] [US1] Implement bounded, redirect-aware Gitea metadata/ref/root client operations without using recursive tree/file-download legacy helpers in `apps/web/src/lib/providers/gitea/gitea.client.ts`.
- [X] T018 [P] [US1] Implement Gitea response-to-safe-result/error mapping and the Gitea adapter in `apps/web/src/lib/providers/gitea/gitea.mapper.ts` and `apps/web/src/lib/providers/gitea/gitea.provider.ts`.
- [X] T019 [US1] Integrate the two adapters into the coordinator, ensuring omitted refs resolve a provider default, supplied refs remain exact, and root checks remain bounded in `apps/web/src/lib/providers/preflight-repository.ts`.
- [X] T020 [US1] Add the authenticated no-store preflight Route Handler with safe success DTO projection in `apps/web/src/app/api/source-repositories/preflight/route.ts`.
- [X] T021 [US1] Run the targeted success suites and record redacted controlled-HTTP evidence, duration, and zero-side-effect snapshots in `specs/014-provider-adapter-lightweight-preflight/quickstart.md`.

**Checkpoint**: US1 is independently demoable without a Dataset, Job, queue
delivery, storage object, clone, download, or persisted manifest.

---

## Phase 4: User Story 2 — Receive Safe Failures Before Durable Work (Priority: P1)

**Goal**: Invalid, unsafe, inaccessible, or foreign preflight requests return
their documented safe outcome before provider access or durable work.

**Independent Test**: Authenticated controlled HTTP requests cover invalid
body, unsafe address/DNS/redirect, foreign connection, repository/token/ref/
root failures and prove no provider call where the request is rejected before
provider access plus unchanged durable/Redis/MinIO snapshots.

### Tests for User Story 2

- [ ] T022 [P] [US2] Add HTTP validation and failure-code tests for unsupported provider, forbidden body fields, malformed input, repository missing, access denial, missing ref, and missing root path in `apps/web/tests/repository-preflight/preflight-route.test.ts`.
- [ ] T023 [P] [US2] Add deterministic URL/DNS policy tests for userinfo/query/fragment, numeric/default-denied IPs, loopback/private addresses, resolver failure, and mixed public/private DNS answers in `apps/web/tests/repository-preflight/preflight-security.test.ts`.
- [ ] T024 [P] [US2] Add controlled redirect-hop tests for allowed-to-blocked destination, outside-policy destination, redirect loop, and no outbound call after policy denial in `apps/web/tests/repository-preflight/preflight-security.test.ts`.
- [ ] T025 [P] [US2] Add foreign/unknown/malformed SourceConnection concealment and provider-call-count tests using normal login cookies in `apps/web/tests/repository-preflight/preflight-security.test.ts`.
- [ ] T026 [P] [US2] Add invalid/expired Gitea credential and private-GitHub-without-approved-connection tests, including stable code and response-redaction assertions in `apps/web/tests/repository-preflight/preflight-security.test.ts`.
- [ ] T027 [P] [US2] Expand before/after snapshot assertions for every denial: exact durable IDs/canonical fields, JobEvent count, isolated Redis delivery keys, MinIO prefix, and no raw provider/Prisma error in `apps/web/tests/repository-preflight/preflight-no-side-effects.test.ts`.

### Implementation for User Story 2

- [X] T028 [US2] Apply shared source-access policy before every provider request and each redirect hop; map unsafe input to `UNSAFE_REPOSITORY_URL` without echoing unsafe locations in `apps/web/src/lib/providers/github/github.client.ts` and `apps/web/src/lib/providers/gitea/gitea.client.ts`.
- [X] T029 [US2] Implement normalized mappings for not-found, access-denied, expired/invalid token, missing ref/root, and safe operational unavailability in `apps/web/src/lib/providers/provider-errors.ts` and `apps/web/src/lib/providers/preflight-repository.ts`.
- [X] T030 [US2] Enforce concealed foreign/unknown connection semantics and private-GitHub denial before any adapter invocation in `apps/web/src/lib/providers/token-check.ts` and `apps/web/src/lib/providers/preflight-repository.ts`.
- [X] T031 [US2] Project only stable non-secret HTTP errors, no stack traces, and no request/private URL echo in `apps/web/src/app/api/source-repositories/preflight/route.ts`.
- [ ] T032 [US2] Run the failure/security/no-side-effect suites against controlled Compose services and append only redacted results to `specs/014-provider-adapter-lightweight-preflight/quickstart.md`.

**Checkpoint**: All invalid requests fail before durable work; pre-policy and
foreign connection denials make no provider request.

---

## Phase 5: User Story 3 — Use One Provider-Neutral Preflight Contract (Priority: P2)

**Goal**: GitHub and Gitea use one consistent safe adapter contract while
preserving provider-specific authorization and error behavior.

**Independent Test**: Each supported provider reaches the same safe result
shape for success and the same normalized error categories for equivalent
controlled failures; private GitHub remains denied without a credential
lifecycle change.

### Tests for User Story 3

- [ ] T033 [P] [US3] Add cross-provider contract tests that compare safe DTO shape, exact-ref behavior, bounded root behavior, and normalized failures in `apps/web/tests/repository-preflight/provider-adapters.test.ts`.
- [ ] T034 [P] [US3] Add authenticated HTTP parity tests for anonymous public GitHub/Gitea, owned credentialed Gitea, and denied private GitHub in `apps/web/tests/repository-preflight/preflight-route.test.ts`.
- [ ] T035 [P] [US3] Add response/log sentinel-redaction audit coverage for success, semantic failures, and provider-unavailable results in `apps/web/tests/repository-preflight/preflight-redaction.test.ts`.

### Implementation for User Story 3

- [X] T036 [US3] Finalize registry/provider type compatibility so adapter implementations cannot return raw provider DTOs, full listings, or credentials in `apps/web/src/lib/providers/provider.types.ts`, `apps/web/src/lib/providers/provider-registry.ts`, and `apps/web/src/lib/providers/preflight-repository.ts`.
- [X] T037 [US3] Ensure all route result paths use the contract’s safe DTO and `Cache-Control: no-store` behavior in `apps/web/src/app/api/source-repositories/preflight/route.ts`.
- [ ] T038 [US3] Run the cross-provider parity/redaction suite under the controlled provider fixture and record redacted evidence in `specs/014-provider-adapter-lightweight-preflight/quickstart.md`.

**Checkpoint**: Both adapters are interchangeable through the common contract;
no credential lifecycle or import behavior was added.

---

## Phase 6: Polish, Full Validation, and Scope Audit

**Purpose**: Verify the implementation stays within Architecture Lock and has
repeatable evidence before Phase 014 can close.

- [X] T039 [P] Update safe endpoint/provider contract commentary and test command documentation in `specs/014-provider-adapter-lightweight-preflight/contracts/repository-preflight-api.md` and `specs/014-provider-adapter-lightweight-preflight/quickstart.md`.
- [X] T040 Run Prisma validation, web typecheck, lint, and targeted provider-preflight suites; record pass/fail counts without secrets in `specs/014-provider-adapter-lightweight-preflight/quickstart.md`.
- [ ] T041 Run a redacted controlled Compose authenticated HTTP matrix with isolated passworded Redis and MinIO snapshot prefix; include provider fixtures, normal login, duration, and no-side-effect evidence in `specs/014-provider-adapter-lightweight-preflight/quickstart.md`.
- [X] T042 Run the web production build and record the result in `specs/014-provider-adapter-lightweight-preflight/quickstart.md`.
- [X] T043 Perform a final scope audit against `AGENTS.md`, `docs/architecture.md`, and `specs/014-provider-adapter-lightweight-preflight/spec.md`; verify no schema/migration/dependency/raw-SQL/legacy-import/Job/queue/MinIO changes in `specs/014-provider-adapter-lightweight-preflight/quickstart.md`.

---

## Dependencies and Execution Order

```text
Setup (T001–T003)
  → Foundation (T004–T011)
    → US1 accessible preflight (T012–T021)
    → US2 safe failures (T022–T032; requires US1 route/coordinator)
      → US3 provider-neutral parity (T033–T038)
        → Final validation/audit (T039–T043)
```

US1 is the MVP. US2 follows the established HTTP boundary so its security
matrix tests the real route rather than a service in isolation. US3 finalizes
cross-provider parity after both adapters are working.

## Parallel Opportunities

- Foundation: T005, T006, T010, and T011 can proceed in parallel after T004.
- US1: T012–T014 and T015–T018 are parallel within their test/adapter groups;
  T019–T021 follow them.
- US2: T022–T027 can be prepared in parallel; T028–T031 integrate serially;
  T032 is the runtime gate.
- US3: T033–T035 are parallel; T036–T038 follow the completed adapter work.
- Final: T039 can run in parallel with code validation, but T041–T043 require
  all prior tests and built web image.

## Implementation Strategy

## Approved amendment tasks — Hybrid Gitea credential UX

**Scope guard**: `POST /api/source-import-preflight` remains read-only in all
credential modes. T046 is the explicit approved exception for Start Import:
it replaces—not supplements—the legacy persistence route and may create a
Dataset, an encrypted owned Gitea SourceConnection, and a recoverable QUEUED
Job. It must enqueue exactly `{ jobId }` only after the transaction commits.

- [X] T044 [P] Add strict credential-mode, transient one-time PAT, and save-intent validation plus preflight contract coverage in `apps/web/src/lib/validation/source-connection.ts`, `apps/web/src/lib/source-import/preflight.ts`, and `specs/014-provider-adapter-lightweight-preflight/contracts/repository-preflight-api.md`.
- [X] T045 [P] Add accessible Public/existing SourceConnection/one-time PAT controls and conditional Server URL, PAT, and save fields in `apps/web/src/components/imports/import-form.tsx`; no PAT may enter React state, preview state, localStorage, or a browser DTO.
- [X] T046 Replace legacy `/api/gitea/import` usage with the authorized Start Import transaction: re-preflight, create Dataset + optional encrypted saved Gitea SourceConnection + QUEUED Job atomically, then enqueue `{ jobId }` only after commit in `apps/web/src/app/api/source-import-jobs/route.ts` and `apps/web/src/lib/queue/enqueue-job.ts`; legacy route returns `410 GITEA_IMPORT_DEPRECATED`.
- [X] T047 Add normal-cookie HTTP, no-side-effect, and redaction tests for all credential modes and save-on-start behavior in `apps/web/tests/repository-preflight/` and `apps/web/tests/source-connections/`.

### MVP first

1. Finish T001–T011.
2. Finish US1 through T021 and validate it independently.
3. Stop for approval before executing later stories if phase discipline or
   runtime infrastructure requires it.

### Incremental delivery

1. Add US2 only after the happy path proves no durable side effects.
2. Add US3 parity after each adapter is individually safe.
3. Close the phase only after T040–T043 have redacted runtime evidence.
