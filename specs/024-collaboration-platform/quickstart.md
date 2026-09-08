# Quickstart: Validate Collaboration Platform

## Prerequisites

- Apply the approved Phase 024 Prisma migration only after the realtime gateway ADR and dependency approval.
- Start the normal Compose stack and, when implemented, the delivery gateway/proxy route.
- Prepare four existing authenticated users: Owner, Manager, Labeler, and Reviewer.
- Use two browser sessions for realtime/revocation validation.

No provider, Redis, database, MinIO, or realtime service credential may be copied into browser storage, URLs, fixtures, logs, or screenshots.

## Core validation flow

1. Owner invites an existing Labeler. Verify the invitation is pending and the Labeler has no dataset access before acceptance.
2. Labeler accepts. Verify one active DatasetMember, member directory visibility, and one invite notification (none for the Owner actor).
3. Owner or eligible Manager assigns annotation and review responsibility to different members. Reassign and unassign each; verify Asset status, Asset revision, annotations, and Phase 023 workflow history remain unchanged.
4. Downgrade or remove an assignee. Verify incompatible active assignment is removed with history/notifications and no automatic reassignment.
5. In two sessions, create a root comment, direct reply, valid mention, edit/delete own comment, resolve, and reopen. Verify a reply cannot target another reply and discussion stays separate from rejection feedback/history.
6. With the recipient offline, create assignment, mention, reply, and Phase 023 decision. Reconnect and verify durable notification history, unread state, Bell `99+`/zero behavior, and safe deep links.
7. Connect two authorized sessions to the same asset. Verify comment/assignment/notification invalidations arrive promptly, then reconnect one session and verify REST refresh converges.
8. Remove one connected member. Verify later protected REST requests fail and their realtime subscription is revoked/re-authorized; verify no later protected event is delivered.
9. Verify presence: viewing/editing avatar details appear, expire after heartbeat stops, and neither user is blocked from authorized actions. **PRESENCE IS NOT A LOCK.**
10. Run Phase 022/023 browser and automated regression suites, especially assignment compatibility, annotation revision/autosave, workflow stale review, and history.

## Required automated coverage

- PostgreSQL transaction tests: invitation accept/revoke, role change/removal with assignment cleanup, single active assignment slot, comment depth/ownership/mention constraints, notification dedupe/self-suppression, and workflow-notification no-regression.
- HTTP contract tests: member/assignment/comment/notification/ticket authorization, dataset concealment, deleted resources, invalid parent reply, invalid target roles, and deep-link access recheck.
- Gateway integration tests: ticket expiry, dataset-scoped subscription, revocation after membership loss, duplicate/reordered event tolerance, reconnect invalidation, TTL presence expiry, and no command acceptance over WebSocket.
- UI tests/manual checks: Bell placement/count/accessibility, Discussion drawer without Properties Panel replacement, Activity projection separation, avatar presence, and direct comment deep-link.

## US1 validation record — 2026-09-05

The membership/invitation MVP was verified against the running Compose PostgreSQL instance (not a mock):

- `dataset-membership-service.test.ts`: duplicate pending replay/conflict, concurrent double acceptance (one member/event winner), decline/revoke/expiry terminal behavior, OWNER/Manager protection, role downgrade/removal assignment cleanup, notification/outbox intent, and rollback without partial durable rows.
- `dataset-membership-http.test.ts`: authenticated create/accept/replay/member-directory behavior, unauthorized role-management denial, and cross-dataset/invitation concealment.
- Existing Phase 022 bulk-assignment and Phase 023 workflow/stale-review suites passed unchanged.

US1 writes a durable membership-revocation outbox intent on removal or role change. It does not claim live WebSocket revocation evidence: that transport behavior remains T067 after the gateway exists.

## US2 validation record — 2026-09-05

The typed responsibility layer was verified against Compose PostgreSQL:

- `asset-assignment-service.test.ts`: independent ANNOTATION/REVIEW current-slot lifecycle, reassign/unassign history, target-role and dataset-scope rejection, concurrent reassignments, legacy `assignedToId` mirroring, review-field isolation, durable notification/outbox rows, and rollback without partial rows.
- `asset-assignment-http.test.ts`: authorized current/history reads, mutation authorization/concealment, and invalid target rejection.
- Existing Phase 022 `assets-bulk/assign` and Phase 023 workflow/revision suites passed. `assignment-collaboration-integrity.test.ts` proves typed assignment mutations preserve `Asset.status`, `Asset.revision`, and `AssetWorkflowEvent` history.

The expected PostgreSQL serializable write-conflict diagnostic during the concurrent reassignment race was retried by `runCollaborationTransaction(...)`; one current slot remained and durable history stayed ordered.

## US3 validation record — 2026-09-06

The Asset Discussion slice was verified against the running Compose PostgreSQL instance and a production-built local Next server:

