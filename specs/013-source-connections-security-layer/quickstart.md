# Phase 013 Validation Quickstart

## Prerequisites

- A controlled local Compose runtime with PostgreSQL, passworded Redis, MinIO, web, worker, and a dedicated test Gitea source where provider validation is exercised.
- A valid user session created through the normal `/api/auth/login` opaque cookie flow. Do not use `DEV_AUTH_EMAIL`, browser token storage, or an auth bypass.
- Server/worker encryption configuration is present and valid. Do not print or commit the encryption value.
- Test-only trusted-source configuration, if needed for the controlled local Gitea hostname, is scoped to the integration environment and not enabled in production.

## Validate connection lifecycle

1. Authenticate as a test user with the normal login endpoint and retain only the opaque cookie in the HTTP test client.
2. Create a valid Gitea source connection through `POST /api/source-connections`.
3. Assert `201`, safe DTO fields from [source-connections-api.md](./contracts/source-connections-api.md), and absence of submitted token, encryption fields, private URL, and runtime configuration.
4. Use server-side Prisma assertions to verify the connection belongs to the actor, encrypted token material exists, and its stored value does not equal submitted token.
5. List connections as the owner and verify the new safe summary appears.
6. Attempt list/use/delete as a different user and verify concealed-resource denial with no connection, Job, queue, provider-call, or MinIO side effect.
7. Delete the owner connection and assert it cannot be selected later. Create a non-terminal referencing Job first to verify deletion returns `SOURCE_CONNECTION_IN_USE` and leaves state unchanged.

## Validate source safety and token states

1. Submit malformed, userinfo-bearing, query/fragment-bearing, numeric-IP, loopback, private, link-local, multicast, and DNS-rebinding test addresses. Verify each is rejected before provider contact unless a server-controlled exact IP/CIDR test exception applies; prove a browser request cannot add or widen that exception.
2. Submit invalid root paths through an authorized source operation: absolute, traversal, drive/UNC, empty-normalized, NUL/control, overlong, and over-depth values. Verify no Job or queue side effect.
3. Submit a provider-expired token through controlled provider behavior. Verify `SOURCE_TOKEN_EXPIRED`, safe response redaction, and unusable connection state.
4. Exercise the existing staged-import boundaries: preflight count/logical-path/declared aggregate checks, capability object-key/MIME/maximum-size locks, completion MinIO metadata size verification, and commit reconciliation of `COMPLETED` count/canonical aggregate data.
5. Exercise worker source resolution using a Job with only `sourceConnectionId` and allowlisted metadata. Verify worker revalidation precedes access and no token appears in Job, Redis, event, or log capture.

## Required commands after implementation

Use the repository's established targeted source-connection test command, then web/worker validation commands from `package.json`. Run controlled integration tests with secret-safe environment injection and shell tracing disabled. Expected checks:

```bash
pnpm db:validate
pnpm typecheck
pnpm lint
pnpm --filter @fieldframe/web test:auth-ownership
pnpm --filter @fieldframe/web test:source-connections
pnpm --filter @fieldframe/worker test:source-access
pnpm --filter @fieldframe/web build
pnpm --filter @fieldframe/worker build
```

Replace a test target only after it is created by the Phase 013 task plan; do not silently substitute mocked database, Redis, or provider behavior for required controlled integration evidence.

## Expected evidence record

Record the date, non-secret Compose services, commands, counts, safe-redaction confirmation, and remaining limitations. Do not include tokens, cookies, encrypted values, connection URLs, credentials, or presigned query strings.

## Runtime evidence — 2026-07-22 (partial; not completion evidence)

The controlled Compose runtime was verified with PostgreSQL, password-protected
Redis, MinIO, web, worker, and the dedicated Gitea service running. Fieldframe
web owns host port 3000; Compose Gitea remains on host port 3100. A private
worker-to-web request to the unauthenticated source-connection endpoint returned
`401`, confirming worker DNS and the public auth boundary.

Because the production web process correctly refuses the test-only trusted
private Gitea hostname, the provider-validation probe used a temporary,
Compose-internal Next development instance on port 3001. It was enabled only
with the explicit test policy settings already injected into the controlled
runtime; production web on port 3000 was not replaced or relaxed.

The redacted probe used normal `/api/auth/signup` followed by the opaque-cookie
session it issued. It then called `POST`, `GET`, and `DELETE
/api/source-connections` through HTTP from the Compose network. Only status
codes were recorded:

