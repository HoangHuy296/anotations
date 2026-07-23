# Source Connections API Contract

## Global boundary

All operations require a valid opaque-cookie session. The server resolves the actor and ownership itself. Out-of-scope connection identifiers follow the project concealed-resource policy; no endpoint confirms a foreign connection's existence. Responses are non-cacheable and use safe DTOs only.

## `GET /api/source-connections`

Returns the current actor's safe connection summaries. An administrator may see only the scope permitted by the established system-wide administrator policy; the default user sees only owned records.

**Success response**

```json
{
  "connections": [
    {
      "id": "connection-id",
      "provider": "GITEA",
      "name": "Optional display name",
      "status": "ACTIVE",
      "tokenExpiresAt": null,
      "createdAt": "2026-07-22T00:00:00.000Z",
      "updatedAt": "2026-07-22T00:00:00.000Z"
    }
  ]
}
```

## `GET /api/source-connections/[id]`

Returns one safe connection DTO. An owner receives `200`; an administrator
follows the established global administrator policy and also receives the safe
DTO. A foreign, revoked, malformed, or unknown identifier returns the same
concealed `404` response for a non-administrator. This endpoint never confirms
ownership or serializes a raw connection model.

## `POST /api/source-connections`

Creates and validates a Gitea token connection. The request is validated before encryption or provider access. A root path is not a connection field; it is separately validated by an authorized source operation.

**Request shape**

```json
{
  "provider": "GITEA",
  "name": "Optional display name",
  "baseUrl": "https://gitea.example.test",
  "token": "submitted transiently"
}
```

**Success response**: `201` with one safe connection summary.

**Safe failures**

| Condition | Status | Stable code |
| --- | --- | --- |
| no valid session | 401 | `UNAUTHENTICATED` |
| malformed request | 400 | `VALIDATION_ERROR` |
| unsafe address | 400 | `SOURCE_URL_UNSAFE` |
| unsupported provider/authentication | 400 | `SOURCE_CONNECTION_UNSUPPORTED` |
| duplicate active identity | 409 | `SOURCE_CONNECTION_EXISTS` |
| provider reports expired token | 401 or 422 by existing safe convention | `SOURCE_TOKEN_EXPIRED` |
| invalid/rejected token | 422 | `SOURCE_TOKEN_INVALID` |
| provider unavailable/timeout | 503 | `SOURCE_PROVIDER_UNAVAILABLE` |

The response contains only safe code/message fields. It never echoes the token, URL, provider response, encryption material, or stack trace.

## `DELETE /api/source-connections/[id]`

Deletes or revokes the actor's connection according to the durable lifecycle service. It first verifies ownership and that no non-terminal Job references the connection.

| Condition | Status | Stable code |
| --- | --- | --- |
| owner delete succeeds | 204 | none |
| no session | 401 | `UNAUTHENTICATED` |
| foreign or unknown ID | concealed-resource policy | `NOT_FOUND` where that is the project convention |
| referenced by active Job | 409 | `SOURCE_CONNECTION_IN_USE` |

No successful or denied response includes a raw connection model or secret.

## `POST /api/source-import-jobs`

Creates the existing durable `IMPORT_DATASET` source Job through the normal
opaque-cookie application boundary. The route is intentionally narrow: it
accepts no provider URL, token, queue field, storage key, or binary data.

```json
{
  "datasetId": "dataset-id",
  "sourceConnectionId": "connection-id-or-null",
  "repository": {
    "provider": "GITEA",
    "owner": "safe-owner",
    "repo": "safe-repository",
    "branch": "main",
    "rootPath": "repository-relative-path",
    "visibility": "PRIVATE"
  },
  "manifest": { "itemCount": 1, "declaredBytes": 1 }
}
```

`PRIVATE` requires an active owned connection; `PUBLIC` requires `null` and
uses anonymous worker access. The server normalizes `rootPath`, applies
server-controlled limits, then re-resolves the active owned connection inside
the serializable durable-Job transaction. Only after commit does it enqueue
the canonical `{ "jobId": "..." }` payload.

**Success**: `201` (or `202` when transport is temporarily unavailable) with
only `{ job: { id, datasetId, type, status } }`. It never returns queue
metadata, source URL, token, encrypted fields, or provider diagnostics.

| Condition | Status | Stable code |
| --- | --- | --- |
| no session | 401 | `AUTH_REQUIRED` |
| malformed/public-private mismatch | 400 | `INVALID_REQUEST` |
| unsafe root | 400 | `SOURCE_ROOT_PATH_UNSAFE` |
| foreign or ineligible connection | concealed 404 | `SOURCE_CONNECTION_NOT_FOUND` |
| denied Dataset role | 403 | `FORBIDDEN` |
| configured limit exceeded | 422 | `SOURCE_IMPORT_LIMIT_EXCEEDED` |

## Response redaction rule

No response may expose `baseUrl`, encrypted token fields, plaintext token, refresh token, account identity, provider diagnostics, `SOURCE_CONNECTION_ENCRYPTION_KEY`, database/Redis/MinIO credentials, or server stack details.
