# Quickstart: Repository Import Request + Queue Enqueue

## Prerequisites

- The Phase-014 provider-preflight and Phase-013 SourceConnection security
  controls are available.
- Docker Compose PostgreSQL, passworded Redis, MinIO, web, and worker are
  running under controlled local configuration.
- Use a normal `/api/auth/login` opaque-cookie session. Do not use
  `DEV_AUTH_EMAIL`, JWT, browser token storage, or a provider credential in
  browser state.
- Before implementation validation, obtain explicit approval for the narrow
  durable idempotency schema migration described in
  [data-model.md](./data-model.md). Do not apply a migration merely by running
  this guide.

## Planned validation commands

Run commands only after the implementation tasks exist and configuration is
available. Never print `.env` values, provider credentials, storage
credentials, database URL, or Redis password.

```bash
pnpm exec prisma validate
pnpm exec prisma generate
pnpm --filter @fieldframe/web typecheck
pnpm --filter @fieldframe/web lint
pnpm --filter @fieldframe/web test:repository-import-request
pnpm --filter @fieldframe/worker test:queue
pnpm --filter @fieldframe/web build
git diff --check
```

The exact repository-import test script must be added by the later task phase;
do not substitute an unrelated mocked suite.

## Controlled runtime scenario

Use an isolated test Redis database/prefix and a dedicated MinIO test prefix.
The normal production/local queue namespace remains untouched.

1. Create or sign in as a permitted actor through normal HTTP auth.
2. Request a Phase-014 public repository preflight. Confirm it returns a safe
   preview and snapshot Dataset/Job/JobEvent IDs, Redis test keys, and MinIO
   test prefix before/after: all remain unchanged.
3. Submit one valid repository request to `POST
   /api/datasets/from-repository` with an idempotency key. Confirm exactly one
   Dataset and one `IMPORT_DATASET` `QUEUED` Job are created.
4. Inspect the isolated queue delivery through test helpers: payload is exactly
   `{ jobId }`; it contains no repository credential, URL with userinfo,
   storage data, or raw Job input.
5. Open returned `/datasets/{datasetId}/imports/{jobId}` as the actor. Confirm
   the safe PostgreSQL status projection renders; no queue state is read.
6. Repeat the identical request/key. Confirm the original Dataset/Job is
   returned and there is no second queue delivery.
7. Submit unsafe URL, invalid/expired/foreign SourceConnection, missing ref,
   and missing root cases. Compare snapshots before/after: no Dataset, Job,
   JobEvent, Redis delivery, or MinIO object changes. Audit responses for
   credentials/configuration/raw provider/stack leakage.
8. Simulate enqueue unavailability after a valid durable commit. Confirm the
   one Job remains `QUEUED` and eligible for existing recovery; do not delete
   or recreate the Dataset/Job.

## Expected evidence record

The eventual task validation record must state, without secret values:

- command and duration;
- Compose services and normal opaque-cookie auth mode;
- isolated Redis DB/prefix and MinIO prefix names;
- test totals/pass/fail/skip;
- public/private/invalid/idempotent/enqueue-failure scenario result;
- exact queue payload assertion result;
- no-side-effect and redaction result;
- whether migration approval and application occurred;
- known limitations: no clone, full manifest, binary transfer, Asset creation,
  or worker import processing in Phase 015.
