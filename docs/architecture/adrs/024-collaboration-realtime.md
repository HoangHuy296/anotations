# ADR 024: Collaboration Durability and Realtime Delivery

**Status**: Approved on 2026-09-04 — Phase 024 foundation, membership, assignment, discussion, durable notification, delivery-only gateway, Compose/proxy routing, reconnect, and Presence implementation are applied. The gateway remains delivery-only and Phase 11 closure evidence is tracked in `specs/024-collaboration-platform/quickstart.md`.

## Context

Phase 024 adds governed membership, typed assignments, discussion, notifications, realtime delivery, and presence around the locked Phase 022/023 workspace. Next.js remains the browser command and authoritative-read boundary. PostgreSQL/Prisma remains the durable source of truth. Redis is not a durable domain store. `Asset.status`, `AssetWorkflowEvent`, rejection feedback, annotation geometry, and annotation revision semantics remain unchanged.

## Approved decisions

1. **Assignment eligibility**: only an active `LABELER` may hold an `ANNOTATION` assignment and only an active `REVIEWER` may hold a `REVIEW` assignment. Owner/Manager may create, reassign, or remove assignments but cannot bypass the assignee's role eligibility.
2. **Pending invitation uniqueness**: `DatasetInvitation` uses `activeKey = "PENDING"` while pending and `NULL` at terminal states, with Prisma `@@unique([datasetId, inviteeUserId, activeKey])`. The service handles a uniqueness conflict transactionally; a reissue is possible only after terminal state.
3. **Durable delivery**: every accepted collaboration mutation that needs delivery writes its domain change, notification(s), and a safe `CollaborationOutboxEvent` in one Prisma transaction. The event has a stable dedupe identity. Notification rows are already durable before relay work starts.
4. **Outbox relay runtime ownership**: the private worker owns the outbox-dispatch Job handler. The command transaction creates/reuses a normal durable `Job`; BullMQ receives only `{ jobId }`. The worker resolves and claims the outbox event from PostgreSQL, publishes its safe delivery envelope to Redis after commit, and records dispatch completion. Duplicate job delivery or publish is safe because consumers treat it as at-least-once invalidation and durable state is idempotent.
5. **Membership revocation**: a membership removal/downgrade writes a revocation outbox event in the same transaction. After consuming the Redis revocation event, the gateway immediately drops that dataset scope; it closes a connection that has no remaining scope. The browser must obtain a fresh Next.js-issued ticket before another subscription. REST authorization remains an independent defense in depth.
6. **Presence and multi-tab behavior**: every tab has a connection ID. Redis stores per-connection TTL state plus expiring ZSET scope entries for `presence:dataset:{datasetId}` and `presence:asset:{assetId}`. Readers aggregate by user; any current `EDITING` connection takes precedence over `VIEWING`.
7. **Editing semantics**: `EDITING` means the selected asset is visible and the user recently interacted with an annotation or description editing surface. Blur/inactivity returns it to `VIEWING`. No geometry, pointer position, draft, lock, reservation, or authorization information is sent. **PRESENCE IS NOT A LOCK.**
8. **Reply and mention recipients**: a reply notifies its root author and users newly validly mentioned by that reply. The actor is excluded, recipients are deduplicated, and earlier reply authors are not notified merely because they participated. A normal comment edit sends no notification; mentions are recomputed atomically and only newly added valid non-self mentions receive one.
9. **Deletion and retained notifications**: dataset deletion cascades the dataset's collaboration domain rows, assignment history, comments, invitations, and undelivered outbox events. Asset deletion cascades its asset-scoped domain rows. Recipient notifications are retained only as a generic historical record: their dataset, asset, and comment foreign-key context is nulled, their context is marked unavailable, and their visible body/deep link is replaced with a safe unavailable outcome. No deleted dataset, asset, comment, or membership detail is readable or delivered.
10. **Gateway topology**: after explicit package/deployment approval, use a dedicated delivery-only `apps/realtime` process with the `ws` server library. The review proxy adds only an upgrade route to that process. The gateway accepts a short-lived signed ticket issued by Next.js, consumes Redis fan-out, manages connection/presence memory, and has no REST command, durable-read, direct PostgreSQL/outbox consumption, or annotation-synchronization capability.

## Consequences

- The private worker remains private and does not serve browser traffic; a transient Redis publish failure leaves the claimed dispatch Job for the existing lease-recovery/retry budget rather than terminally discarding durable delivery intent.
- The gateway is a delivery transport only. It never processes a database outbox record and never authorizes a mutation.
- Notification history is durable across deletion without retaining deleted protected context.
- The approved Prisma schema/migration, `ws` dependency, dedicated gateway process, Compose/proxy topology, and non-secret runtime variables are implemented. Subsequent collaboration work must reuse these boundaries and requires a new approved decision before changing them.

## Implementation boundary

The implementation boundary is complete for baseline Phase 024 collaboration. Any shareable-invitation-link extension remains gated by T096–T099 and must not use invitation secrets as REST, workspace, realtime, or presence credentials.
