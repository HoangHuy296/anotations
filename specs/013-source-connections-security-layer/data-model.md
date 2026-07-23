# Data Model: Source Connections Security Layer

## Existing authoritative entities

| Entity | Relevant fields | Feature rule |
| --- | --- | --- |
| `User` | `id`, system `role` | `userId` is the default connection ownership boundary. Administrator access follows existing system-wide policy. |
| `AuthSession` | session owner, expiry, revocation | The actor is resolved from a valid opaque session before every connection or source operation. |
| `SourceConnection` | `id`, `userId`, `provider`, `authType`, `baseUrl`, `name`, encrypted token fields, `tokenExpiresAt`, `status`, `revokedAt`, timestamps | Authoritative connection record. Only server-only code may read encrypted token fields. First implementation accepts Gitea token connections only. |
| `Dataset` | source connection relation, source root and branch fields | A root path is selected per source-backed Dataset operation; it is not a credential and must be normalized/validated before use. |
| `Job` | `sourceConnectionId`, `input`, lifecycle, retry lineage | May reference a connection by ID and contain only allowlisted source metadata. It must not contain token material, credential-bearing URLs, or raw provider responses. |
| `JobEvent` | safe message and data | May record an allowlisted safe error code/state; never provider diagnostics or token material. |

## SourceConnection lifecycle

```text
create request
  -> local URL/path/limit validation
  -> encrypted server-side persistence in non-active validation state
  -> server-side provider validation
  -> ACTIVE | EXPIRED | ERROR

ACTIVE
  -> expired/invalid validation -> EXPIRED or ERROR
  -> explicit owner deletion (only with no non-terminal references) -> REVOKED/deleted

REVOKED, EXPIRED, ERROR
  -> cannot be selected for new source-backed access
```

The implementation selects the precise durable write sequence so a provider-validation failure never leaves a connection incorrectly active. The browser receives only a safe projection.

## Safe connection projection

Browser/API consumers may receive only:

```text
id
provider
name (if supplied)
status
tokenExpiresAt (if known and safe to disclose)
createdAt
updatedAt
```

The projection must not contain `baseUrl`, `tokenEncrypted`, `refreshTokenEncrypted`, `metadata`, account identifiers, scopes, revocation diagnostics, or provider response content.

## Validation invariants

1. A connection is owned by exactly one user and every use resolves the current session actor first.
2. Only `ACTIVE`, non-revoked connections with a valid encrypted token may be used by a source operation.
3. Provider address must use a supported Gitea scheme, have no embedded credentials/query/fragment, and pass fresh destination classification. Numeric IP literals are denied unless the server independently matches an exact deployment-controlled IP/CIDR exception.
4. Root path is repository-relative, normalized, traversal-free, and within configured length/depth limits.
5. Finite server-controlled source entry-count, total-size, and duration limits are checked before Job creation, enqueue, or binary transfer; browser input cannot override a policy value.
6. A Job references `sourceConnectionId`; input does not duplicate token, encrypted token, raw URL, or provider response.
7. A connection cannot be deleted while a referencing Job is non-terminal.
8. Worker-side resolution reloads the authoritative connection and repeats owner/status/URL/path/token validation before decrypting in memory.

## No planned schema change

The existing model covers this phase. Planning must stop and request approval before adding fields, indexes, a migration, or a new credential entity.