| Check | Result |
| --- | --- |
| Signup and opaque session | `201` |
| Valid controlled-Gitea source connection | `201` |
| Numeric loopback source URL | `400` |
| Owner list | `200` |
| Owner delete/revocation | `204` |

Shell tracing was disabled. The command output and this record contain no
cookie, token, URL, encryption value, credential, or provider diagnostic.
This is intentionally partial evidence: expired/invalid/unavailable token
states, owner/non-owner concealment, deletion conflict, full SSRF matrix,
worker revalidation, and zero-side-effect assertions remain required before
any corresponding task is checked off.

### Focused ownership fixture evidence

The controlled PostgreSQL-backed source suite was run with the repository test
command (environment values were loaded without being printed):

```bash
pnpm --filter @fieldframe/web test:source-connections
pnpm --filter @fieldframe/web typecheck
```

Result: **7 passed, 0 failed**. This includes the Prisma-backed owner,
administrator, foreign-user, revoked, expired, malformed-ID, and unknown-ID
fixture checks. The fixture generated its encryption test value only in process
memory and did not print plaintext/ciphertext. This evidence completes T013
only; it does not satisfy the outstanding authenticated HTTP matrices.

### Authenticated Compose HTTP runner evidence

The dedicated Compose-internal HTTP runner was executed against a temporary
Next development instance on port 3001. It used the normal signup/login flow
and opaque cookie session; production web on port 3000 was not modified. A
short-lived Gitea test token was supplied only through process environment with
shell tracing disabled and was not printed.

```bash
# redacted wrapper; command is run inside the controlled web container
node --require ./tests/auth-ownership/register-server-only.cjs --import tsx \
  --test --test-concurrency=1 \
  tests/source-connections/source-connections-routes.test.ts
```

Result: **1 passed, 0 failed**. The HTTP test covered owner creation, safe
collection/by-ID reads, administrator read under current policy, foreign and
malformed-ID concealed `404`, and sentinel response redaction. It completes
the reusable runner task (T004), but not the broader POST/GET matrices.

### Strict POST policy matrix evidence

After rebuilding both web and worker images, the controlled Compose HTTP suite
was run with PostgreSQL, Redis database `15` and the isolated
`fieldframe-phase013-test` prefix, MinIO, web, worker, and Gitea. The test uses
an ephemeral provider token and normal opaque-cookie authentication; neither
the token nor any infrastructure credential was printed.

Result: **2 passed, 0 failed**. The denial matrix proved the following with
PostgreSQL `SourceConnection`/`Job`/`JobEvent` snapshots, an isolated queue
snapshot, and the dedicated `phase013-test/` MinIO prefix unchanged:

| Case | Safe result |
| --- | --- |
| Invalid Gitea PAT | `422 SOURCE_TOKEN_EXPIRED` |
| Private numeric address outside allowlist | `400 SOURCE_DESTINATION_NOT_ALLOWED` |
| Exact allowed IP targeting Fieldframe, not Gitea | `422 SOURCE_TOKEN_EXPIRED` |
| CIDR-allowed IP targeting Fieldframe, not Gitea | `422 SOURCE_TOKEN_EXPIRED` |
| Allowed destination with refused TCP connection | `503 SOURCE_PROVIDER_UNAVAILABLE` |

The exact-IP and CIDR cases explicitly assert that the code is **not**
`SOURCE_DESTINATION_NOT_ALLOWED`. This is partial runtime evidence only: the
remaining lifecycle, redirect/DNS, worker-state, and full-suite tasks are open.

### DELETE lifecycle runtime evidence

The rebuilt Compose web service ran the authenticated DELETE matrix with the
normal opaque cookie flow. Result: **1 passed, 0 failed**. It proved foreign
and unknown IDs are concealed, concurrent owner deletes resolve as exactly one
`204` and one `404`, and an active `QUEUED` Job prevents deletion with
`409 SOURCE_CONNECTION_IN_USE`. The fixture cleanup deletes its Dataset before
its User so the Job foreign key is removed through the existing cascade. T030
is complete; T031 remains open for the all-non-terminal-status and concurrent
reference-creation cases.

### All non-terminal status deletion evidence

The rebuilt Compose web service ran the canonical non-terminal status matrix:
**2 passed, 0 failed**. The shared exhaustive classification covered `QUEUED`,
`RUNNING`, `RETRYING`, and `CANCELING`. For each, authenticated DELETE returned
`409 SOURCE_CONNECTION_IN_USE`; the exact source-connection ID and canonical
fields, Job ID/status/sourceConnectionId, and JobEvent count were unchanged.
The isolated Redis queue snapshot and `phase013-test/` MinIO prefix were also
unchanged. T031 remains open only for concurrent reference-creation/delete
integrity.

