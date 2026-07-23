# Data Model: Provider Adapter + Lightweight Preflight

## Persistent-data impact

This phase creates **no persistent entity**, Prisma schema change, migration,
or database write. Existing `SourceConnection` is read only and may be
resolved only after the current actor is authorized. No Dataset, Job, JobEvent,
Asset, ExternalRepository, manifest, Redis record, or MinIO object is created
or updated.

## Transient entities

### Preflight Request

| Field | Rules |
| --- | --- |
| `provider` | Required supported provider: GitHub or Gitea. Unknown values are rejected. |
| repository identity | Required provider-safe repository identifier; it identifies owner/namespace and repository name without embedding a token. |
| repository address | Required only where provider selection requires a non-default base address; validates under server source-access policy. |
| `ref` | Optional. If present it must be checked exactly; if absent the provider resolves its default ref. |
| `rootPath` | Optional repository-relative path. It is normalized by the existing root-path policy; omitted means repository root. |
| `sourceConnectionId` | Optional existing identifier. It is resolved server-side and never creates/changes a connection. |

The schema rejects unknown keys, tokens, credential-bearing URLs, policy
overrides, queue fields, storage fields, manifest data, and browser ownership
claims.

### Resolved connection context

Server-only, ephemeral context containing a safe provider base address and,
when eligible, one decrypted token. It is never returned, persisted in a Job,
or written to logs. A foreign, inactive, revoked, expired, or malformed
connection is treated according to concealed-resource policy before an adapter
is called.

### Resolved Ref

Safe provider/ref metadata returned after exact/default-ref verification. It
contains the requested/resolved ref identity and may include a safe immutable
revision identity when the provider exposes one. It contains no raw provider
body or credential-derived account data.

### Root-path outcome

The normalized optional root selector and boolean existence result. It is based
on one bounded provider metadata/listing operation, is not a file manifest,
and is never persisted.

### Preflight Result

Safe transient DTO: provider, safe repository identity, safe accessibility
state, resolved ref, and optional normalized root-path result. It excludes
connection ID/internal status, base URL, tokens, encrypted material, provider
bodies, full file listings, private URLs, queue state, and storage locations.

### Adapter failure

Internal normalized outcome projected only as a stable safe HTTP code. Semantic
repository failures use the specification's preflight codes. Operational
provider unavailability has a generic safe retryable response and no exposed
diagnostic detail.

## State rules

- Preflight has no persisted state transition.
- A connection remains unchanged whether preflight succeeds or fails.
- Omitted `ref` is resolved to the current provider default; supplied `ref`
  is never substituted.
- An optional root path is checked only after repository/ref accessibility.
- GitHub public repositories may be anonymous; private GitHub does not gain a
  new credential lifecycle in this phase.
