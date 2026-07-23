# Source Job Boundary Contract

## Durable Job rule

Source-backed work uses the existing PostgreSQL `Job`. It may contain:

```ts
{
  sourceConnectionId: string,
  provider: "GITEA",
  source: {
    repositoryIdentity: string,
    normalizedRootPath: string,
    branch?: string
  }
}
```

The exact field names are finalized during implementation, but every field must be allowlisted and safe for durable storage. `repositoryIdentity` is a non-secret logical identifier, never a credential-bearing URL.

## Prohibited durable data

The Job `input`, `state`, `summary`, `result`, `errorDetails`, and `JobEvent` data must not contain plaintext or encrypted source/refresh tokens, private or credential-bearing repository URLs, provider response bodies, account diagnostics, source encryption keys, server configuration, or binary data.

## Queue and worker rule

BullMQ payload remains exactly:

```json
{ "jobId": "job-id" }
```

On receipt, the worker reads the authoritative Job and SourceConnection from PostgreSQL, claims the Job through the existing lock protocol, revalidates the source-access policy, and decrypts only in server memory immediately before an authorized provider call.

Duplicate delivery is idempotent on the same durable Job. An authorized retry leaves its terminal predecessor unchanged and creates or reuses one successor Job linked through `retryOfJobId`; retries cannot duplicate source artifacts or credentials.
