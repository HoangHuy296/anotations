# Data Model: Collaboration Platform

Foundation schema is implemented by additive Prisma migration `20260904111916_collaboration_platform`. Membership, assignment, discussion, notification, and gateway user-story behavior remains scheduled by [tasks.md](./tasks.md); this document remains the durable-model contract.

## Durable entities

### DatasetInvitation

| Field | Rules |
| --- | --- |
| id | Durable identifier |
| datasetId, inviteeUserId | Existing dataset and authenticated user; no guest accounts |
| role | Eligible proposed DatasetMember role; never Owner |
| invitedById | Owner or eligible Manager |
| status | `PENDING`, `ACCEPTED`, `DECLINED`, `REVOKED`, `EXPIRED` |
| activeKey | `PENDING` while active; `NULL` after a terminal state |
| expiresAt, respondedAt, revokedAt | Lifecycle timestamps |

- `activeKey` is `PENDING` only while the invitation is pending and `NULL` at terminal states; Prisma enforces one pending invitation with `@@unique([datasetId, inviteeUserId, activeKey])`.
- Accept atomically creates `DatasetMember`, resolves the invitation, creates the recipient notification only when actor differs, and emits a safe delivery signal.
- Inviting an existing member is rejected; reissue is allowed only after a terminal invitation state.

### AssetAssignment (current responsibility slot)

| Field | Rules |
| --- | --- |
| id | Durable identifier |
| datasetId, assetId | Must match the asset's dataset and remain scoped to it |
| type | `ANNOTATION` or `REVIEW` |
| userId | Active eligible DatasetMember: Labeler for annotation, Reviewer for review; Owner/Manager policy is resolved through existing role capability |
| assignedById, assignedAt, updatedAt | Attribution |

- Unique `(assetId, type)` is the active-slot invariant.
- Reassign updates the slot in one transaction and appends history; unassign removes the slot and appends history.
- During compatibility migration, the current annotation slot is mirrored to `Asset.assignedToId`; review assignment has no legacy projection.
- Assignment never updates `Asset.status`, Asset revision, Annotation content/revision, or workflow history.

### AssetAssignmentEvent

| Field | Rules |
| --- | --- |
| assignment identity / asset / dataset | Scope and correlation |
| action | `ASSIGNED`, `REASSIGNED`, `UNASSIGNED`, `REMOVED_FOR_ROLE_CHANGE` |
| previousUserId, nextUserId, actorId | Safe attribution |
| createdAt | Ordered audit timestamp |

- This is assignment-domain history. Activity projects it; it is not an Activity table.

### AssetComment

| Field | Rules |
| --- | --- |
| id, datasetId, assetId, authorId | Dataset-scoped attribution |
| parentId | Null for root; otherwise must reference a root comment for the same asset |
| body | Authorized discussion text; never copied to operational logs/realtime delivery envelope |
| createdAt, updatedAt, deletedAt | Soft deletion retains thread continuity |
| resolvedAt, resolvedById | Root-thread resolution; replies derive their root's resolution |

- Maximum depth is one: a reply cannot have a parent that itself has a parent.
- Author edits/deletes own comments; moderation is Owner/Manager policy; root participants and moderators may resolve/reopen.

### CommentMention

| Field | Rules |
| --- | --- |
| commentId, userId | Unique pair |
| createdAt | Recipient association timestamp |

- Mentions are recomputed transactionally on comment create/edit from validated active members.
- A comment author is not stored as a self mention notification recipient.

### Notification

| Field | Rules |
| --- | --- |
| id, userId | Recipient and identifier |
| type | `DATASET_INVITE`, `ASSET_ASSIGNED`, `REVIEW_ASSIGNED`, `MENTIONED`, `COMMENT_REPLY`, `REVIEW_SUBMITTED`, `REVIEW_APPROVED`, `REVIEW_REJECTED` |
| datasetId, assetId, commentId, actorId | Optional safe navigation context |
| title, body | Sanitized in-app display only |
| dedupeKey | Unique per recipient and logical domain event |
| contextUnavailableAt, readAt, createdAt | Unavailable-context/read state/history |

