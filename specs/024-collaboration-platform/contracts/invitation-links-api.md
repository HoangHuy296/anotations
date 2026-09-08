# Shareable Invitation Links — REST Contract (planned)

This is an additive Phase 024 planning contract. REST remains the only command/read boundary. Link tokens are secrets, not dataset credentials; every post-claim dataset read still authorizes `DatasetMember`.

## Token transport

The create response returns a one-time share URL in the form `/join#<secret>`. The secret is in the fragment, not an HTTP route/query. The landing client sends `{ "token": "..." }` only in JSON bodies to preview/claim endpoints. Route/request-body logging must redact it. Responses, errors, notifications, audit, Activity, and realtime messages never return a reusable raw token.

## Manager endpoints

### `POST /api/datasets/{datasetId}/invitation-links`

Authenticated Owner/eligible Manager only; current `canManageDatasetMemberRole` is enforced. Body: `{ "role": "LABELER" | "REVIEWER" | "MANAGER" }` subject to that helper; `OWNER` is invalid. Expiry is service-controlled in v1 unless the approved bounded-expiry policy adds a validated input.

Success `201`: safe link metadata plus the one-time `shareUrl`. This is the sole raw-secret disclosure; subsequent list, revoke, preview, claim-retry, notification, Activity, realtime, audit, and error responses never include `shareUrl`, token, or digest. Errors use existing validation/authorization/concealment envelopes.

### `GET /api/datasets/{datasetId}/invitation-links`

Authenticated Owner/eligible Manager only. This is an authorized management projection, not public preview. It returns paginated safe history: ID, role, lifecycle/timestamps, and creator/claimant identity only to the extent already allowed by member management. It never returns a raw token, digest, reusable URL, internal authorization reason, or protected dataset content. Dataset concealment follows existing member-management routes.

### `POST /api/datasets/{datasetId}/invitation-links/{linkId}/revoke`

Authenticated actor currently authorized to manage the encoded role. Revokes only unused pending link in a collaboration transaction. `CLAIMED`, `REVOKED`, and unavailable links return the established idempotent/concealed result approved at implementation; they never disclose token material.

## Landing and claim endpoints

### `POST /api/invitation-links/preview`

Public, rate-limited JSON body `{ "token": string }`. Valid unused link returns exactly:

```json
{
  "availability": "AVAILABLE",
  "dataset": { "displayName": "..." },
  "role": "LABELER",
  "inviter": { "displayName": "..." }
}
```

Every unknown, expired, revoked, consumed, creator-ineligible, or deleted-context result uses generic `UNAVAILABLE` and omits all protected fields. Preview never creates a membership, audit event, notification, or outbox record.

### `POST /api/invitation-links/claim`

Authenticated, rate-limited JSON body `{ "token": string }`; explicit user action only. It runs the full claim transaction. Success is `201` for a first claim or `200` with `reused: true` for a lost-response retry by the recorded claimant, returning a safe normal membership projection and `workspaceUrl: "/workspace/{datasetId}"` for an **Open workspace** CTA. This is a navigation target, not a capability: that route independently performs normal current `DatasetMember` authorization and receives no invitation secret/fragment.

`ALREADY_MEMBER` is a deterministic authenticated `409` with no membership or role mutation and does not consume a pending link. A successful first claim creates exactly one durable `DATASET_MEMBER_JOINED` notification for the creator if and only if creator and claimant differ; claimant and bystanders receive none. Same-claimant replay returns the success projection without a new notification. Nonclaimable links return generic unavailable/concealed behavior; unauthenticated callers receive the established authentication response. No branch returns the raw token or internal authority details.

## Delivery and reauthorization

Successful claim creates durable safe membership/outbox intent in the same transaction. The existing private worker dispatches after commit; direct Redis publication is forbidden. A recipient uses normal REST and fresh ticket authorization after claim. If subsequently removed, normal membership revocation applies and neither the old share link nor an old realtime ticket restores access.

Revoke and claim use first-committed-transition-wins semantics on the same pending record: revoke-first yields unavailable/no membership; claim-first yields claimed/no later revocation. The public preview remains intentionally coarser than authorized management history and never reveals which terminal condition occurred.

## OpenAPI requirements

Add schemas and all five operations to `specs/api/openapi.yaml` / `specs/api/schemas/collaboration.yaml`: request validation, safe response DTOs, `401`, `403`/concealed `404`, `409 ALREADY_MEMBER`, generic unavailable, and `429 RATE_LIMITED`. Never document the raw secret in a URL parameter or example URL.
