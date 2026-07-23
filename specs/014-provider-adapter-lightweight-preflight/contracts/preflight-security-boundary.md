# Preflight Security Boundary

## Required order of operations

1. Resolve the opaque-session actor.
2. Strictly validate the request body.
3. If a connection was supplied, resolve it server-side for the actor; foreign,
   malformed, inactive, revoked, or expired identifiers stop here under the
   concealed-resource policy.
4. Select the provider adapter and validate repository address, fresh DNS
   result, and every redirect target under the shared source policy.
5. Perform bounded repository, ref, and optional root checks.
6. Project only the safe result or safe stable failure.

No provider request may occur before the first four steps complete.

## Credentials and redaction

Only an eligible existing Gitea connection may yield a transient decrypted
credential, inside server memory. It must not appear in a request DTO,
response, queue, Job, persistence, log, exception message, or test evidence.
The same prohibition applies to encrypted fields, private repository URLs,
provider bodies, source-encryption configuration, database/storage/Redis
credentials, and stack traces.

## Prohibited Phase 014 work

- Creating/updating a SourceConnection, Dataset, ExternalRepository, Job,
  JobEvent, Asset, or manifest.
- Queueing work, cloning, downloading file bytes, or uploading to MinIO.
- Invoking legacy Gitea import/preview persistence paths.
- Following an unvalidated redirect or accepting a browser-supplied policy
  exception.

## Validation evidence

The implementation must prove, through authenticated controlled HTTP tests:

- valid public GitHub/Gitea and owned Gitea checks;
- unsafe URL, numeric/private/mixed-DNS, unsafe redirect, unsupported provider,
  foreign connection, token/ref/root failures;
- no provider call for pre-policy and foreign-connection denials;
- before/after PostgreSQL, isolated Redis/BullMQ, and MinIO-prefix snapshots
  unchanged for both success and failure; and
- HTTP response/log redaction sentinels absent from every result.
