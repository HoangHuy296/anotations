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
