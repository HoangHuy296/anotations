# Tasks: Collaboration Platform

**Input**: Design documents from `/specs/024-collaboration-platform/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [REST contract](./contracts/collaboration-api.md), [realtime contract](./contracts/realtime-protocol.md), and [quickstart.md](./quickstart.md)

**Tests**: Required. The specification and quickstart require PostgreSQL transaction, HTTP contract, gateway integration, UI, and Phase 022/023 regression coverage. Write the focused test before its implementation task and confirm it fails for the intended missing behavior.

**Organization**: Tasks are grouped by user story. Phase 1 locks the remaining design decisions; Phase 2 is the shared durable and authorization foundation that blocks all user stories.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: May run in parallel after its stated dependencies because it edits different files.
- **[US#]**: Story label used only for story-specific tasks.
- All mutations remain in Next.js Route Handlers/Server Actions. The realtime gateway is delivery-only; it never becomes a command or authoritative-read backend.

## Phase 1: Architecture Decision Gate

**Purpose**: Lock the ten remaining choices before any Prisma migration, REST implementation, package addition, gateway process, proxy change, or realtime environment variable is introduced.

- [X] T001 Record Phase 024's decision log and gateway boundary in `docs/architecture/adrs/024-collaboration-realtime.md`, explicitly preserving Next.js as the command/read boundary and PostgreSQL as durable authority.
- [X] T002 Record exact assignment eligibility in `docs/architecture/adrs/024-collaboration-realtime.md`: only active `LABELER` members may hold `ANNOTATION`, only active `REVIEWER` members may hold `REVIEW`, and Owner/Manager may assign but never bypass target-role eligibility.
- [X] T003 Record the Prisma-safe pending-invitation invariant in `docs/architecture/adrs/024-collaboration-realtime.md`: use an `activeKey` equal to `PENDING` while pending and `NULL` at terminal states, with `@@unique([datasetId, inviteeUserId, activeKey])` and transactional conflict handling.
- [X] T004 Record the transactional-outbox decision and worker runtime owner in `docs/architecture/adrs/024-collaboration-realtime.md`: accepted commands write a safe idempotent outbox row in the same transaction, and the private worker dispatch Job publishes only after commit.
- [X] T005 Record membership-revocation behavior in `docs/architecture/adrs/024-collaboration-realtime.md`: membership change writes a revocation outbox event; the gateway consumes the resulting Redis event, drops the affected dataset scope, closes a connection with no remaining scope, and requires a fresh ticket to subscribe again.
- [X] T006 Record Redis multi-tab presence design in `docs/architecture/adrs/024-collaboration-realtime.md`: one connection ID per tab, expiring ZSET entries for dataset/asset scopes, and per-connection TTL state; aggregate by user with `EDITING` taking precedence over `VIEWING`.
- [X] T007 Record editing-presence semantics in `docs/architecture/adrs/024-collaboration-realtime.md`: `EDITING` means the selected asset is visible and the user recently interacted with an annotation/description editing surface; it downgrades after inactivity/blur and sends no geometry, draft, or lock data.
- [X] T008 Record reply-recipient policy in `docs/architecture/adrs/024-collaboration-realtime.md`: a reply notifies the root author and newly mentioned active members, excludes the actor, deduplicates recipients, and does not notify every earlier reply author.
- [X] T009 Record edit/mention policy in `docs/architecture/adrs/024-collaboration-realtime.md`: ordinary edits create no notification; mention associations are recomputed atomically and only newly added valid non-self mentions receive one notification.
- [X] T010 Record deletion/FK policy in `docs/architecture/adrs/024-collaboration-realtime.md`: dataset/asset deletion cascades collaboration domain rows and undelivered outbox events; notifications remain only as generic unavailable history with nulled context and no readable/deferred protected payload.
- [X] T011 Record the approved `ws` server package, new `apps/realtime` delivery process, Compose wiring, nginx upgrade forwarding, and non-secret gateway environment-variable names in `docs/architecture/adrs/024-collaboration-realtime.md`; gateway/package/deployment implementation remains scheduled for T061–T066.

**Checkpoint**: An approved ADR resolves all ten decisions. Do not begin Phase 2 until T001–T011 are complete.

---

## Phase 2: Foundational Durable, Authorization, and Delivery Prerequisites

**Purpose**: Establish the common schema, safe services, authorization, contracts, and outbox relay required by every collaboration story.

- [X] T012 Add collaboration enums, Prisma relations, cascade behavior, uniqueness constraints, and index design from `data-model.md` to `prisma/schema.prisma` without changing `Asset.status`, annotation revisions, or removing `Asset.assignedToId`.
- [X] T013 Create the reviewed Prisma migration in `prisma/migrations/20260904111916_collaboration_platform/migration.sql` and preserve the existing Phase 022/023 migrations unchanged.
- [X] T014 Add server-only collaboration domain types and safe DTOs in `apps/web/src/types/collaboration.ts` and exclude credentials, private URLs, comment bodies from audit DTOs, and annotation geometry from collaboration DTOs.
- [X] T015 Add Zod request/query validators for invitations, roles, assignments, comments, notification reads, and realtime tickets in `apps/web/src/lib/validation/collaboration.ts`.
- [X] T016 Extend server-side dataset authorization with explicit Owner/Manager/member-management, assignment-target, moderation, and current-membership helpers in `apps/web/src/lib/authorization.ts`.
- [X] T017 Implement a transaction-safe collaboration audit/outbox service that writes idempotent safe outbox events and creates/reuses the corresponding durable dispatch Job in `apps/web/src/lib/collaboration/collaboration-outbox-service.ts`.
- [X] T018 Implement durable notification creation, self-suppression, recipient/event dedupe, and safe deep-link construction in `apps/web/src/lib/collaboration/notification-service.ts`.
- [X] T019 Implement the private-worker-owned, idempotent outbox dispatch Job handler in `apps/worker/src/jobs/collaboration-outbox-relay.ts` and register it in `apps/worker/src/queue/queue-router.ts`; resolve/claim durable events through Prisma and publish safe Redis invalidation/revocation envelopes only after commit.
- [X] T020 Add shared REST error/response mappings for collaboration validation, authorization, conflicts, and concealed missing resources in `apps/web/src/lib/api-response.ts`.
- [X] T021 Update Phase 024 API and realtime schemas in `specs/api/openapi.yaml`, `specs/api/schemas/collaboration.yaml`, and `specs/024-collaboration-platform/contracts/realtime-protocol.md` without documenting WebSocket commands.
- [X] T022 Add Compose-backed collaboration fixture helpers for users, memberships, datasets, assets, transactions, and outbox observation in `apps/web/tests/collaboration/helpers.ts`.

**Checkpoint**: Migration, server-only authorization, validators, outbox, notification primitives, test fixtures, and OpenAPI foundations are ready. No user story begins before this checkpoint.

---

## Phase 3: User Story 1 — Manage Dataset Members and Roles (Priority: P1) 🎯 MVP

**Goal**: Authorized owners/managers can manage pending invitations and active roles, and access/realtime scope changes take effect immediately.

**Independent Test**: Invite an existing Labeler and Reviewer, accept one invitation, change an eligible role, remove a member, and prove the removed member loses subsequent REST and realtime access.

### Tests for User Story 1

- [X] T023 [P] [US1] Add PostgreSQL transaction tests for invitation uniqueness, accept/revoke/reissue, Owner/Manager role limits, and assignment cleanup on role/removal in `apps/web/tests/collaboration/dataset-membership-service.test.ts`.
- [X] T024 [P] [US1] Add HTTP authorization/concealment contract tests for member and invitation routes in `apps/web/tests/collaboration/dataset-membership-http.test.ts`.
- [X] T025 [P] [US1] Add current-membership authorization regression cases to `apps/web/tests/auth-ownership/permission-matrix.test.ts`.

### Implementation for User Story 1

- [X] T026 [US1] Implement invitation lifecycle, atomic acceptance, role change/removal, assignment cleanup, audit, notification, and revocation-outbox writes in `apps/web/src/lib/collaboration/dataset-membership-service.ts`.
- [X] T027 [US1] Expand the member directory and add invitation create/list/revoke routes in `apps/web/src/app/api/datasets/[datasetId]/members/route.ts` and `apps/web/src/app/api/datasets/[datasetId]/invitations/route.ts`.
- [X] T028 [US1] Implement invitation accept/decline routes in `apps/web/src/app/api/invitations/[invitationId]/accept/route.ts` and `apps/web/src/app/api/invitations/[invitationId]/decline/route.ts`.
- [X] T029 [US1] Implement invitation revoke and member role/remove routes in `apps/web/src/app/api/datasets/[datasetId]/invitations/[invitationId]/revoke/route.ts` and `apps/web/src/app/api/datasets/[datasetId]/members/[userId]/route.ts`.
- [X] T030 [US1] Add the dataset member directory and pending-invitation management UI in `apps/web/src/components/datasets/dataset-members-panel.tsx` and integrate it into `apps/web/src/app/(app)/datasets/[datasetId]/page.tsx`.
- [X] T031 [US1] Verify pending invitation, role, removal, assignment cleanup, and the removed member's next protected REST denial; record durable revocation-event evidence in `specs/024-collaboration-platform/quickstart.md`. Live WebSocket revocation is verified only in T067 after US5 exists.

---

## Phase 4: User Story 2 — Assign Annotation and Review Work (Priority: P1)

**Goal**: Owners/Managers independently manage one active annotation and one active review responsibility without changing the Phase 023 lifecycle.

**Independent Test**: Assign a Labeler and Reviewer to one asset, reassign/unassign each responsibility, and verify `Asset.status`, revisions, annotation content, and workflow history remain unchanged.

### Tests for User Story 2

- [X] T032 [P] [US2] Add PostgreSQL tests for one active `(assetId, type)` slot, role eligibility, reassignment history, removal cleanup, and `assignedToId` compatibility in `apps/web/tests/collaboration/asset-assignment-service.test.ts`.
- [X] T033 [P] [US2] Add assignment HTTP contract and cross-dataset authorization tests in `apps/web/tests/collaboration/asset-assignment-http.test.ts`.
- [X] T034 [P] [US2] Add regression assertions that assignment mutations preserve Phase 023 status/history and annotation revision in `apps/web/tests/workflow/assignment-collaboration-integrity.test.ts`.

### Implementation for User Story 2

- [X] T035 [US2] Implement typed assignment slot/history, legacy `assignedToId` dual-write/read fallback, notification recipients, audit, and invalidation outbox writes in `apps/web/src/lib/collaboration/asset-assignment-service.ts`.
- [X] T036 [US2] Implement authorized assignment read/create/reassign/unassign routes in `apps/web/src/app/api/datasets/[datasetId]/assets/[assetId]/assignments/route.ts` and `apps/web/src/app/api/datasets/[datasetId]/assets/[assetId]/assignments/[type]/route.ts`.
- [X] T037 [US2] Update safe asset-assignment projection reads in `apps/web/src/lib/workspace/workspace-assets.ts` and `apps/web/src/lib/workspace/workspace-read.ts`.
- [X] T038 [US2] Add independent annotation/review assignment controls to `apps/web/src/components/workspace/asset-assignment-panel.tsx` and integrate them into `apps/web/src/components/workspace/image-properties-tabs.tsx` and `apps/web/src/components/workspace/video-properties-tabs.tsx`.
- [X] T039 [US2] Verify the US2 independent acceptance flow and document the result in `specs/024-collaboration-platform/quickstart.md`.

---

## Phase 5: User Story 3 — Discuss an Asset in Threads (Priority: P1)

**Goal**: Dataset members discuss an asset through root threads and direct replies, with validated mentions, soft deletion, and independent resolution.

**Independent Test**: Two members create a root comment and direct reply, mention a third, resolve/reopen, edit/delete their own content, and confirm no Phase 023 feedback/history changes.

### Tests for User Story 3

- [X] T040 [P] [US3] Add PostgreSQL tests for root-only reply depth, same-asset parent checks, author/moderator rules, soft deletion, resolve/reopen, and mention recomputation in `apps/web/tests/collaboration/asset-comment-service.test.ts`.
- [X] T041 [P] [US3] Add discussion HTTP contract tests for scope, invalid parent, ownership, moderation, and deep-link-safe comment reads in `apps/web/tests/collaboration/asset-comment-http.test.ts`.
- [X] T042 [P] [US3] Add regression coverage proving discussion does not create workflow events, rejection feedback, status writes, or annotation revision writes in `apps/web/tests/workflow/discussion-workflow-separation.test.ts`.

### Implementation for User Story 3

- [X] T043 [US3] Implement root/direct-reply comment transactions, mention extraction, ownership/moderation, soft delete, resolution, audit, notification, and invalidation writes in `apps/web/src/lib/collaboration/asset-comment-service.ts`.
- [X] T044 [US3] Implement asset comment list/create routes in `apps/web/src/app/api/datasets/[datasetId]/assets/[assetId]/comments/route.ts`.
- [X] T045 [US3] Implement comment edit/delete/resolve/reopen routes in `apps/web/src/app/api/comments/[commentId]/route.ts`, `apps/web/src/app/api/comments/[commentId]/resolve/route.ts`, and `apps/web/src/app/api/comments/[commentId]/reopen/route.ts`.
- [X] T046 [US3] Implement the asset Discussion Drawer, root/reply composer, thread presentation, and soft-deleted display in `apps/web/src/components/workspace/discussion-drawer.tsx`.
- [X] T047 [US3] Connect the drawer to the selected image/video asset without replacing the Properties Panel in `apps/web/src/components/workspace/workspace-header.tsx` and `apps/web/src/components/workspace/properties-panel.tsx`.
- [X] T048 [US3] Verify the US3 independent acceptance flow and document the result in `specs/024-collaboration-platform/quickstart.md`.

---

## Phase 6: User Story 4 — Receive Durable Collaboration Notifications (Priority: P1)

**Goal**: Users receive idempotent offline-safe notifications, can manage read state, and safely navigate to authorized context.

**Independent Test**: While a recipient is offline, create assignment, mention, reply, and workflow decision; on return verify one of each expected notification, read controls, and safe deep links.

### Tests for User Story 4

- [X] T049 [P] [US4] Add durable-notification transaction tests for dedupe, retry, self-suppression, reply/mention policy, edit behavior, and workflow post-transition production in `apps/web/tests/collaboration/notification-service.test.ts`.
- [X] T050 [P] [US4] Add notification list/read/deep-link authorization tests in `apps/web/tests/collaboration/notification-http.test.ts`.
- [X] T051 [P] [US4] Add Phase 023 workflow notification no-regression tests in `apps/web/tests/workflow/workflow-notification-integration.test.ts`.

### Implementation for User Story 4

- [X] T052 [US4] Add notification listing, single read, and mark-all-read routes in `apps/web/src/app/api/notifications/route.ts`, `apps/web/src/app/api/notifications/[notificationId]/read/route.ts`, and `apps/web/src/app/api/notifications/read-all/route.ts`.
- [X] T053 [US4] Integrate recipient-deduplicated workflow notification and safe outbox intent into the same durable transaction that commits a successful Phase 023 workflow transition; relay dispatch occurs later and must not alter transition, stale-review, rejection-feedback, or `AssetWorkflowEvent` semantics in `apps/web/src/lib/workflow/asset-workflow-service.ts`.
- [X] T054 [US4] Add a safe notification list/unread-count client data layer in `apps/web/src/lib/collaboration/notification-client.ts`.
- [X] T055 [US4] Add the global Bell immediately before Account in `apps/web/src/components/layout/app-shell.tsx` and `apps/web/src/components/notifications/notification-bell.tsx`, including accessible count, zero-hidden badge, and `99+` cap.
- [X] T056 [US4] Add the workspace Bell/deep-link behavior in `apps/web/src/components/workspace/workspace-header.tsx` and `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx`.
- [X] T057 [US4] Verify the US4 independent offline and deep-link acceptance flow and document the result in `specs/024-collaboration-platform/quickstart.md`.

---

## Phase 7: User Story 5 — See Timely Collaboration Updates (Priority: P1)

**Goal**: Authorized connected users receive delivery/invalidation signals and converge through REST after reconnect, while the gateway remains transport-only.

**Independent Test**: Two authorized sessions observe comment, assignment, membership, and notification changes within five seconds; disconnected/revoked sessions cannot retain access and refresh from REST after reconnect.

### Tests for User Story 5

- [X] T058 [P] [US5] Add gateway integration tests for ticket expiry, dataset scope, revocation, duplicate/reordered events, reconnect invalidation, and command rejection in `apps/realtime/tests/gateway.integration.test.ts`.
- [X] T059 [P] [US5] Add HTTP ticket authorization and no-secret-response tests in `apps/web/tests/collaboration/realtime-ticket-http.test.ts`.
- [X] T060 [P] [US5] Add outbox relay retry/replay tests in `apps/web/tests/collaboration/collaboration-outbox.test.ts`.

### Implementation for User Story 5

- [X] T061 [US5] Add the approved delivery-only gateway package/runtime configuration in `apps/realtime/package.json`, `apps/realtime/tsconfig.json`, and `apps/realtime/src/index.ts` using the approved `ws` dependency only.
- [X] T062 [US5] Implement short-lived signed ticket issuance and server-side scope authorization in `apps/web/src/lib/realtime/ticket-service.ts` and `apps/web/src/app/api/realtime/ticket/route.ts`.
- [X] T063 [US5] Implement gateway ticket verification, connection/scope registry, safe envelope validation, and REST-only command rejection in `apps/realtime/src/gateway.ts`.
- [X] T064 [US5] Implement Redis fan-out consumption, membership-revocation handling, and per-scope connection closure in `apps/realtime/src/subscriptions.ts`; the gateway consumes only worker-published Redis envelopes and never reads, claims, or processes PostgreSQL outbox rows.
- [X] T065 [US5] Add browser reconnect/invalidation handling that refetches authoritative REST state in `apps/web/src/components/workspace/use-collaboration-realtime.ts`.
- [X] T066 [US5] Add normal/review Compose service, non-secret environment validation, health check, and websocket proxy forwarding in `docker-compose.yaml`, `docker-compose.review.yaml`, `docker/review-proxy.conf`, and `apps/realtime/src/env.ts`.
- [X] T067 [US5] Verify the US5 two-session/reconnect/revocation acceptance flow and document the result in `specs/024-collaboration-platform/quickstart.md`.

---

## Phase 8: User Story 6 — See Lightweight Presence (Priority: P2)

**Goal**: Authorized collaborators see aggregated, per-user viewing/editing presence that naturally expires and never blocks work.

**Independent Test**: Two tabs/sessions view one asset, one enters editing activity, presence aggregates per person, an expired tab disappears, and both retain all authorized actions.

### Tests for User Story 6

- [X] T068 [P] [US6] Add Redis TTL, multi-tab aggregation, expiry, editing-precedence, and no-lock gateway tests in `apps/realtime/tests/presence.integration.test.ts`.
- [X] T069 [P] [US6] Add workspace presence-state behavior tests in `apps/web/tests/workspace/collaboration-presence.vitest.spec.tsx`.

### Implementation for User Story 6

- [X] T070 [US6] Implement Redis connection/dataset/asset presence storage, heartbeat renewal, cleanup, and per-user aggregation in `apps/realtime/src/presence.ts`.
- [X] T071 [US6] Implement browser activity/heartbeat reporting with blur/inactivity downgrade and no geometry payload in `apps/web/src/components/workspace/use-workspace-presence.ts`.
- [X] T072 [US6] Add avatar stack and accessible presence details to `apps/web/src/components/workspace/collaboration-presence.tsx` and `apps/web/src/components/workspace/workspace-header.tsx`.
- [X] T073 [US6] Verify the US6 multi-tab expiry and **PRESENCE IS NOT A LOCK** acceptance flow in `specs/024-collaboration-platform/quickstart.md`.

---

## Phase 9: User Story 7 — Use Collaboration Without Losing Workspace Context (Priority: P2)

**Goal**: Collaboration controls fit the existing workspace header and selected asset while the Properties Panel and modality route remain intact.

**Independent Test**: On image and video assets, open/close Discussion, switch to Activity, view presence, and follow a comment notification without changing asset context or creating a fourth column.

### Tests for User Story 7

- [X] T074 [P] [US7] Complete workspace UI tests for Discussion drawer, Properties Panel preservation, Activity projection, Bell deep link, and image/video context in `apps/web/tests/workspace/collaboration-workspace-ui.vitest.spec.tsx`.
- [X] T075 [P] [US7] Add Activity projection authorization/redaction tests in `apps/web/tests/collaboration/activity-projection.test.ts`.

### Implementation for User Story 7

- [X] T076 [US7] Implement a read-only projection over existing collaboration and Phase 023 records, with no new Activity persistence, in `apps/web/src/lib/collaboration/activity-projection-service.ts`.
- [X] T077 [US7] Implement Activity tab rendering and discussion-comment highlight/deep-link state in `apps/web/src/components/workspace/discussion-drawer.tsx`.
- [X] T078 [US7] Wire discussion query state, selected asset synchronization, and safe comment deep links into `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx` and `apps/web/src/components/workspace/workspace-header.tsx`.
- [X] T079 [US7] Verify no permanent fourth column or modality-specific workspace route is introduced in `apps/web/src/components/workspace/properties-panel.tsx` and `apps/web/src/lib/workspace/workspace-engine-registry.tsx`.
- [X] T080 [US7] Verify the US7 image/video context acceptance flow and document the result in `specs/024-collaboration-platform/quickstart.md`.

---

## Phase 10: User Story 8 — Preserve Security and Operational Integrity (Priority: P2)

**Goal**: Collaboration remains correct under concurrent commands, removal, retries, failures, and Phase 022/023 regression.

**Independent Test**: Automated adversarial tests prove cross-dataset, post-removal, duplicate, invalid-role, other-user edit/delete, and unauthorized subscription paths disclose no protected state and create no duplicate durable records.

### Tests for User Story 8

- [X] T081 [P] [US8] Add cross-dataset, post-removal, deleted-context, and comment ownership attack tests in `apps/web/tests/collaboration/collaboration-security.test.ts`.
- [X] T082 [P] [US8] Add concurrent invitation/assignment/comment/notification idempotency race tests in `apps/web/tests/collaboration/collaboration-concurrency.test.ts`.
- [X] T083 [P] [US8] Add gateway unauthorized-subscription and revocation-race tests in `apps/realtime/tests/security.integration.test.ts`.

### Implementation for User Story 8

- [X] T084 [US8] Apply and verify cross-story remediation discovered during US1–US4: preserve their existing authorization/transaction controls while closing identified FK-delete, error-concealment, and audit-redaction gaps in `apps/web/src/lib/collaboration/dataset-membership-service.ts`, `apps/web/src/lib/collaboration/asset-assignment-service.ts`, `apps/web/src/lib/collaboration/asset-comment-service.ts`, and `apps/web/src/lib/collaboration/notification-service.ts`; do not defer baseline security to this phase.
- [X] T085 [US8] Apply and verify cross-story gateway remediation discovered during US5–US6: preserve their baseline scope checks, ticket expiry, revocation ordering, and redacted logging while closing identified gaps in `apps/realtime/src/gateway.ts` and `apps/realtime/src/subscriptions.ts`; do not defer baseline security to this phase.
- [X] T086 [US8] Verify the US8 independent attack, concurrency, reconnect, and Phase 023 semantic-regression acceptance flow in `specs/024-collaboration-platform/quickstart.md`.

---

## Phase 11: Polish, Documentation, and Closure Audit

**Purpose**: Complete cross-cutting documentation, operational validation, and closure without broad cleanup or semantic refactoring.

- [X] T087 [P] Update the approved ADR, delivery topology, non-secret configuration names, and operational runbook in `docs/architecture/adrs/024-collaboration-realtime.md` and `specs/024-collaboration-platform/quickstart.md`.
- [X] T088 [P] Complete OpenAPI operation/error coverage and bundle validation in `specs/api/openapi.yaml`, `specs/api/schemas/collaboration.yaml`, and `apps/web/tests/openapi-contract/collaboration.contract.test.ts`.
- [X] T089 Run the focused PostgreSQL collaboration transaction and HTTP contract suites recorded in `apps/web/tests/collaboration/` against Compose PostgreSQL/Redis and record results in `specs/024-collaboration-platform/quickstart.md`.
- [X] T090 Run `apps/realtime/tests/` against the Compose gateway/Redis topology and record ticket, revocation, retry, reconnect, and presence evidence in `specs/024-collaboration-platform/quickstart.md`.
- [X] T091 Run Phase 022 Asset Browser and Phase 023 workflow/revision/history regression suites in `apps/web/tests/workspace/` and `apps/web/tests/workflow/`, recording that `Asset.status` and annotation revision semantics remain unchanged in `specs/024-collaboration-platform/quickstart.md`.
- [X] T092 Run web typecheck, lint, OpenAPI validation/bundle, Docker Compose build, normal/review proxy smoke tests, and gateway health checks from `package.json`, `docker-compose.yaml`, `docker-compose.review.yaml`, and `docker/review-proxy.conf`.
- [X] T093 Perform the final authorization, credential-redaction, schema/FK, event-payload, and Activity-not-a-source-of-truth audit against `specs/024-collaboration-platform/spec.md`, `specs/024-collaboration-platform/plan.md`, and `docs/architecture/adrs/024-collaboration-realtime.md`.
- [X] T094 Mark validated tasks complete and document remaining manual acceptance evidence or approved deferrals in `specs/024-collaboration-platform/tasks.md`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 — Architecture Decision Gate**: No coding dependency; it blocks every later phase.
- **Phase 2 — Foundation**: Depends on T001–T011 and blocks all user stories.
- **US1**: Depends on Phase 2; provides actual membership management.
- **US2, US3, US4**: Depend on Phase 2 and may be developed in parallel after shared services stabilize. US2/US3 use US1-created memberships in end-to-end tests but can use fixtures for their independent tests.
- **US5**: Depends on Phases 1–2 and on the outbox producer paths from US1–US4 for full event coverage.
- **US6**: Depends on US5 gateway connectivity.
- **US7**: Depends on US3, US4, US5, and US6 UI/data surfaces.
- **US8**: Depends on the relevant completed story surfaces; its attack/race tests should begin alongside each story.
- **Phase 11**: Depends on all desired stories.

### User Story Completion Order

`Architecture gate → Foundation → US1 → {US2, US3, US4} → US5 → US6 → US7 → US8 → Closure`

### Parallel Opportunities

- T023–T025 can run in parallel; T032–T034 can run in parallel; T040–T042 can run in parallel; T049–T051 can run in parallel.
- T058–T060, T068–T069, T074–T075, and T081–T083 can each run in parallel.
- After Phase 2, durable assignment, discussion, and notification work can proceed in parallel when changes to `prisma/schema.prisma`, notification service, and OpenAPI are coordinated.
- T087–T088 can run in parallel; T089–T092 run after their respective systems exist.

## Implementation Strategy

### MVP First

1. Complete the ADR/approval gate (T001–T011).
2. Complete durable foundations (T012–T022).
3. Deliver US1 only (T023–T031) and prove pending-invitation, role, removal, and access-revocation behavior before adding shared workspace collaboration UI.

### Incremental Delivery

1. US1 establishes governed membership.
2. US2 adds typed responsibility without altering workflow semantics.
3. US3 adds durable discussion independent from review feedback.
4. US4 makes notifications reliable before realtime delivery.
5. US5 adds transport-only realtime invalidation; US6 adds TTL presence.
6. US7 integrates the drawer, Bell, Activity projection, and presence into the existing workspace.
7. US8 and Phase 11 prove security, operations, and Phase 022/023 non-regression.

## Notes

- Do not remove or rename `Asset.status`, Phase 023 workflow transitions/events, rejection feedback, annotation geometry, or annotation revisions.
- Do not add a WebSocket command API, realtime annotation synchronization, presence lock, permanent workspace column, or modality-specific workspace route.
- A task touching `prisma/schema.prisma`, `docker-compose.yaml`, `docker-compose.review.yaml`, `docker/review-proxy.conf`, or package dependencies is blocked until the ADR/approval gate records the approved design.

---

## Additive extension: User Story 9 — Shareable Invitation Links (planned; do not implement before approval)

**Goal**: Add `share-link -> authenticated explicit claim -> existing DatasetMember` beside recipient-specific invitations without creating a second authorization path.

**Non-negotiable boundary**: No task may reinterpret `Asset.status`, `Asset.revision`, `Annotation.revision`, geometry/autosave, review feedback, `AssetWorkflowEvent`, assignment, discussion, presence, recipient-specific `DatasetInvitation`, or the Next.js/worker/gateway boundary.

### Phase 12: Decision and repository-audit gate

- [X] T095 Audit and record the current `DatasetInvitation`, `DatasetMember`, user relations, role grant helper, membership service/routes/validation, transaction/outbox relay, ticket/revocation, Activity, UI, OpenAPI, tests, rate limiter, ADR, and deletion behavior in `research.md`.
- [ ] T096 Approve separate `DatasetInvitationLink` rather than overloading recipient-specific `DatasetInvitation`; approve the `ALREADY_MEMBER` non-consuming policy and same-claimant retry behavior in `research.md` and `data-model.md`.
- [ ] T097 Approve token handling: 256-bit random secret, SHA-256 digest-only persistence, fragment share URL, JSON-body preview/claim, generic unavailable state, and no raw-token logging/audit/activity/notification/realtime exposure.
- [ ] T098 Approve lifecycle/event/migration policy: `PENDING/CLAIMED/REVOKED/EXPIRED`, immutable non-Owner role, first-committed-transition-wins revoke/claim race, proposed safe membership-event actions, expiry duration, FK/deletion behavior, and no backfill.
- [ ] T099 Approve public preview/claim rate-limit identity/category/threshold/failure behavior, distinct public-preview/authorized-management projections, and the final creator-only `DATASET_MEMBER_JOINED` notification policy; confirm no dependency, gateway, Compose, worker-runtime, or environment change is needed.

**Checkpoint**: T095–T099 are explicit product/architecture approvals. Do not edit Prisma, API code, UI, worker, gateway, Compose, or dependencies before this checkpoint.

### Phase 13: Model, safe primitives, and migration

- [ ] T100 [US9] Add focused real-PostgreSQL tests for token digest uniqueness, lifecycle guards, normal member uniqueness, same-claimant replay, different-claimant race, first-committed revoke-vs-claim behavior, expiry-at-claim, creator-loss, and rollback/no partial durable state in `apps/web/tests/collaboration/invitation-link-service.test.ts`.
- [ ] T101 [US9] Add only approved Prisma enums, `DatasetInvitationLink` relations/indexes, safe membership-event actions, and generated safe types to `prisma/schema.prisma`; do not alter `DatasetInvitation` or locked Phase 022/023 models.
- [ ] T102 [US9] Create and review one additive Prisma migration; verify empty backfill, migration reversibility/operational safety, dataset/user deletion behavior, and no persisted raw secret.
- [ ] T103 [US9] Extend collaboration Zod validation and safe DTO types for manager link actions, fragment-body preview, and authenticated claim in `apps/web/src/lib/validation/collaboration.ts` and `apps/web/src/types/collaboration.ts`.
- [ ] T104 [US9] Implement server-only token generation/digest/redaction utilities and test that raw values never enter logs, audit, notification, Activity, realtime, DTOs, or errors.

### Phase 14: Authoritative service and concurrency proof

- [ ] T105 [US9] Implement `apps/web/src/lib/collaboration/invitation-link-service.ts` using `runCollaborationTransaction(...)` for issue/revoke/preview/claim and reusing existing role/membership authorization helpers.
- [ ] T106 [US9] Implement claim-time revalidation of dataset, pending/unexpired/unrevoked/unconsumed state, effective creator authority, immutable role policy, and current claimant membership; return only approved safe terminal outcomes.
- [ ] T107 [US9] Implement transactional `DatasetMember` creation, safe link/membership events, exactly-one creator-only `DATASET_MEMBER_JOINED` notification (no claimant/bystander recipient), stable outbox dedupe intent, and after-commit existing job enqueue; prohibit REST-to-Redis publication.
- [ ] T108 [US9] Prove real-PostgreSQL concurrency: B/C one winner, B two tabs/replay no duplicate effects, revoke/claim and expiry/claim safe convergence, creator removal/downgrade rejection, and outbox-dispatch failure leaves durable membership correct.
- [ ] T109 [US9] Add explicit regression assertions that all link operations leave `Asset.status`, `Asset.revision`, `Annotation.revision`, geometry, feedback, and `AssetWorkflowEvent` unchanged.

### Phase 15: HTTP contracts and management/landing UI

- [ ] T110 [US9] Add browser-facing manager routes for create/list/revoke in `apps/web/src/app/api/datasets/[datasetId]/invitation-links/...` with existing auth, error, concealment, pagination, and authorized-management DTO conventions.
- [ ] T111 [US9] Add public rate-limited safe preview and authenticated explicit claim routes using token request bodies, never URL parameters, in `apps/web/src/app/api/invitation-links/...`.
- [ ] T112 [US9] Add HTTP production/contract tests for distinct logged-out safe preview versus authorized management DTOs, authentication without claim, claim success/Open-workspace CTA, independent `/workspace/{datasetId}` authorization without token fragment/query, `ALREADY_MEMBER`, terminal-state concealment, actor/role authorization, invalid payloads, pagination, rate limiting, raw-token non-retrieval after issuance, and safe DTO redaction.
- [ ] T113 [US9] Document every browser-facing endpoint and schema in `specs/api/openapi.yaml`, `specs/api/schemas/collaboration.yaml`, and `contracts/invitation-links-api.md`; validate and bundle OpenAPI.
- [ ] T114 [US9] Add owner/manager link create/list/revoke/copy controls to the existing dataset membership-management surface; do not add administration to workspace or expose a reusable secret after initial creation.
- [ ] T115 [US9] Add `/join` safe landing page: fragment handling, public preview, sign-in continuation, explicit Join confirmation, unavailable state, idempotent success, and an **Open workspace** CTA to `/workspace/{datasetId}`. Strip the fragment and never put tokens in workspace/server-rendered route/query/telemetry state.

### Phase 16: Delivery, hardening, and closure

- [ ] T116 [US9] Verify accepted claim reuses the existing membership-change outbox -> worker -> Redis -> gateway invalidation path and requires no new WebSocket command, token auth, gateway schema, or Redis authority.
- [ ] T117 [US9] Add Activity projection/redaction coverage for approved safe link lifecycle/member events; prove no raw token/digest/URL enters Activity, notifications, audit, gateway envelopes, or logs.
- [ ] T118 [US9] Add security tests for cross-dataset access, creator removal/downgrade, stale tickets after claimed-member removal, token leakage/non-retrieval, replay, first-wins revoke/claim race, and public enumeration/timing/rate abuse.
- [ ] T119 [US9] Run recipient-specific invitation and membership/role/removal regressions; verify link work does not alter their service/API behavior.
- [ ] T120 [US9] Run Phase 022 Asset Browser/assignment, Phase 023 workflow/revision/concurrency/stale-review, Phase 024 discussion/notification/realtime/presence/activity, and authorization regressions.
- [ ] T121 [US9] Run PostgreSQL integration suites, OpenAPI validation/bundle, web/realtime typecheck, lint, production build, and Compose/proxy smoke only if implementation changed runtime-observed code.
- [ ] T122 [US9] Complete manual acceptance: logged-out preview -> login -> explicit claim -> normal workspace; then member removal proves old link/workspace/ticket cannot restore access. Record safe evidence in `quickstart.md`.
- [ ] T123 [US9] Perform final token-redaction, migration/FK, authorization, transaction/outbox/idempotency, rate-limit, and no-Phase-022/023-semantics-change audit; mark validated extension tasks complete only after evidence passes.

### Extension dependency order

`T095–T099 approval -> T100–T104 model/tests -> T105–T109 service/concurrency -> T110–T115 HTTP/UI -> T116–T123 hardening/closure`.

T100 test design may proceed while approvals are being reviewed, but no schema or application write begins before T096–T099. T116 does not authorize modifying the gateway; it only verifies the existing membership path.
