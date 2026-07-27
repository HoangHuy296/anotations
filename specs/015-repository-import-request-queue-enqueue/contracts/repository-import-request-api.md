# Repository Import Request API Contract

## Operation

`POST /api/datasets/from-repository`

This is the only Phase-015 browser-facing durable repository-import acceptance
operation. It requires a normal opaque-cookie session and a server-authorized
actor. It re-runs Phase-014 preflight before a durable transaction.

It must delegate to the approved source-backed acceptance boundary, not create
a second Dataset/Job/queue implementation.

## Request

```ts
type RepositoryImportRequest = {
  provider: "GITHUB" | "GITEA";
  repository: {
    owner: string;
    name: string;
    ref: string;
    rootPath?: string;
    expectedVisibility: "PUBLIC" | "PRIVATE";
  };
  sourceConnectionId?: string;
  datasetName: string;
  idempotencyKey: string;
};
```

The final Zod schema is strict. It rejects unknown fields and rejects browser
ownership, tokens, credential URLs, queue fields, Job fields, storage fields,
policy overrides, full manifests, and provider diagnostics.

For a provider requiring a base address, the server derives it from the
approved public-provider configuration or the owned SourceConnection; it does
not accept a credential-bearing URL from this request.

## Validation and authorization

1. Resolve normal opaque-cookie actor; otherwise return `401 AUTH_REQUIRED`.
2. Strictly parse request; malformed/forbidden fields return safe `400
   INVALID_REQUEST` without provider access or durable side effects.
3. Enforce dataset-create permission from system role/server policy.
4. Enforce source mode:
   - public repository: no `sourceConnectionId`;
   - private repository: an active actor-owned eligible connection only;
   - foreign/unknown/malformed connection: concealed safe outcome.
5. Re-run Phase-014 read-only provider/ref/root/visibility/limit preflight.
6. Enter the controlled acceptance transaction only after all above steps pass.

## Successful response

`201 Created` on first acceptance, or `200 OK` for the same already accepted
actor/idempotency key:

```ts
{
  dataset: { id: string; name: string },
  job: {
    id: string;
    datasetId: string;
    type: "IMPORT_DATASET";
    status: "QUEUED";
  },
  progressPath: string;
}
```

`progressPath` is a same-origin route of the form
`/datasets/{datasetId}/imports/{jobId}`. The response excludes SourceConnection
fields, token/ciphertext, raw Job input/state/result, queue fields, storage
data, provider URLs/raw bodies, and configuration.

## Failure projection

The operation maps approved preflight and ownership failures to their existing
safe error status/code (for example `UNSAFE_REPOSITORY_URL`,
`REPOSITORY_NOT_FOUND`, `REPOSITORY_ACCESS_DENIED`, `SOURCE_TOKEN_INVALID`,
`REF_NOT_FOUND`, and `ROOT_PATH_NOT_FOUND`). It never echoes unsafe request
values or provider diagnostics.

Every failed request must leave Dataset IDs, Job IDs, JobEvent IDs, isolated
Redis delivery namespace, and tested MinIO prefix unchanged.

## Durable behavior

Within one transaction, acceptance creates or resolves the idempotency outcome,
then creates one Dataset and one `IMPORT_DATASET` `QUEUED` Job with safe input.
The transaction commits before enqueue. Delivery is exactly:

```json
{ "jobId": "<durable Job id>" }
```

If BullMQ is unavailable, return the existing recoverable accepted Job state
without deleting it or creating a duplicate Job/Dataset. The recovery scanner
may deliver that same Job later.

## Explicitly out of scope

This endpoint does not clone, list a complete manifest, persist source bytes,
write MinIO objects, create Assets, or run worker business processing.