### T031 source Job/delete serializable race evidence — 2026-07-23

The source-backed Job creator was made the production boundary for this proof:
it re-resolves the owned, active, unrevoked, unexpired `SourceConnection` and
creates the durable `IMPORT_DATASET` Job in one serializable PostgreSQL
transaction. Queue delivery runs only after that transaction commits. The
connection-delete lifecycle uses the same serializable boundary and retries a
bounded serialization conflict. No raw SQL, schema change, migration, or
credential persistence was introduced.

The web image was rebuilt and recreated. The private worker was deliberately
stopped so it could not claim test deliveries. Redis DB `15` was cleared before
the run; all test deliveries used the isolated
`fieldframe-phase013-race` prefix. The test ran from the Compose web network
with normal `/api/auth/signup` then `/api/auth/login` opaque-cookie sessions;
no auth bypass was used.

```bash
# Redacted: the source test token is injected only for this process.
docker compose exec -T redis sh -lc 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -n 15 FLUSHDB'
docker compose exec -T \
  -e NODE_ENV=test \
  -e SOURCE_CONNECTION_INTEGRATION_TESTS=1 \
  -e SOURCE_CONNECTION_HTTP_BASE_URL=http://web:3000 \
  -e SOURCE_CONNECTION_GITEA_BASE_URL=http://gitea:3000 \
  -e SOURCE_CONNECTION_GITEA_TOKEN='<ephemeral-redacted>' \
  -e REDIS_DB=15 \
  -e BULLMQ_PREFIX=fieldframe-phase013-race \
  web sh -lc 'cd /workspace/apps/web && node --env-file-if-exists=../../.env \
    --require ./tests/auth-ownership/register-server-only.cjs --import tsx \
    --test --test-concurrency=1 tests/source-connections/source-job-race.test.ts'
```

Result: **1 passed, 0 failed, 0 skipped**.

| Ordered proof | Verified invariant |
| --- | --- |
| A — reference wins | Durable non-terminal Job committed first; authenticated DELETE returned `409`; the exact connection and reference remained active/linked. |
| B — delete wins | Authenticated DELETE returned `204`; the canonical source Job creator returned a safe denial; no Job reference was created. |
| C — simultaneous race | 25 `Promise.allSettled` iterations ended only as active connection + one Job, or revoked connection + no Job. |
| E — canonical audit | Every created Job had one distinct queue delivery ID derived from its Job ID, queue stamps were present, PostgreSQL references reconciled, MinIO's isolated `phase013-test/` prefix was unchanged, and only expected waiting deliveries appeared in Redis DB `15`. |

The final command output contained no token, cookie, credential, URL, or raw
Prisma diagnostic. This completes T031 only. Worker reload/rotation/revocation
tests, queue-payload contract tests, full redaction audit, and Phase 013 full
validation remain open.

### T023 worker PostgreSQL revalidation evidence — 2026-07-23

The private worker image was rebuilt and recreated, then its source-access
suite ran inside the controlled Compose worker container. The process used the
test-only trusted Compose hostname solely for address-policy coverage; normal
worker provider configuration and secrets were neither printed nor persisted.

```bash
# Redacted environment values are inherited by Compose; no credentials are printed.
docker compose exec -T \
  -e NODE_ENV=test \
  -e SOURCE_CONNECTION_TEST_MODE=1 \
  -e SOURCE_TRUSTED_TEST_HOSTS=gitea \
  worker sh -lc 'cd /workspace/apps/worker && pnpm test:source-access'
```

Result: **2 passed, 0 failed, 0 skipped**. The tests proved that the worker
reloads the SourceConnection from PostgreSQL before use, accepts a rotated
encrypted token only in worker memory, rejects revoked ownership, marks an
expired active connection as `EXPIRED`, rejects an unsafe root path, and
conceals a foreign owner as `SOURCE_CONNECTION_NOT_FOUND`. No provider request,
queue delivery, MinIO object, credential, or raw token was written by this
resolver suite. This completes T023; T029 remains open for the broader
controlled HTTP-plus-worker validation.

### T024 source Job payload and redirect evidence — 2026-07-23