- `asset-comment-service.test.ts`: root/direct-reply constraints, cross-asset and cross-dataset parent rejection, valid-member mention deduplication and edit-time recomputation, self-notification suppression, root-author reply notification, soft deletion/thread continuity, root resolution/reopen, removed-member denial, and no partial comment/outbox state after denial.
- `asset-comment-http.test.ts`: authenticated list/create/read flow, direct replies, and 404 concealment for a non-member attempting a protected discussion read or mutation.
- `discussion-workflow-separation.test.ts`: Discussion create/resolve leaves `Asset.status`, `Asset.revision`, and `AssetWorkflowEvent` unchanged.
- The Discussion button opens a temporary right-side drawer. It preserves the existing Properties Panel and is explicitly separate from Phase 023 rejection feedback and workflow history.

No realtime delivery, Bell UI, presence, Activity projection, or workflow notification integration is included in this slice; durable notification/outbox intent is created only for the US3 comment domains already approved by ADR 024.

## US4 automated validation record — 2026-09-07

- `notification-service.test.ts`: durable recipient dedupe, self-suppression, serializable retry recovery, and rollback with no partial notification row.
- `notification-http.test.ts`: authenticated list/read/read-all, recipient isolation, unknown-resource concealment, invalid pagination, idempotent read, recipient-only mark-all, and context redaction after membership access loss.
- `workflow-notification-integration.test.ts`: successful workflow notification/outbox intent, assigned-recipient preference, and stale/invalid/unauthorized/replayed requests creating no duplicate durable intent.
- Notification UI remains REST-authoritative through `useNotifications()`; Bell components do not import Redis or WebSocket code, hide the zero badge, cap visual counts at `99+`, and expose the unread count through their accessible name.

The offline browser acceptance flow and a fresh production-build confirmation remain T057 closure evidence; do not treat this record as realtime delivery proof.

### T057 automated production evidence — 2026-09-07

- `pnpm --filter @annotationplatform/web typecheck` and `lint` passed.
- A fresh `pnpm --filter @annotationplatform/web build` produced `.next/BUILD_ID` (`k_kcwbKvNV3IhnYpJmqnd`).
- The fresh-build production harness passed `login -> AuthSession -> /api/auth/me` and the notification list/read/redaction contract against Compose PostgreSQL.

The remaining T057 evidence is manual: create a notification while the recipient is offline, sign in, open Bell, use its authorized asset/comment link, and confirm the correct workspace context appears. Do not mark T057 complete until that interaction is observed.

#### T057 required manual acceptance branches

**Branch 1 — authorized recovery**: Actor A completes a domain action while B is offline. Confirm the durable `Notification` exists, B later signs in, and `GET /api/notifications` returns the item. Bell must render that REST-fetched item; selecting it must recheck current authorization and open `/workspace/{datasetId}?image={assetId}` with `discussion={commentId}` when applicable. The selected asset and referenced discussion must be visible.

**Branch 2 — membership revoked**: Create the durable notification, then remove B from the dataset before B opens Bell or follows its link. The notification row may remain as recipient history, but `GET /api/notifications` MUST return only its generic unavailable projection: no original dataset ID, asset ID, comment ID, title, body, or deep-linkable protected context. The subsequent workspace navigation must independently deny or conceal the removed member's access. No stale dataset, asset, or comment information may be exposed.

Both branches must be observed against a running production-style build before marking T057 `[X]` and closing US4. This proof does not require WebSocket delivery: PostgreSQL remains durable truth, REST remains the authoritative read/recovery boundary, and WebSocket remains a later delivery optimization.

## US5 server validation record — 2026-09-07

- The ticket endpoint issues a short-lived opaque scope ticket only after current dataset authorization.
- Gateway integration proves valid ticket acceptance, Redis dataset-scoped delivery, and `MEMBERSHIP_REVOKED` closing the final scope so a later event is not delivered.
- The workspace reconnect hook obtains a new REST ticket and calls `router.refresh()` for every gateway delivery; it does not merge transient socket state into durable UI state.

For T067, use two authorized sessions against the Compose gateway: publish a safe worker outbox envelope, observe the recipient refresh, interrupt/reconnect it and confirm REST convergence, then remove that member and confirm the connection closes and later scoped deliveries do not arrive.

### T067 Compose durable-revocation evidence — 2026-09-07

