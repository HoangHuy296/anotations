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
  credentialMode: "PUBLIC" | "EXISTING_SOURCE_CONNECTION" | "ONE_TIME_PAT";
  repository: {
    owner: string;
    name: string;
    ref: string;
    rootPath?: string;
    expectedVisibility: "PUBLIC" | "PRIVATE";
  };
  sourceConnectionId?: string;
  serverUrl?: string;
  personalAccessToken?: string;
  saveAsSourceConnection?: boolean;
  connectionName?: string;
  datasetName: string;
  idempotencyKey: string;
};
```

The final Zod schema is strict. It rejects unknown fields and browser
ownership, queue fields, Job fields, storage fields, policy overrides, full
manifests, and provider diagnostics. `personalAccessToken` is a narrowly
approved transient input only for Gitea `ONE_TIME_PAT`; it never enters the
creation hash, Dataset metadata, Job input, queue, response, or logs.

## Validation and authorization

1. Resolve normal opaque-cookie actor; otherwise return `401 AUTH_REQUIRED`.
2. Strictly parse request; malformed/forbidden fields return safe `400
   INVALID_REQUEST` without provider access or durable side effects.
3. Enforce dataset-create permission from system role/server policy.
4. Enforce credential mode:
   - `PUBLIC`: no SourceConnection or PAT;
   - `EXISTING_SOURCE_CONNECTION`: require an active actor-owned eligible
     connection and reject a PAT;
   - `ONE_TIME_PAT`: require Gitea server URL, PAT, connection name, and
     `saveAsSourceConnection=true`; otherwise return `422
     ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT`.
   - foreign/unknown/malformed connection: concealed safe outcome.
5. Re-run Phase-014 read-only provider/ref/root/visibility/limit preflight.
6. Enter the controlled acceptance transaction only after all above steps pass.

## Successful response

`201 Created` on first acceptance, `200 OK` for the same already accepted
actor/idempotency key, or `202 Accepted` when the durable commit succeeded but
the queue transport is temporarily unavailable:

```ts
{
  data: {
    dataset: { id: string; name: string },
    job: {
      id: string;
      datasetId: string;
      type: "IMPORT_DATASET";
      status: "QUEUED";
    },
    progressPath: string;
  }
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

SourceConnection failures follow one stable policy:

- a foreign, unknown, or malformed connection identifier is concealed as
  `404 SOURCE_CONNECTION_NOT_FOUND`;
- an owned connection that is expired, revoked, in the existing `ERROR` state,
  lacks a credential, or has an invalid credential is `422
  SOURCE_TOKEN_INVALID`.

No SourceConnection failure enters the durable transaction. This distinction
does not expose token material, ciphertext, provider diagnostics, queue data,
or a storage reference.

Every failed request must leave Dataset IDs, Job IDs, JobEvent IDs, isolated
Redis delivery namespace, and tested MinIO prefix unchanged.

## Durable behavior

Within one transaction, acceptance creates or resolves the idempotency outcome,
creates an encrypted owned SourceConnection only for approved one-time PAT,
then creates one Dataset and one `IMPORT_DATASET` `QUEUED` Job with safe input.
The transaction commits before enqueue. Delivery is exactly:

```json
{ "jobId": "<durable Job id>" }
```

If BullMQ is unavailable, return the same safe accepted DTO with `202`; leave
the one durable Job `QUEUED` with no queue transport stamp. Do not delete or
duplicate the Dataset/Job. The recovery scanner may later deliver that same
Job exactly once.

## Explicitly out of scope

This endpoint does not clone, list a complete manifest, persist source bytes,
write MinIO objects, create Assets, or run worker business processing.

`POST /api/source-import-preflight` remains the only read-only preview route.
`POST /api/source-import-jobs` returns `410 SOURCE_IMPORT_JOBS_DEPRECATED` and
must not become a compatibility creation path.