The rebuilt Compose web container ran the source Job boundary suite with
normal signup/login cookie authentication and isolated Redis DB `15` under the
`fieldframe-phase013-contract` prefix. Result: **1 passed, 0 failed**. It
verified that the durable Job stores only the allowlisted repository identity
metadata and `sourceConnectionId`; it contains no source URL, token, encrypted
field, or server configuration. Its safe JobEvents contain no token sentinel,
and the single BullMQ delivery is exactly `{ jobId }`.

The controlled local redirect-provider fixture also ran with no external
provider contact: **3 passed, 0 failed**. Redirects to loopback/private,
outside-policy, and a redirect loop all failed closed as safe unavailable
provider errors. Neither command printed a credential, cookie, connection URL,
or provider diagnostic. This completes T024.

### T032 HTTP response-redaction evidence — 2026-07-23

The rebuilt Compose web service ran the authenticated source-connection
redaction suite using normal opaque-cookie login. Result: **1 passed, 0
failed**. It covered owner collection and by-ID reads, malformed POST, foreign
GET/DELETE concealed errors, and owner `204` DELETE. Every response was checked
against token and encrypted-token sentinels, private source hostname, database
and Redis configuration names, encryption configuration name, and stack traces.
No sensitive value was printed. This completes T032; T044 remains open for the
wider Job, JobEvent, Redis, MinIO, and structured-log audit.

### T021 ownership HTTP matrix evidence — 2026-07-23

The rebuilt Compose web service ran the authenticated by-ID ownership matrix.
Result: **1 passed, 0 failed**. A normal owner and an authenticated system
administrator received the safe `200` DTO; a foreign user, malformed ID, and
unknown ID received concealed `404`. Each response was checked for token,
encrypted-field, private-hostname, credential/configuration, and stack-trace
leakage. This completes T021 without contacting a provider.

### T014–T015 controlled Gitea HTTP evidence — 2026-07-23

`.env.PAT.local` was reduced to the test PAT only and is mode `600`. Its value
was injected into a temporary Compose-internal Next test process at port 3001;
production web remained on port 3000. The test process used normal
signup/login opaque-cookie sessions and server-controlled trusted-host/CIDR
policy values. The PAT was never printed or persisted outside encrypted
SourceConnection storage.

Results: **T014 1 passed, 0 failed**; **T015 1 passed, 0 failed**.

- T014 proved real valid Gitea POST `201`, safe owner/admin reads, concealed
  foreign/malformed/unknown reads, and redacted responses.
- T015 proved invalid PAT → `422 SOURCE_TOKEN_EXPIRED`, blocked private
  numeric address → `400 SOURCE_DESTINATION_NOT_ALLOWED`, exact-IP and CIDR
  policy exceptions reaching a non-Gitea service → `422 SOURCE_TOKEN_EXPIRED`,
  and an allowed unavailable provider → `503 SOURCE_PROVIDER_UNAVAILABLE`.
  Each denial preserved PostgreSQL business snapshots, isolated Redis, and the
  Phase 013 MinIO prefix with no secret-bearing response.

### T016 deterministic DNS HTTP and T020 consolidated provider evidence — 2026-07-23

The source policy now accepts deterministic DNS overrides only when the server
is outside production and `SOURCE_CONNECTION_TEST_MODE=1`; overrides are read
only from the server process environment and cannot be sent by the browser.
The authenticated HTTP test used private, mixed public/private, and resolver
failure fixtures. Each request supplied an intentionally invalid token but
returned `400 SOURCE_DESTINATION_NOT_ALLOWED`, not a token error, proving the
policy runs before provider/token validation. PostgreSQL business snapshots,
isolated Redis, and the Phase 013 MinIO prefix were unchanged.

The consolidated controlled provider command executed the valid PAT route,
provider denial matrix, and deterministic DNS matrix together. Result: **3
passed, 0 failed, 0 skipped**. The PAT was injected from `.env.PAT.local` only
into the temporary Compose-internal test process and was never printed. This
completes T016 and T020.

### T022 root-path and browser-policy override evidence — 2026-07-23

The rebuilt temporary Compose test web ran **2 passed, 0 failed**. An owner
request to `/api/gitea/import` with a traversal root was rejected before any
provider request; a browser attempt to supply an IP allowlist was rejected by
strict Zod validation. PostgreSQL, isolated Redis, and MinIO snapshots stayed
unchanged. Together with T016, this completes the US2 HTTP policy matrix.

### T029/T036 consolidated Compose evidence — 2026-07-23

T029 combines the controlled authenticated HTTP denial proofs from T016 with
the private-worker PostgreSQL revalidation suite from T023 and the safe queue
payload/redirect proof from T024. Every denied HTTP case retained PostgreSQL,
isolated Redis, and MinIO snapshots; worker failures contained only stable
error codes and did not emit token material.