- `COMPOSE_REALTIME_ACCEPTANCE=1 node --env-file=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/collaboration/realtime-compose-acceptance.test.ts` passed from `apps/web` against the running Compose `postgres`, `web`, `worker`, `redis`, and `realtime` services.
- Three tickets were issued by the running web API: two independent tabs with `dataset A + dataset B`, plus one `dataset A`-only connection. All connected through the actual gateway.
- Removing the member through `removeDatasetMember` created the durable `MEMBERSHIP_REVOKED` intent, then enqueued its job after commit. The private worker claimed/completed that job and Redis transport caused the gateway to revoke both A+B tab scopes and close the A-only socket.
- A later worker-dispatched A event was not delivered to either revoked tab. A worker-dispatched B event reached both surviving tabs, proving other authorized scope remains usable. A fresh REST ticket request for removed dataset A returned concealed `404` despite the old socket/ticket.
- The gateway treats revocation as a control signal, not a client-visible event; clients converge by REST invalidation.
- `pnpm --filter @annotationplatform/web exec vitest run tests/workspace/use-collaboration-realtime.vitest.spec.ts --environment node` passed. It severs the socket, advances the authoritative PostgreSQL projection while no event is delivered, reconnects with a distinct fresh ticket, and verifies one invalidation only after the replacement socket opens. The callback observes the changed projection without a gateway replay or page reload.

#### T057 manual acceptance record — accepted 2026-09-07

The two required production-style observations were accepted: an offline recipient recovered an authorized notification through Bell's REST read and reached the expected workspace context; after membership revocation, retained notification history was projected as unavailable and protected workspace context was denied/concealed. US4 is closed on this evidence. No WebSocket delivery was involved.

## Expected validation commands

## Phase 11 closure record — 2026-09-08

- The previously blocking `auth-pages.test.ts` assertion was classified as **A — stale test expectation**. `POST /api/auth/signup` deliberately creates an account only; the signup route comment, registration UI redirect, and OpenAPI all require a later `POST /api/auth/login`. The corrected test proves role persistence with zero signup sessions, then proves login creates exactly one opaque, HTTP-only session.
- The direct Compose PostgreSQL auth regression group passed (9 tests; 8 intentionally service-gated OpenAPI/HTTP skips). A freshly rebuilt production `next start` passed `login -> AuthSession -> cookie -> /api/auth/me`.
- The Phase 022 workspace and Phase 023 workflow/revision/history sweep passed. It includes Asset Browser filtering/pagination, annotation revision guards, workflow-history attribution, exhaustive transitions, one-winner stale-review races, and workflow-notification negative cases. The tests confirm collaboration did not add `Asset.status` or annotation-revision writes outside their existing services.
- `pnpm docs:validate-openapi`, `pnpm docs:bundle-openapi`, web typecheck, and web lint passed. Normal Compose web/worker/realtime images and review Compose web/worker/realtime images built successfully. Normal `/api/auth/me` returned expected unauthenticated `401`; normal realtime `/health` returned `200`; the review proxy returned `401` from Next and reached the healthy realtime service internally.
- Final boundary audit: collaboration services write only the legacy annotation assignment compatibility field `Asset.assignedToId`; they do not write `Asset.status`. The delivery gateway has no Prisma/database import. Activity is a read-only projection over existing discussion/assignment/workflow records, with no Activity persistence. Browser-safe collaboration DTOs exclude annotation geometry and sensitive server state; gateway/outbox envelopes remain delivery-only.

Known operational note: `docker compose images` can report a missing digest for older running containers after image rebuilds. Explicit tagged image inspection confirmed the rebuilt images; this is Docker daemon/container-image bookkeeping, not an application build failure.

```bash
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
pnpm docs:validate-openapi
pnpm docs:bundle-openapi
# Add focused collaboration and realtime integration commands with tasks/implementation.
```

## US6 presence validation record — 2026-09-07

- `apps/realtime/tests/presence.integration.test.ts` passed against Redis. It proves per-tab records aggregate to one person, `EDITING` takes precedence over `VIEWING`, TTL expiry removes stale presence, and an authorized viewer remains connected while another member is editing.
- The gateway accepts only ticket-scoped `presence.heartbeat` envelopes. Each heartbeat includes only dataset/asset scope and `VIEWING` or `EDITING`; it carries no geometry, pointer, draft, workflow, or lock data.
- `apps/web/tests/workspace/collaboration-presence.vitest.spec.tsx` passed and verifies accessible presence detail renders as viewing/editing awareness without a lock control.
- The browser hook sends a viewing heartbeat on connection, renews every 20 seconds, changes to editing only after local pointer/keyboard interaction, downgrades after blur or 30 seconds of inactivity, and closes cleanly. Presence remains Redis-only and is not an authorization or workflow input. **PRESENCE IS NOT A LOCK.**

## US7 workspace integration validation record — 2026-09-07