- No row is created when `userId === actorId`.
- A uniqueness constraint on `(userId, dedupeKey)` is the retry/replay invariant.
- Notification deep-link resolution rechecks current dataset access.
- On dataset or asset deletion, the notification is retained only as generic unavailable history: contextual foreign keys are set to null, the deep link is removed, and deleted context/title/body detail is replaced so it cannot disclose protected information.

### CollaborationOutboxEvent

| Field | Rules |
| --- | --- |
| id, dedupeKey | Durable identifier and unique logical delivery identity |
| type, datasetId?, assetId?, recipientUserId? | Safe invalidation/revocation routing only |
| payload | Small safe envelope; never comment body, feedback, geometry, or credentials |
| jobId, dispatchedAt | Link to the existing durable dispatch Job and delivery completion evidence |

- The accepted domain transaction creates the outbox event and durable dispatch Job together.
- The private worker claims the event through Prisma and publishes it to Redis after the transaction commits. The gateway never reads this table.
- Dataset/asset deletion cascades undelivered outbox rows rather than allowing a stale delivery after the protected context is gone.

### DatasetMembershipEvent

| Field | Rules |
| --- | --- |
| datasetId, memberUserId, actorId | Safe attribution |
| action | Invite/accept/decline/revoke/role change/removal |
| previousRole, nextRole, createdAt | State transition evidence |

- This records membership-domain changes needed for safe audit and Activity projection; it is not a generic Activity source of truth.

## Ephemeral presence

Presence is not a Prisma model. A presence value contains only user identity, authorized dataset/asset scope, activity (`VIEWING`/`EDITING`), connection timestamp, and last-seen timestamp.

- Dataset key: `presence:dataset:{datasetId}`.
- Asset key: `presence:asset:{assetId}`.
- Heartbeats renew a TTL. Disconnect or expiry removes visibility without durable cleanup.
- Presence never reserves work, grants access, or changes workflow/annotation state.

## Relationship and lifecycle summary

```text
DatasetInvitation --accept--> DatasetMember
DatasetMember --eligible--> AssetAssignment(current slot) --> AssetAssignmentEvent
Asset --> AssetComment(root) --> AssetComment(reply depth 1)
AssetComment --> CommentMention --> Notification
Accepted domain event --> Notification(dedupeKey) + CollaborationOutboxEvent --> worker dispatch Job --> Redis invalidation --> gateway
DatasetMember removal/role change --> remove incompatible assignment + revoke realtime subscription
AssetWorkflowEvent (existing) --> Notification / Activity projection only
```

## Compatibility and migration sequence

1. Add collaboration tables/relations without removing `Asset.assignedToId`.
2. Backfill one annotation assignment slot from each existing non-null `assignedToId` only where the member remains eligible; report exceptions rather than guessing.
3. Dual-write current annotation assignment and `assignedToId`; read new slot first with legacy fallback.
4. Migrate Asset Browser and assignment consumers to typed assignment DTOs.
5. Stop legacy writes only after regression evidence; retain the field until a later approved deprecation migration.

---

## Proposed additive shareable-invitation-link model

This is a planning contract only. It requires the recorded approval gates before a Prisma schema or migration is changed.

### DatasetInvitationLink

| Field | Rules |
| --- | --- |
| `id` | Durable non-secret identifier; never used as a claim credential. |
| `datasetId` | Required existing dataset; cascade on dataset deletion. |
| `createdById` | Required issuing actor; claim-time effective Owner/Manager authority is rechecked. |
| `role` | Immutable `DatasetMemberRole`, validated through current grant policy; never `OWNER`. |
| `tokenHash` | Unique `SHA-256` digest of a random 256-bit URL-safe secret. Raw secret is never persisted. |
| `status` | `PENDING`, `CLAIMED`, `REVOKED`, or `EXPIRED`; terminal state is never made claimable again. |
| `expiresAt` | Required expiry; checked at preview and claim. |
| `claimedById`, `claimedAt` | Set only by the winning claim; enable same-user lost-response retry without exposing the secret. |
| `revokedAt`, `createdAt`, `updatedAt` | Safe lifecycle timestamps. |

