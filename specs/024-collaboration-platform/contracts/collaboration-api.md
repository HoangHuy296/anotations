# Collaboration REST Contract

All commands and authoritative reads use the established authenticated Next.js API boundary, Zod validation, dataset scope checks, and the existing API error envelope. This document defines the intended contract for OpenAPI work; it does not authorize implementation yet.

## Dataset members and invitations

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/datasets/{datasetId}/members` | Authorized member directory; expands the existing read-only list safely. |
| POST | `/api/datasets/{datasetId}/invitations` | Create/reissue a pending invitation for an existing user and proposed eligible role. |
| GET | `/api/datasets/{datasetId}/invitations` | List invitations for authorized managers; recipients use their own pending list. |
| POST | `/api/invitations/{invitationId}/accept` | Accept pending invitation atomically. |
| POST | `/api/invitations/{invitationId}/decline` | Decline pending invitation. |
| POST | `/api/datasets/{datasetId}/invitations/{invitationId}/revoke` | Revoke pending invitation. |
| PATCH | `/api/datasets/{datasetId}/members/{userId}` | Change an eligible member role. |
| DELETE | `/api/datasets/{datasetId}/members/{userId}` | Remove member and incompatible assignments; trigger subscription revocation. |

## Assignments

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/datasets/{datasetId}/assets/{assetId}/assignments` | Authorized current annotation/review assignment projection and safe history. |
| PUT | `/api/datasets/{datasetId}/assets/{assetId}/assignments/{type}` | Assign or reassign `ANNOTATION`/`REVIEW` responsibility. |
| DELETE | `/api/datasets/{datasetId}/assets/{assetId}/assignments/{type}` | Unassign responsibility. |

`type` is server-validated. The target user must be an eligible current member. These endpoints do not accept a target Asset status and never write Phase 023 workflow state.

## Discussion

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/datasets/{datasetId}/assets/{assetId}/comments` | Authorized root threads with direct replies, mentions, resolution, and safe pagination. |
| POST | `/api/datasets/{datasetId}/assets/{assetId}/comments` | Create root comment or direct reply. |
| PATCH | `/api/comments/{commentId}` | Author edit or authorized moderation. |
| DELETE | `/api/comments/{commentId}` | Author soft delete or authorized moderation. |
| POST | `/api/comments/{commentId}/resolve` | Resolve root thread or reply's root. |
| POST | `/api/comments/{commentId}/reopen` | Reopen root thread or reply's root. |

The POST payload accepts a body and optional root parent identifier only. A parent that is already a reply is invalid. Mention extraction is server-derived; clients never submit recipient IDs as authoritative mention data.

## Notifications and realtime tickets

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/notifications` | Current user's paginated durable notification history and unread count. |
| POST | `/api/notifications/{notificationId}/read` | Mark one notification read. |
| POST | `/api/notifications/read-all` | Mark all current-user notifications read. |
| POST | `/api/realtime/ticket` | Authorized, short-lived connection ticket with dataset scopes; never a provider or Redis credential. |

Notification deep links are safe context pointers only. On navigation, normal workspace authorization decides whether the linked context is available.

## Common guarantees

- Commands require authentication and current authorization; UI visibility is not relied on.
- Out-of-scope asset/comment/member identifiers are concealed consistently with existing dataset behavior.
- Accepted commands are idempotent where retry can occur; notification retries use durable dedupe keys.
- Server responses never include Redis credentials, database credentials, provider tokens, MinIO details, private source URLs, or annotation geometry in collaboration DTOs.
- Every new REST route must be added to `specs/api/openapi.yaml` with its success and error response schema before implementation closes.
