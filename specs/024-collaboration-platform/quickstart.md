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

## Expected validation commands

```bash
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
pnpm docs:validate-openapi
pnpm docs:bundle-openapi
# Add focused collaboration and realtime integration commands with tasks/implementation.
```

Run Compose-backed tests serially where they share PostgreSQL/Redis fixtures. Record the gateway/proxy command and any new non-secret environment variable names only after the ADR-approved runtime design is implemented.
