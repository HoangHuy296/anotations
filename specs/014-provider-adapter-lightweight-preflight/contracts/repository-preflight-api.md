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

## No-side-effect guarantee

Every result leaves Dataset, Job, JobEvent, SourceConnection, Asset,
ExternalRepository, Redis/BullMQ, MinIO, and persisted manifests unchanged.
