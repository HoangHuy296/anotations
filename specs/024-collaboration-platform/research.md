# Research: Collaboration Platform

## Audit scope

The audit reviewed `DatasetMember`, `DatasetMemberRole`, `Asset.assignedToId`, Phase 023 workflow events, authorization, REST conventions, Redis usage, Compose topology, the review nginx proxy, workspace/global headers, and the published Next.js custom-server guidance.

## Decisions

### Pending invitation lifecycle

**Decision**: Use a true pending invitation lifecycle for existing authenticated users: `PENDING`, `ACCEPTED`, `DECLINED`, `REVOKED`, and `EXPIRED`. Only acceptance creates the active `DatasetMember` relationship.

**Rationale**: Direct add makes invitations indistinguishable from completed membership and grants access before the recipient opts in. A pending lifecycle supports in-app invite notifications, reissue/revoke behavior, and idempotent acceptance without guest accounts.

**Alternatives considered**: Directly create `DatasetMember` on invite (rejected: no consent/pending state); email/guest invitations (deferred: external recipients are out of scope).

### Assignment compatibility and `assignedToId`

**Decision**: Maintain one active annotation assignment and one active review assignment per asset. Use a unique current assignment slot per `(asset, type)` plus append-only assignment history. When role downgrade/removal invalidates an assignment, remove the active slot and append a removal event in the same transaction; do not silently reassign. Keep `Asset.assignedToId` as a temporary compatibility projection of the current annotation assignee until all existing readers migrate.

**Rationale**: A nullable `removedAt` on multiple rows cannot express one current row with Prisma's portable unique constraints. A unique active slot gives database-enforced single responsibility without raw SQL, while history preserves attribution. Existing Phase 022 assignment reads remain compatible during the migration.

**Alternatives considered**: Multiple assignment rows with `removedAt` and application-only enforcement (rejected: concurrent assignments can duplicate); immediate removal of `assignedToId` (rejected: breaks Phase 022 consumers).

### Discussion shape and mentions

**Decision**: A comment has either no parent (root) or a root parent (direct reply). Replies cannot have replies. Mentions are parsed and validated at accepted comment create/edit time, stored as one durable recipient association per `(comment, user)`, and never re-parsed for ordinary reads.

**Rationale**: Root + flat reply threads fit the requested drawer and make resolution predictable. Durable mentions make notification retry/idempotency tractable.

**Alternatives considered**: Arbitrary-depth trees (rejected: higher rendering, moderation, and notification complexity); reader-time parsing (rejected: repeated work and ambiguous historical recipients).

### Notification safety, deduplication, and self policy

**Decision**: Notifications are durable recipient records created in the same accepted domain transaction as their triggering change. That transaction also records a safe idempotent outbox event; a private-worker dispatch Job publishes the event later. They use a stable `dedupeKey` scoped to recipient and logical domain event. The actor receives no self-notification; their action remains visible in its domain surface and Activity projection.

**Rationale**: Durable notification history must survive offline recipients and delivery retries. A unique dedupe identity prevents duplicate notifications from transaction retries, event replays, or multiple realtime deliveries.

**Alternatives considered**: At-least-once notifications without dedupe (rejected: duplicate Bell entries); self-notifications (rejected: noisy and adds no information to the acting user).

### Membership loss and realtime subscriptions

**Decision**: Every gateway subscription is bound to a short-lived server-issued ticket and authorized dataset scope. A member removal/downgrade publishes a revocation/recheck signal after its durable transaction; the gateway drops or re-authorizes affected subscriptions. Ticket expiry and server-side REST authorization remain defense in depth.

**Rationale**: A browser connection cannot retain access after membership loss. Closing only the UI is insufficient, while querying durable membership for every event would be costly and still needs a revocation path.

**Alternatives considered**: Trust connection-time authorization until disconnect (rejected: leaks later activity); use presence as access state (rejected: presence is ephemeral and not authorization).

### Outbox runtime ownership and deletion retention

