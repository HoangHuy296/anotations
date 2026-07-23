# Provider Adapter Contract

## Common interface

```ts
interface RepositoryProviderAdapter {
  preflight(input: PreflightInput): Promise<PreflightResult>;
  resolveRef(input: ResolveRefInput): Promise<ResolvedRef>;
  listFiles(input: ListFilesInput): Promise<SourceFileManifest[]>;
  downloadFile(input: DownloadFileInput): Promise<ReadableStream>;
  validateToken?(input: ValidateTokenInput): Promise<TokenValidationResult>;
}
```

All implementations are server-only. Inputs contain only normalized,
server-validated repository identity, ref/path selectors, and an optional
server-resolved transient credential context. They must never be browser DTOs,
Job input, or logs.

## Phase 014 invocation rules

| Method | Phase 014 use |
| --- | --- |
| `preflight` | Required; confirms repository accessibility and coordinates bounded checks. |
| `resolveRef` | Required; resolves exactly the supplied ref or safe provider default. |
| `listFiles` | Allowed only for a bounded root-existence check; never return/persist a full repository tree. |
| `downloadFile` | Defined for future provider processing but must not be invoked. |
| `validateToken` | Optional; invoked only with a server-resolved eligible connection when needed for access confirmation. |

## Error normalization

Adapters normalize provider behavior before it crosses the route boundary:

| Adapter condition | Contract code |
| --- | --- |
| Provider unsupported | `UNSUPPORTED_PROVIDER` |
| URL/DNS/redirect fails policy | `UNSAFE_REPOSITORY_URL` |
| Repository missing | `REPOSITORY_NOT_FOUND` |
| Repository inaccessible | `REPOSITORY_ACCESS_DENIED` |
| Credential expired/revoked | `SOURCE_TOKEN_EXPIRED` |
| Credential malformed/invalid | `SOURCE_TOKEN_INVALID` |
| Exact ref absent | `REF_NOT_FOUND` |
| Exact root path absent | `ROOT_PATH_NOT_FOUND` |

Transport unavailability, timeout, rate limiting, and invalid upstream payload
remain safe generic operational failures; provider response text, status body,
URL, and token are never forwarded.

## Provider selection

- **Gitea**: can use one existing owned active Gitea SourceConnection. Its
  base address and credential are resolved server-side.
- **GitHub**: supports anonymous public preflight using the canonical provider
  endpoint. Private preflight is denied until a separately approved GitHub
  SourceConnection lifecycle exists.

## Redirect and address safety

Before the first provider request and before every followed redirect, adapters
must validate the destination using the shared server-controlled source-access
policy. A redirect is not followed until its target passes. Browser input
cannot add an allowlist, trusted host, DNS result, or policy limit.
