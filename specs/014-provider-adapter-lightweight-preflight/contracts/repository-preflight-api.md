# Repository Preflight API Contract

## Operation

`POST /api/source-repositories/preflight`

This authenticated opaque-cookie operation checks a repository before later
import work. It is non-persistent and must send `Cache-Control: no-store`.

## Request

The body is a strict JSON object with:

```ts
{
  provider: "GITHUB" | "GITEA";
  repository: {
    owner: string;
    name: string;
    baseUrl?: string;
  };
  ref?: string;
  rootPath?: string;
  sourceConnectionId?: string;
}
```

`baseUrl` is accepted only where the server needs it for the chosen provider
and must pass source-access policy. When `sourceConnectionId` is supplied, the
server independently resolves its eligible provider/base address and rejects a
mismatch. The route never accepts a token, credential, policy override,
manifest, Dataset ID, Job field, queue field, storage field, or owner ID.

## Success response

`200 OK`

```ts
{
  preflight: {
    provider: "GITHUB" | "GITEA";
    repository: { owner: string; name: string };
    ref: { requested: string | null; resolved: string; revision: string | null };
    rootPath: { requested: string | null; normalized: string | null; exists: boolean };
  };
}
```

The response is a safe DTO. It must not include token/credential material,
connection internals, base/private URLs, provider response bodies, manifests,
storage/queue fields, configuration, or stack traces.

## Failure projection

| Condition | HTTP result | Safe code |
| --- | --- | --- |
| No valid session | 401 | `AUTH_REQUIRED` |
| Invalid/unknown body fields | 400 | `INVALID_REQUEST` |
| Unsupported provider | 400 | `UNSUPPORTED_PROVIDER` |
| Unsafe URL/DNS/redirect | 400 | `UNSAFE_REPOSITORY_URL` |
| Foreign or unknown connection | 404 | concealed resource outcome |
| Repository not found | 404 | `REPOSITORY_NOT_FOUND` |
| Repository not accessible | 403 | `REPOSITORY_ACCESS_DENIED` |
| Expired/revoked credential | 422 | `SOURCE_TOKEN_EXPIRED` |
| Invalid credential | 422 | `SOURCE_TOKEN_INVALID` |
| Missing supplied ref | 404 | `REF_NOT_FOUND` |
| Missing supplied root path | 404 | `ROOT_PATH_NOT_FOUND` |
| Provider unavailable, timeout, malformed response, rate limit | 503 | existing generic safe provider-unavailable outcome |

No error response may echo request URLs, ref/path values when unsafe, provider
diagnostics, tokens, credentials, stack traces, or server configuration.

## Implementation boundary note

The Route Handler calls only the server-only provider-preflight coordinator.
It validates the opaque-session actor and strict request body before provider
selection, returns `Cache-Control: no-store` on success and failure, and does
not call the legacy repository-import route. Provider redirects are validated
per hop; credential headers remain confined to their original provider origin.

## No-side-effect guarantee

Every result leaves Dataset, Job, JobEvent, SourceConnection, Asset,
ExternalRepository, Redis/BullMQ, MinIO, and persisted manifests unchanged.

## Dataset import UI contract (approved amendment)

`POST /api/source-import-preflight` is the read-only endpoint used by
`/datasets/imports`. Its strict request selects exactly one credential mode:

```ts
type CredentialMode =
  | "PUBLIC"
  | "EXISTING_SOURCE_CONNECTION"
  | "ONE_TIME_PAT";
```

`PUBLIC` supplies a policy-validated Gitea server URL but no credential.
`EXISTING_SOURCE_CONNECTION` supplies only an owned active connection ID.
`ONE_TIME_PAT` supplies server URL and PAT for transient validation; the PAT
is never returned or persisted by preflight. The response contains only safe
repository/ref/root/visibility information and has the same no-side-effect
guarantee above.

For the dataset-import UI, the safe response also includes the resolved branch
(`repository.ref`), commit identity (`repository.revision`), and an optional
bounded `assetPreview`:

```ts
{
  detectedAssetCount: number;
  detectedBytes: number;
  truncated: boolean;
  sample: Array<{
    path: string;
    size: number | null;
    modality: "IMAGE" | "VIDEO" | "AUDIO" | "TEXT";
  }>;
}
```

This is a read-only, capped preview—not a durable manifest and not an
authorization to import. When `truncated` is true, `detectedAssetCount` is a
lower bound. The DTO must not contain provider URLs, file download URLs,
credentials, or raw provider payloads.

`POST /api/source-import-jobs` is the distinct Start Import boundary. It
re-runs preflight before opening a transaction. A one-time PAT request must
set `saveAsSourceConnection: true` and supply a connection name; otherwise it
returns `422 ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT`. Within one
transaction it creates the Dataset, optionally creates an encrypted owned
Gitea SourceConnection, and creates the durable `IMPORT_DATASET` Job. Only
after commit may it enqueue the exact BullMQ payload `{ jobId }`.

The Job input may contain safe repository identity, bounded manifest summary,
and source connection ID. It MUST NOT contain a PAT, encrypted credential,
provider Authorization header, queue internals, or browser-supplied storage
reference. Queue-enqueue failure leaves the canonical Job `QUEUED` for the
existing recovery scanner.