Recommended indexes: unique `tokenHash`; `(datasetId, status, createdAt)` for manager history; `(expiresAt, status)` for safe expiry processing; `(claimedById, createdAt)` only if a claimant history read is needed. `DatasetMember` keeps its existing unique `(datasetId, userId)` invariant.

### Lifecycle and atomicity

```text
PENDING --claim (one serializable winner)--> CLAIMED
PENDING --revoke--> REVOKED
PENDING --time passes--> logically EXPIRED
```

- Claim must update/guard the same pending unexpired row inside `runCollaborationTransaction(...)`; an expired `PENDING` record is treated as `EXPIRED` for all reads and may be normalized to `EXPIRED` in a safe transaction.
- The winning transaction inserts the normal `DatasetMember`, link/member event(s), optional creator notification, and normal membership-change outbox intent before committing the `CLAIMED` state.
- A same-claimant retry reads `CLAIMED + claimedById` and returns the already-created membership projection. A different claimant gets generic unavailable.
- Existing claimant membership is checked before consuming a pending link. It returns `ALREADY_MEMBER`, performs no role update, and leaves the link unconsumed.
- Creator authority is evaluated as the effective current Owner/Manager role, not merely by a stale creator identifier. Removal, loss of dataset access, or downgrade that cannot grant the encoded role makes the link unavailable.
- Revoke and claim race on the same guarded `PENDING` row. The first committed transition wins: `REVOKED` means no claim may insert membership; `CLAIMED` means revoke cannot change state. A serializable retry must re-read the durable terminal state, so no response path can report contradictory lifecycle or partial membership.

### Auditing, notification, and deletion

- Additive membership-event actions are proposed for `LINK_CREATED`, `LINK_REVOKED`, and `LINK_CLAIMED`; event rows contain dataset/member/actor/role/time only—never raw secret, digest, URL, or free text.
- Link issuance, revocation, expiration, unavailable claim, and `ALREADY_MEMBER` create no notification. A successful first claim creates exactly one `DATASET_MEMBER_JOINED` notification for `createdById` only when claimant differs; no claimant or bystander notification exists. Its stable dedupe key is `invitation-link-claim:{linkId}:creator:{createdById}`, and it contains no raw secret or digest. Same-claimant retry does not create another notification.
- Dataset deletion cascades link and undelivered outbox rows. User-deletion relation behavior must match existing user-retention policy and be approved in the migration review; it must never leave a claimable orphan or disclose a link secret.
- Activity may project safe lifecycle/member events only. It is not a new table or an alternate invitation ledger.

### Secret transport boundary

The one-time raw secret is returned only in the create response and is represented in the browser share URL fragment (`/join#secret`). Fragments are not sent in normal navigation requests. The landing page sends it in redacted JSON request bodies for preview/claim; it must not put it in route path/query, telemetry, error messages, clipboard history beyond the user's deliberate copy action, or durable browser storage.

### Read projections

| Projection | Audience | Allowed fields | Never allowed |
| --- | --- | --- | --- |
| Public preview | Anyone holding a token before authentication | `AVAILABLE` plus dataset display name, encoded role, inviter display name; otherwise generic `UNAVAILABLE` | Link ID, lifecycle reason, asset/member/workflow data, raw secret, digest, reusable URL |
| Manager history | Current Owner/eligible Manager under existing role policy | Link ID, role, lifecycle/timestamps, and safe creator/claimant identity already allowed by member management | Raw secret, digest, reusable URL, internal authorization diagnostics, protected dataset content |

The issuance response is not a management projection: it is the only response that can contain the one-time share URL. Re-listing a link must never recreate or retrieve it.
