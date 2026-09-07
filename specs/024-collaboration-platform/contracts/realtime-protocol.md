# Realtime Delivery Contract

## Boundary

WebSocket is delivery and invalidation only. It accepts no domain mutation, no authoritative durable read, no annotation geometry, and no browser-supplied authorization claim. REST remains the sole command/read boundary.

The private worker dispatches accepted durable outbox events to Redis after commit. The gateway consumes only those Redis envelopes; it never reads, claims, or processes PostgreSQL outbox rows.

The durable outbox row and its common PostgreSQL Job are created in the accepted command transaction. The private worker later resolves the Job and publishes the safe envelope on Redis. A publish/stamp crash may repeat delivery, so browsers treat non-presence events as invalidations and refresh REST state.

## Connection

1. Browser obtains a short-lived connection ticket from the authorized Next.js ticket endpoint.
2. Browser opens the gateway connection with that ticket using a transport-safe handshake mechanism.
3. Gateway validates ticket expiry/signature and allows only ticket-scoped dataset subscriptions.
4. Membership removal/downgrade causes subscription revocation or reauthorization; ticket expiry is defense in depth.

The ticket carries only opaque identity/scope/expiry information. It is not persisted in browser storage and is never a Redis, provider, storage, or database credential.

## Envelope

```text
{
  id: string,
  type: string,
  occurredAt: ISO-8601 timestamp,
  datasetId?: string,
  assetId?: string,
  payload: safe small invalidation or presence fields
}
```

## Event types

| Category | Types | Browser behavior |
| --- | --- | --- |
| Presence | `presence.joined`, `presence.updated`, `presence.left` | May update lightweight avatar stack directly. |
| Discussion | `comment.created`, `comment.updated`, `comment.deleted`, `comment.resolved` | Refresh thread/Activity from REST. |
| Assignment | `assignment.created`, `assignment.updated`, `assignment.removed` | Refresh assignment projection from REST. |
| Membership | `member.joined`, `member.role_changed`, `member.removed` | Refresh directory/permissions; removal ends affected subscriptions. |
| Notification | `notification.created`, `notification.read` | May refresh unread count/list from REST. |
| Workflow | `workflow.submitted`, `workflow.reviewed` | Refresh existing Phase 023 history/status from REST. |

`workflow.reviewed` is a delivery category only; detailed action/status are read from Phase 023's existing authoritative endpoint. No event includes rejection feedback or annotation geometry.

## Presence

- Browser sends heartbeat/activity only after an authorized connection.
- Gateway stores dataset/asset presence under Redis TTL keys and publishes safe presence updates.
- Presence expiration emits `presence.left` when practical; consumers also tolerate TTL disappearance.
- **PRESENCE IS NOT A LOCK.** It cannot deny an authorized REST command or establish exclusive edit ownership.

## Delivery guarantees

- Delivery is at-least-once and may be duplicated, delayed, or reordered.
- Durable domain changes and notifications are idempotent before any event is published.
- Clients treat all non-presence events as invalidations and refresh durable state after reconnect or uncertainty.
- Gateway logs only connection/event metadata allowed by the security policy, never comment bodies, feedback, geometry, or credentials.