T036 combines the authenticated owner/foreign/delete proof from T030, the
all-non-terminal and 25-iteration source Job/delete race proof from T031, and
the Compose HTTP response-redaction proof from T032. All completed against
controlled Compose services, used opaque sessions, and recorded no credential,
cookie, token, private URL, or raw Prisma diagnostic. This completes T029 and
T036; it does not substitute for the remaining US4 end-to-end validation.

### T043 isolated dedicated-worker source Job evidence — 2026-07-23

For this controlled delivery, the normal Compose worker was stopped before
submission. Redis DB `15` was flushed and the only consumer was a dedicated
`annotations-worker-phase013-e2e` container running with the isolated
`fieldframe-phase013-e2e` prefix. A second, unexposed web container used that
same namespace; the normal web container and its `annotation-platform`
namespace remained unchanged. The web and worker images were rebuilt before
the run. Normal `/api/auth/signup` and `/api/auth/login` created the opaque
cookie session used by the test; no development-auth bypass was used.

```bash
# The source test gate is ephemeral and intentionally redacted.
docker compose run -d --name annotations-worker-phase013-e2e \
  -e REDIS_DB=15 -e BULLMQ_PREFIX=fieldframe-phase013-e2e worker
docker compose run -d --name annotations-web-phase013-e2e \
  -e REDIS_DB=15 -e BULLMQ_PREFIX=fieldframe-phase013-e2e web
docker exec \
  -e NODE_ENV=test \
  -e SOURCE_CONNECTION_INTEGRATION_TESTS=1 \
  -e SOURCE_CONNECTION_HTTP_BASE_URL=http://127.0.0.1:3000 \
  -e SOURCE_CONNECTION_GITEA_BASE_URL=http://gitea:3000 \
  -e SOURCE_CONNECTION_GITEA_TOKEN='<ephemeral-redacted>' \
  annotations-web-phase013-e2e sh -lc 'cd /workspace/apps/web && node --env-file-if-exists=../../.env \
    --require ./tests/auth-ownership/register-server-only.cjs --import tsx \
    --test --test-concurrency=1 \
    tests/source-connections/source-job-worker-e2e.test.ts'
```

Result: **1 passed, 0 failed, 0 skipped**.

The authenticated test called `POST /api/source-import-jobs` using the normal
opaque cookie. Its strict request contains only Dataset ID, connection ID,
allowlisted repository identity/root path, and manifest; it cannot include a
provider URL, token, queue value, storage key, or binary. The route invoked
`createAndEnqueueSourceImportJob()` and created one private source-backed
`IMPORT_DATASET` Job in PostgreSQL, delivered exactly `{ jobId }` to the
isolated BullMQ namespace, and the dedicated worker claimed it. The worker
re-resolved PostgreSQL source state and rejected a deliberately private numeric
destination with only the safe `SOURCE_URL_UNSAFE` code. The test verified
started/dequeued timestamps, safe JobEvents, no token or source URL in durable
input/events, and no MinIO write under the Phase 013 prefix. No credential,
cookie, provider URL, or presigned URL was printed. This completes T043.

### T037–T039 source Job limit, queue contract, and worker-safe projection — 2026-07-23

The normal worker was stopped for T037/T038 so delivery remained observable.
Redis DB `15` was flushed; a separate unexposed web container used the
`fieldframe-phase013-limits` prefix and finite server-owned limits: root depth
`1`, item count `2`, aggregate declared bytes `10`, and duration `1000`
milliseconds. The browser cannot supply any of those values.

Result: **2 passed, 0 failed, 0 skipped**. The normal opaque-cookie HTTP route
rejected unauthenticated input, excessive root depth, item count, bytes, and
duration, plus a browser-supplied policy override, with no Job/queue/MinIO
effect. It accepted the exact configured boundary and persisted only normalized
allowlisted repository identity and manifest data. The separate contract test
proved the durable Job and JobEvents excluded token/URL sentinels and its sole
BullMQ delivery was exactly `{ jobId }`.

To verify that this source boundary did not regress the existing canonical
staged-import checks, the host-runner suite was executed against Compose
providers (host loopback is intentional for this browser-style MinIO test):

```bash
LOCAL_IMPORT_INTEGRATION_TESTS=1 QUEUE_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase013-regression \
REDIS_TEST_PREFIX=fieldframe-phase013-regression \
pnpm --filter @fieldframe/web test:local-folder-import
```