- `apps/web/tests/collaboration/activity-projection.test.ts` passed against PostgreSQL. Activity reads require current `dataset.read` access, conceal cross-dataset access, and omit comment bodies. It projects existing discussion, assignment, and Phase 023 workflow records only; it creates no Activity table and performs no status/revision write.
- `apps/web/tests/workspace/collaboration-workspace-ui.vitest.spec.tsx` passed. Discussion remains a fixed overlay drawer with distinct Discussion and Activity tabs, not a permanent fourth workspace column.
- Workspace deep links accept the existing `?image={assetId}&discussion={commentId}` shape. The selected asset remains the normal workspace selection; Discussion opens and highlights the referenced root/reply when it belongs to that asset. The Activity read route is authorized server-side and returns only safe metadata.
- PostgreSQL workspace-selection acceptance now covers both an IMAGE and a VIDEO query selection. Both resolve through the shared workspace route without a modality-specific route. The drawer remains an overlay over the existing three-column Properties Panel layout.
- Cross-asset, cross-dataset, and revoked-member discussion deep links are rejected by the server-side `readSafeDiscussionCommentId` resolver. Realtime invalidation increments the drawer refresh key as well as calling `router.refresh()`, so an open Discussion or Activity tab refetches its authoritative REST data after a delivery signal.
- No workflow action is involved in either modality acceptance; `Asset.status`, `Asset.revision`, `Annotation.revision`, geometry, feedback, and `AssetWorkflowEvent` remain unchanged.

Run Compose-backed tests serially where they share PostgreSQL/Redis fixtures. Record the gateway/proxy command and any new non-secret environment variable names only after the ADR-approved runtime design is implemented.

## US8 security and operational-integrity validation record — 2026-09-07

- `collaboration-security.test.ts` passed against PostgreSQL: cross-dataset and removed-member discussion access is concealed/rejected, an ordinary member cannot change another author's comment, and notification context is returned as generic unavailable after membership loss.
- `collaboration-concurrency.test.ts` passed against PostgreSQL: concurrent recipient invitation, assignment reassignment, same-body comment mention update, and notification replay each converge on their applicable durable uniqueness/deduplication invariant. Expected PostgreSQL serialization retries were observed and recovered by `runCollaborationTransaction(...)`.
- `apps/realtime/tests/security.integration.test.ts` passed against Redis: invalid/expired upgrades are rejected, two concurrent tabs lose revoked dataset scope, later revoked-scope events are not delivered, an independent authorized scope remains delivered, and the final-scope revocation closes both sockets.
- The gateway now closes an established connection at its signed ticket expiry. Fresh ticket issuance remains required for reconnect; this adds no gateway command or PostgreSQL/Redis authorization path.
- Focused Phase 022/024 and Phase 023 regression command passed 17 PostgreSQL tests, including assignment/workflow separation, discussion/workflow separation, asset revision invalidation, stale-review precedence, and concurrent workflow submission. Focused gateway/presence regression command passed 4 Redis integration tests.

---

## Planned shareable invitation-link acceptance

This checklist is for the additive link extension only; it is not implementation evidence yet.

1. As an Owner, create separate Labeler and Reviewer links from dataset member management. Verify Owner is not an offered/grantable link role and Manager options match existing role-grant policy.
2. Open a new browser profile at the copied `/join#…` URL. Confirm the landing shows only dataset display name, proposed role, inviter display name, and availability—not assets, members, assignments, comments, workflow, storage, or metadata.
3. Authenticate with an existing account. Confirm authentication alone does not create `DatasetMember`, consume the link, emit notification/outbox, or grant workspace access.
4. Select **Join dataset**. Confirm the success state presents **Open workspace**, normal `DatasetMember` access appears, and the CTA opens `/workspace/{datasetId}` with no invitation fragment/query. Confirm direct workspace access is authorized independently and the member is eligible for the corresponding existing assignment role.
5. Retry after deliberately losing the claim response. Confirm the same claimant gets the original membership result with no duplicate member/audit/notification/outbox state. A different account cannot consume the same link.
6. Repeat with revoked, expired, consumed, deleted-dataset, creator-removed, and creator-downgraded links. Confirm no membership is created and only generic unavailable state is exposed.
7. Remove the claimed member. Confirm the old link, workspace URL, and old realtime ticket cannot restore dataset access; normal existing revocation behavior applies.
8. Inspect safe server/audit/activity/notification/realtime test payloads. Confirm no raw token, token digest, or reusable share URL is present.
9. Re-open manager history after copying the initial link. Confirm history contains only its authorized operational projection and cannot retrieve the raw token or share URL. Confirm a claim only notifies the creator (not claimant or bystanders), and only once.
10. Race one revoke against one claim using real PostgreSQL. Confirm the first committed transition wins and the losing path creates neither a contradictory lifecycle state nor partial membership.

Required automated evidence before closure: real PostgreSQL race tests for same/different claimant/revoke/expiry/creator-authority cases; public/HTTP contract and rate-limit tests; existing recipient-specific invitation, membership/revocation, assignment, workflow/revision, realtime, OpenAPI, typecheck, lint, production-build, and manual browser acceptance regressions.