**Decision**: The private worker owns the durable outbox-dispatch Job handler. It resolves and claims PostgreSQL outbox rows, then publishes safe Redis envelopes. The gateway consumes Redis only and never accesses database outbox state. Dataset/asset deletion cascades domain/outbox rows; a recipient notification is retained only after its context is nulled and converted to generic unavailable history.

**Rationale**: Worker-owned dispatch follows the existing private asynchronous execution boundary and keeps the gateway transport-only. Retaining a context-free notification satisfies history expectations without leaking deleted data.

### Realtime topology

**Decision**: Use a dedicated delivery-only realtime gateway, ADR-gated before implementation. The gateway is public only for WebSocket delivery, has no REST commands or durable read API, verifies a short-lived ticket issued by authorized Next.js, uses Redis pub/sub for fan-out and TTL keys for presence, and publishes only safe invalidation/presence signals.

**Rationale**: The repository runs Next with `next dev`/`next start`, has no existing upgrade handler, and `docker/review-proxy.conf` has no gateway/upgrade location. [Next.js custom-server guidance](https://nextjs.org/docs/app/guides/custom-server) identifies a custom server as an escape hatch and warns of optimization trade-offs. A separate delivery process avoids converting the web process into a custom server and can scale independently without creating a duplicate command backend.

**Alternatives considered**: Host WebSocket upgrades inside a custom Next server (rejected: runtime/optimization change and makes web connection lifecycle a special case); browser polling only (rejected: cannot meet timely presence); a general public microservice (rejected: violates the locked Next.js command boundary).

### Bell and Activity UI

**Decision**: Place the Bell immediately before Account in global and workspace headers. It has an accessible unread count, no visible badge at zero, and `99+` visual cap. Discussion opens an overlay/slide-in drawer; Activity is a read-only projection that merges existing membership, assignment, comment, notification, and workflow records and creates no `Activity` table or independent audit stream.

**Rationale**: This is consistent across existing headers, preserves the Properties Panel, and avoids a new domain authority for a display feature.

**Alternatives considered**: Bell only in the global header (rejected: users spend workflow time in the workspace); permanent fourth column (rejected: conflicts with established workspace layout); persisted activity feed (rejected: duplicate source of truth).

## Ownership boundaries

| Concern | Authority |
| --- | --- |
| Dataset membership, invitation, role | PostgreSQL durable collaboration records |
| Assignment and history | PostgreSQL durable collaboration records |
| Comment/thread and mention | PostgreSQL durable collaboration records |
| Notification and read state | PostgreSQL durable collaboration records |
| Outbox dispatch | Private worker Job handler; PostgreSQL event and existing Job are durable truth |
| Workflow state/history | Existing `Asset.status` / `AssetWorkflowEvent` (Phase 023) |
| Annotation content | Existing annotation models/revisions |
| Presence | Redis TTL state and gateway connection memory |
| WebSocket connection | Gateway process memory |
| Realtime delivery | Worker-published Redis fan-out plus gateway; gateway never reads outbox/DB and is never authoritative |
| Binary assets | MinIO |

## Audit findings

- `DatasetMember` is already unique by `(datasetId, userId)` and is currently active membership only; `/api/datasets/[datasetId]/members` is read-only for Phase 022 assignment UI.
- `Asset.assignedToId` is a single optional `User` relation and current Asset Browser semantics use it; it cannot represent independent annotation and review responsibility.
- Phase 023 uses `Asset.status` and append-only `AssetWorkflowEvent`; collaboration may notify after a transition but must not mutate either.
- `ioredis` is already a direct web dependency and Redis is a healthy Compose service. Current web Redis usage is queue/rate-limit oriented, not pub/sub or presence.
- Both normal and review Compose topologies have web, worker, PostgreSQL, Redis, and MinIO. The review topology proxies web through nginx; no realtime service or upgrade forwarding exists.
- The current headers have Account controls but no Bell; workspace header already owns workflow controls, so collaboration controls must not enter Properties Panel.

## Planning requirements carried forward

1. Add an ADR before adding `apps/realtime`, a WebSocket server dependency, Compose service, proxy upgrade route, or realtime environment variables.
2. Use Prisma transactions and uniqueness constraints for invitation acceptance, assignment slot changes, comment mention/notification creation, and idempotency keys.
3. Design test fixtures for two users, membership revocation while connected, retry/replay, and offline notification recovery.
4. Document every new browser-facing REST endpoint in OpenAPI and document realtime event types separately; WebSocket delivery never accepts business commands.

---

## Shareable invitation-link extension audit — 2026-09-07

### Phase 024 baseline status

The audited Phase 024 collaboration architecture is now stable: recipient-specific invitations and `DatasetMember` authorization are durable; the private worker relays committed outbox intents to Redis; the delivery-only gateway uses fresh scoped tickets, handles membership revocation, and clients converge through authorized REST/Next refresh; Redis TTL presence is non-authoritative. The extension is deliberately a narrow new membership-admission record and does not reopen this architecture decision.

### Repository evidence

| Concern | Evidence and conclusion |
| --- | --- |
| Existing invitation | `DatasetInvitation.inviteeUserId` is required and its portable uniqueness rule is `@@unique([datasetId, inviteeUserId, activeKey])`. It cannot safely become a recipient-less link without nullable-recipient migration, altered uniqueness, and lifecycle ambiguity. |
| Membership authority | `DatasetMember` is the unique active relationship (`@@unique([datasetId, userId])`). Existing invitation acceptance already converges here; it is the only relationship used by current dataset/workspace authorization. |
| Role grant policy | `canManageDatasetMemberRole` permits Owner to manage any non-Owner role and Manager to manage only Labeler/Reviewer. The same helper must govern link issuance and claim-time revalidation. |
| Transaction/delivery | `runCollaborationTransaction(...)` provides serializable Prisma retry behavior. Existing collaboration services create durable notification/outbox intent in it and enqueue the private-worker dispatch job after commit. |
| Realtime | Tickets and gateway scopes are derived from authorized membership; member removal emits the existing revocation path. A successful claim needs ordinary membership-change invalidation, not a token-specific gateway path. |
| Deletion | Dataset relations use cascade deletion; invitation creators are restricted by the existing recipient-specific model. The separate link model must use explicit Prisma relations and preserve safe terminal history without retaining the raw secret. |
| Rate limiting | The repository has Redis-backed fixed-window `checkRateLimit` and `enforceRateLimit`, currently keyed by authenticated user and a closed category union. Public preview needs a privacy-safe unauthenticated identity policy; this is an approval gate, not new authority. |
| Activity | It is a read-only projection of durable records. It has no table and must receive only safe link lifecycle/member events, never a raw token or a displayable digest. |

### Options evaluated

| Option | Decision | Reason |
| --- | --- | --- |
| A. Make `DatasetInvitation.inviteeUserId` nullable and overload it for links | Rejected | Breaks its clear recipient-specific invariant, complicates its pending uniqueness rule, makes acceptance and anonymous claim states ambiguous, and creates a larger unsafe migration. |
| B. Add `DatasetInvitationLink` and converge on `DatasetMember` | **Selected** | Preserves recipient-specific invitations unchanged, gives token lifecycle a clear bounded model, and provides a unique digest lookup and single-use claim guard without raw SQL. |
| C. Store a link token in a generic metadata/notification/event record | Rejected | No durable lifecycle, no database identity/uniqueness invariant, poor auditability, and risks treating a delivery artifact as authorization state. |

### Selected design

Use a separate `DatasetInvitationLink` with a unique `tokenHash`, lifecycle state (`PENDING`, `CLAIMED`, `REVOKED`, `EXPIRED`), immutable non-Owner role, creator, expiry, and successful claimant evidence. Generate a cryptographically random 256-bit secret, encode it URL-safely, and persist only `SHA-256(secret)` as the lookup key. The secret is returned exactly once to the creator and is never stored in normal display/audit/activity/notification/realtime data.

The share URL should put its secret in a fragment, for example `/join#<secret>`, so it is not sent in navigation request paths or ordinary proxy access logs. The browser landing page reads the fragment and submits it only in JSON bodies to the safe preview/claim routes. Those handlers and request logging must keep request bodies redacted. This is selected over a token path/query URL because public route logging would otherwise routinely retain a reusable secret.

`PENDING -> CLAIMED` is guarded in the serializable claim transaction. The transaction first checks current link state, expiry, dataset existence, effective creator management authority, encoded-role grantability, and claimant membership. It then creates `DatasetMember`, writes safe membership/link audit evidence, marks the link claimed with `claimedById`, creates the existing membership-change/notification outbox intent, and commits. A failed step rolls back all of it. The existing private worker later enqueues/dispatches delivery; Redis and the gateway are never claim authority.

### Deterministic terminal and replay policy

- Valid unused link + non-member claimant: success and consume.
- Consumed link + same recorded claimant: return the original successful membership projection (`reused: true`) without a second mutation; this handles a lost response.
- Consumed link + another claimant, revoked link, expired link, deleted dataset, or creator no longer eligible: generic `UNAVAILABLE`; no protected detail and no membership.
- Existing member + unused link: `ALREADY_MEMBER`; no role change and the unused link remains available for another existing-account claimant.
- Preview has only `AVAILABLE` and generic `UNAVAILABLE` for non-claimable states. Claim uses the same generic public terminal result except authenticated `ALREADY_MEMBER` and same-claimant idempotent success.

### Final notification, audit, and realtime policy

Link creation, revoke, expiry, unavailable claim, and `ALREADY_MEMBER` produce **no notification**. A successful first claim produces exactly one idempotent `DATASET_MEMBER_JOINED` notification for the link creator only when the claimant differs from that creator. The claimant receives the successful claim response directly; unrelated members, Managers, and Owners receive none. Its dedupe key is `invitation-link-claim:{linkId}:creator:{creatorId}` and contains neither the token nor digest. Same-claimant replay reuses the original result and notification; different-claimant replay produces no notification.

Link creation, revocation, and claim use additive safe membership/invitation event actions so Activity can project attribution/time/role but never the token or digest. A successful claim emits the existing safe membership-change outbox intent. Realtime is delivery optimization only: post-claim authoritative REST/ticket reads see membership even if delivery is missed.

### Claim/revoke race rule

The first successfully committed guarded lifecycle transition wins. Claim and revoke each operate on the same `PENDING` row inside a serializable `runCollaborationTransaction(...)` attempt. If revoke commits first, claim observes non-pending state and returns generic unavailable without a member. If claim commits first, revoke observes `CLAIMED`, does not alter it, and returns its approved terminal/idempotent result. Prisma serialization retries must re-read state; neither path may independently create a member before the winning transition is secured.

### Projection separation

Public preview is intentionally minimal and is the only unauthenticated projection: `AVAILABLE` with dataset display name, role, inviter display name, or generic `UNAVAILABLE` with no context. Authorized manager history is separate and uses current Owner/Manager role authorization; it may show safe operational link metadata and claimant identity only under the same disclosure rules as existing member management. Neither projection includes raw token, hash, or reusable URL after the initial issuance response.

### Approval gates before implementation

1. Approve separate `DatasetInvitationLink`, not an extension of `DatasetInvitation`.
2. Approve SHA-256 digest of a 256-bit random URL-safe secret, fragment share URL, and generic invalid-state projection.
3. Approve the lifecycle/event enum additions and migration/FK behavior, including history policy for a deleted dataset/user.
4. Approve fixed v1 expiry (recommended seven days using an existing non-secret configuration convention) and whether managers can select a bounded shorter expiry.
5. Approve the public preview/claim rate-limit identity, category, threshold, and fail-closed/fail-open behavior; no client IP must be logged as token metadata.
6. Confirm the finalized creator-only `DATASET_MEMBER_JOINED` claim-notification and safe Activity projection policy.

No new dependency, gateway, Redis authority, Compose change, or environment secret is required by the selected design.