Result: **16 passed, 0 failed, 0 skipped**. This covers canonical
Start/preflight validation, capability/object-key/MIME/size binding, MinIO
metadata completion checks, commit reconciliation, no-side-effect denials,
cleanup/retry, and modality child-row reconciliation. Redis DB `15` was
flushed after the run; the normal `annotation-platform` namespace was not used.

The private worker suite then ran against Compose PostgreSQL with the existing
production-disabled trusted `gitea` test host enabled only for stage-specific
tests:

```bash
docker compose run --rm --no-deps \
  -e NODE_ENV=test -e SOURCE_CONNECTION_TEST_MODE=1 \
  -e SOURCE_TRUSTED_TEST_HOSTS=gitea worker sh -lc \
  'cd /workspace/apps/worker && node --import tsx --test \
    --test-concurrency=1 tests/source/source-job-safety.test.ts \
    tests/source/source-access.test.ts'
```

Result: **4 passed, 0 failed, 0 skipped**. Worker reload/rotation/revocation,
expiry/root/foreign checks, manifest-limit projection, and queue-router safe
failure projection all used PostgreSQL authority. The new router test confirms
only a safe source error code reaches the Job and JobEvent; no plaintext token,
provider URL, configuration value, or provider response is copied.

### T044–T047 final redaction, architecture, validation, and scope audit — 2026-07-23

The controlled HTTP/Job redaction audit ran in the isolated Compose web
container:

```bash
docker exec \
  -e NODE_ENV=test -e SOURCE_CONNECTION_INTEGRATION_TESTS=1 \
  -e SOURCE_CONNECTION_HTTP_BASE_URL=http://127.0.0.1:3000 \
  -e SOURCE_CONNECTION_GITEA_BASE_URL=http://gitea:3000 \
  -e SOURCE_CONNECTION_GITEA_TOKEN='<ephemeral-redacted>' \
  annotations-web-phase013-limits sh -lc 'cd /workspace/apps/web && \
    node --env-file-if-exists=../../.env \
    --require ./tests/auth-ownership/register-server-only.cjs --import tsx \
    --test --test-concurrency=1 \
    tests/source-connections/source-connection-redaction.test.ts \
    tests/source-connections/source-job-queue-contract.test.ts'
```

Result: **2 passed, 0 failed, 0 skipped**. The audit covers source-connection
HTTP success/denial responses, the source Job response/input, JobEvents, and
the one isolated BullMQ payload. Database and Redis configuration names,
encrypted/plaintext token sentinels, private source URL sentinels, and stack
traces were absent. The source flow writes no MinIO metadata or object, proven
by T037/T043 snapshots. No structured application logger exists in the
Phase 013 source route/service/worker surface, so a structured-log sink audit
is **not applicable**; the code scan found no `console.*` call there.

Architecture review against `AGENTS.md`, `docs/architecture.md`,
`docs/job-system.md`, `docs/bullmq-postgres-job-flow.md`, and all three Phase
013 contracts found the new `POST /api/source-import-jobs` boundary compliant:
Next.js authenticates/authorizes/validates, PostgreSQL is canonical, BullMQ
receives only `{ jobId }`, MinIO receives no source binary in this phase, and
the private worker reloads Job/connection state. The source API contract was
updated to describe this route and its safe response.

Final commands:

```bash
pnpm exec prisma validate
pnpm exec prisma generate
pnpm --filter @fieldframe/web typecheck
pnpm --filter @fieldframe/web lint
pnpm --filter @fieldframe/web build
pnpm --filter @fieldframe/worker typecheck
pnpm --filter @fieldframe/worker build
LOCAL_IMPORT_INTEGRATION_TESTS=1 QUEUE_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase013-regression \
REDIS_TEST_PREFIX=fieldframe-phase013-regression \
pnpm --filter @fieldframe/web test:local-folder-import
curl -fsS http://127.0.0.1:3000/api/health
docker compose exec -T postgres pg_isready -U fieldframe -d fieldframe
docker compose exec -T redis sh -lc 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli PING'
curl -fsS http://127.0.0.1:9000/minio/health/live
```

All commands passed. The Compose smoke returned web `ready`, PostgreSQL
accepting connections, Redis `PONG`, MinIO liveness success, and worker
`Fieldframe worker ready.` No schema change, migration, dependency, raw SQL,
clone/import processor, JWT/auth bypass, browser token storage, or credential
transport was added by Phase 013. Redis DB `15` and each dedicated test
container were removed after runtime tests; the default worker was restored.
