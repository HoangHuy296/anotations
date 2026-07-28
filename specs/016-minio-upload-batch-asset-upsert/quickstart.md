# Phase 016 Validation Guide

## Prerequisites

- Phase 015 repository-import request is complete.
- Compose PostgreSQL, passworded Redis, MinIO, controlled GitHub fixture, and
  Gitea fixture are running.
- Worker uses a dedicated test Redis DB/prefix; consumers are controlled for
  duplicate-delivery tests.
- Server-only provider, storage, and encryption environment variables are set;
  do not print their values.

## Required validation scenarios

1. Create a valid repository import through normal cookie authentication and
   wait for the private worker. Confirm Job claim, batch progress, completion,
   Asset rows, modality children, and private MinIO objects.
2. Use image, video, text, and audio candidates. Confirm exactly one matching
   child row per Asset and no wrong child rows.
3. Redeliver/retry after a completed batch. Confirm identical fingerprints,
   Asset IDs, and object keys are reused without duplicate events or objects.
4. Inject unsupported file, failed download, MinIO publication failure, Prisma
   publication failure, cancellation, and invalid SourceConnection cases.
   Confirm safe terminal state/counters and scoped cleanup.
5. Read Job status as owner and foreign user. Confirm only the existing safe
   status projection is visible and no credential/provider/object details leak.

## Required command groups

Run the worker unit/repository tests, controlled Compose worker integration,
web safe-status/asset-access tests, then `prisma validate`, typecheck, lint,
production builds, and `git diff --check`. Record exact non-secret commands,
test totals, isolated Redis namespace, MinIO test prefix, and restoration of
normal Compose runtime in the final validation record.
# Phase 016 MVP runtime notes

## Server-only repository import policy

The private worker reads the following deployment configuration. Browser and
durable Job input cannot override any value.

| Variable | Default | Validation |
| --- | ---: | --- |
| `REPOSITORY_IMPORT_BATCH_SIZE` | `100` | integer `50..200` |
| `REPOSITORY_IMPORT_MAX_FILE_BYTES` | `104857600` | positive integer, at most 100 MiB |
| `REPOSITORY_IMPORT_MAX_TOTAL_BYTES` | `5368709120` | positive integer, at most 5 GiB |
| `REPOSITORY_IMPORT_MAX_FILES` | `10000` | integer `1..10000` |

Supported MVP extensions are JPEG, PNG, WebP, MP4, WebM, TXT, JSON, CSV, MP3,
Ogg, and WAV. Unsupported paths are ignored before download. Paths are
normalized and traversal is rejected. No credential, provider URL, or policy
override is carried in a BullMQ message.

## Executed vertical-slice evidence (2026-07-28)

Controlled local Compose services were already healthy: PostgreSQL, passworded
Redis, MinIO, Gitea, web, and worker. The worker test ran from the host only
against those controlled services, with the public local Gitea fixture and no
PAT.

```bash
REPOSITORY_IMPORT_RUNTIME_TESTS=1 \
SOURCE_CONNECTION_TEST_MODE=1 \
SOURCE_ALLOWED_IP_CIDRS=127.0.0.1/32 \
GITEA_INTERNAL_URL=http://127.0.0.1:3100 \
pnpm --filter @fieldframe/worker test:repository-import
```

Result: 7 passed, 0 failed. The runtime test proved a `{ jobId }` delivery was
claimed from PostgreSQL, mirrored one fixture image to a scoped private MinIO
key, created exactly one canonical IMAGE Asset and ImageAsset row, wrote only
safe aggregate Job events/summary, and completed the durable Job. Two later
deliveries of the terminal Job were skipped and did not add an Asset or second
completion event. The test cleaned its Dataset/Job/Asset fixture and scoped
MinIO object. No credentials, PAT, URLs with credentials, or presigned query
strings were printed.

This is not final Phase 016 evidence: active concurrent redelivery remains
out of scope in T026+; all T001–T025 evidence is recorded below.

## Follow-up controlled evidence (2026-07-28)

The explicit local private-source suite loaded its PAT only from the local
test environment and created a temporary AES-GCM encrypted SourceConnection.
It proved worker revalidation of an owned ACTIVE connection before Gitea
access. The PAT was not printed or persisted into Job input, events, queue
data, Dataset metadata, or test output.

The same suite also processed the five-image controlled repository fixture:
five MinIO objects, five IMAGE Assets with matching ImageAsset rows, durable
`totalItems/processedItems/successItems = 5`, zero failed/skipped, one
aggregate `IMPORT_BATCH_COMPLETED` event, and a safe completed summary.

```bash
cd apps/worker && \
REPOSITORY_IMPORT_RUNTIME_TESTS=1 \
SOURCE_CONNECTION_TEST_MODE=1 \
SOURCE_ALLOWED_IP_CIDRS=127.0.0.1/32 \
GITEA_INTERNAL_URL=http://127.0.0.1:3100 \
node --env-file-if-exists=../../.env \
  --env-file-if-exists=../../.env.PAT.local \
  --import tsx --test --test-concurrency=1 \
  tests/repository-import/worker-minio-runtime.test.ts
```

Result: 3 passed, 0 failed. Prisma child-row reconciliation for IMAGE, VIDEO,
TEXT, and AUDIO separately passed (one matching child and no incompatible
children; repeated upsert reused the same Asset).

The broader controlled queue regression used Redis DB `15` and prefix
`fieldframe-phase016-test`:

```bash
QUEUE_INTEGRATION_TESTS=1 REDIS_HOST=127.0.0.1 \
REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase016-test \
REDIS_TEST_PREFIX=fieldframe-phase016-test \
pnpm --filter @fieldframe/worker test:queue
```

Result: 19 passed, 0 failed, 4 skipped (unrelated opt-in export integration
tests). Normal Redis namespaces were not used. Docker Compose's default Bake
builder panicked while rebuilding worker; the non-Bake fallback successfully
built the worker image. The worker was recreated, then a normal-namespace
BullMQ message containing exactly `{ jobId }` was consumed and completed by
that Compose worker. The normal worker environment was restored afterwards.

Additional evidence: a controlled 51-file Gitea-compatible fixture using
batch size `50` created 51 Assets/private MinIO objects and exactly two safe
aggregate batch events (`50`, then `51` imported). Compensation removed only
an unreferenced object within its exact import prefix, preserving referenced
and out-of-scope objects. An expired SourceConnection was refused before
provider work with only `SOURCE_TOKEN_EXPIRED` and token-free events. The web
HTTP test used normal opaque-cookie login: the owner listed/viewed a mirrored
Asset, while a foreign user received concealed `404`; storage key/bucket were
not exposed.

Worker-container command and result:

```bash
cd apps/worker && WORKER_CONTAINER_INTEGRATION_TESTS=1 \
node --env-file-if-exists=../../.env --import tsx --test \
  --test-concurrency=1 tests/repository-import/worker-container-runtime.test.ts
```

Result: 1 passed, 0 failed. The test created and cleaned its durable Job,
Dataset, Asset, and scoped MinIO object without printing credentials or queue
fields beyond `jobId`.

## T026–T034 controlled retry and lifecycle evidence (2026-07-28)

The following server-side controlled tests used PostgreSQL, passworded Redis,
and private MinIO. Failure points are enabled only by
`REPOSITORY_IMPORT_RUNTIME_TESTS=1` plus
`REPOSITORY_IMPORT_FAILURE_INJECTION=1`; neither queue payload nor browser
input can select them.

```bash
NODE_ENV=test REPOSITORY_IMPORT_RUNTIME_TESTS=1 \
REPOSITORY_IMPORT_FAILURE_INJECTION=1 \
SOURCE_CONNECTION_TEST_MODE=1 SOURCE_ALLOWED_IP_CIDRS=127.0.0.1/32 \
node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 \
  tests/repository-import/retry-reconciliation.test.ts
```

Result: 4 passed, 0 failed. It proved post-persist retry reuses one Asset ID,
one ImageAsset, one deterministic object key, and zero AssetVersions; an old
lock token cannot update progress after a reclaim; failures before upload and
after upload-before-persist leave no Asset or object; an ambiguous delivery
after completion leaves one terminal completion event. Cancellation after
upload removes only the unreferenced scoped object; cancellation after a
committed batch preserves canonical data and never completes the Job.

```bash
NODE_ENV=test REPOSITORY_IMPORT_RUNTIME_TESTS=1 \
REPOSITORY_IMPORT_FAILURE_INJECTION=1 REPOSITORY_IMPORT_BATCH_SIZE=50 \
SOURCE_CONNECTION_TEST_MODE=1 SOURCE_ALLOWED_IP_CIDRS=127.0.0.1/32 \
node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 \
  tests/repository-import/import-processor.test.ts
```

Result: 2 passed, 0 failed. The 51-file fixture wrote two safe aggregate
events (50 then 51). Cancellation after the first batch left exactly 50
canonical Assets, counters `processedItems=50` and `successItems=50`, one
batch event, no completion event, and terminal `CANCELED`.

The real two-worker Compose delivery used Redis DB `15` and prefix
`fieldframe-phase016-test`; the normal `annotation-platform` namespace was
not used. The workers were rebuilt, recreated at scale two, then restored to
one normal Compose worker afterwards.

```bash
TWO_WORKER_COMPOSE_INTEGRATION_TESTS=1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase016-test \
REDIS_TEST_PREFIX=fieldframe-phase016-test \
node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 \
  tests/repository-import/two-worker-compose.test.ts
```

Result: 1 passed, 0 failed. Two actual workers received duplicate deliveries
whose data was exactly `{ jobId }`; PostgreSQL recorded one claim and one
completion, with one private MinIO object, one IMAGE Asset/ImageAsset, and no
AssetVersion. The controlled provider received exactly its expected tree and
raw-file requests, so the losing worker made no provider, MinIO, Asset,
progress, or terminal-event side effect.

The broad queue baseline was also rerun under the isolated Redis namespace:
`pnpm --filter @fieldframe/worker test:queue` with the variables above.
Result: 20 passed, 0 failed, 4 explicitly skipped opt-in export tests.
It includes runtime-owned Redis reaching `end` after `runtime.close()`, and a
caller-owned Redis connection remaining open until its caller calls `quit()`.
No credentials, private source URLs, storage keys, or presigned URLs were
printed by these tests.

## T035/T036/T038 partial final-validation evidence (2026-07-28)

The mixed-outcome worker fixture ran against local Compose PostgreSQL and
private MinIO with server-only loopback fixture access. It used batch size 50,
so the 52-item tree crossed two batches: 50 valid images, one controlled
download failure, and one unsupported file. The terminal durable Job was
`COMPLETED` with `totalItems=52`, `processedItems=52`, `successItems=50`,
`failedItems=1`, and `skippedItems=1`. Thus
`processedItems = successItems + failedItems + skippedItems`. It produced two
`IMPORT_BATCH_COMPLETED` aggregate events and exactly 50 private objects,
IMAGE Assets, and ImageAsset rows; failed/skipped entries created none.

```bash
NODE_ENV=test REPOSITORY_IMPORT_RUNTIME_TESTS=1 \
REPOSITORY_IMPORT_FAILURE_INJECTION=1 REPOSITORY_IMPORT_BATCH_SIZE=50 \
SOURCE_CONNECTION_TEST_MODE=1 SOURCE_ALLOWED_IP_CIDRS=127.0.0.1/32 \
GITEA_INTERNAL_URL=http://127.0.0.1:3100 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase016-test REDIS_TEST_PREFIX=fieldframe-phase016-test \
node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 \
  tests/repository-import/**/*.test.ts
```

Result: 23 passed, 0 failed, 3 explicitly skipped opt-in container/PAT suites.
The isolated broad queue baseline was then rerun: 20 passed, 0 failed, 4
explicitly skipped export opt-in tests. The local-folder regression ran with
the same isolated Redis namespace: 18 passed, 0 failed.

The authenticated HTTP and rendered progress-page matrix used normal opaque
cookie login with PostgreSQL/MinIO and verified `QUEUED`, `RUNNING`,
`RETRYING`, `CANCELING`, `CANCELED`, `FAILED`, and `COMPLETED`. Owner/member
access succeeded; foreign, unknown, malformed, and dataset-path mismatch
requests were concealed. Status/event JSON and rendered progress HTML did not
contain fixture secret sentinels, storage keys, or queue internals.

```bash
REPOSITORY_ASSET_HTTP_TESTS=1 \
node --env-file-if-exists=../../.env \
  --require ./tests/auth-ownership/register-server-only.cjs \
  --import tsx --test --test-concurrency=1 \
  tests/repository-import-worker/safe-status-and-asset-access.test.ts
```

Result: 3 passed, 0 failed. Public stages are `WAITING`,
`VALIDATING_INPUT`, `SCANNING`, `FILTERING`, `UPLOADING_OBJECTS`,
`WRITING_ASSETS`, `FINALIZING`, and `FINISHED`; raw internal stages never
leave the PostgreSQL-backed safe projection.

### T037 controlled browser acceptance and transport evidence (2026-07-28)

The browser request uses canonical repository identity
`https://github.com/fixture/public-images`; the private Compose web process
uses its server-only `GITHUB_API_BASE_URL=http://github-fixture:8080`. The
fixture hostname is therefore never sent by the browser and is allowed only by
the controlled server test mode (`REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1`,
`SOURCE_CONNECTION_TEST_MODE=1`, and the exact trusted-host policy).

The controlled web service ran with Redis DB `15` and
`fieldframe-phase016-test`; the normal `annotation-platform` namespace was not
used. Normal opaque-cookie signup/login then called
`POST /api/datasets/from-repository` and received `202`. The fixture counter
proved server-side provider access. PostgreSQL contained exactly one Dataset
and one `IMPORT_DATASET` Job; the initial queue delivery's custom job ID was
the PostgreSQL Job ID, and both assertions passed:

```ts
expect(queueJob.data).toStrictEqual({ jobId: postgresJob.id });
expect(Object.keys(queueJob.data)).toStrictEqual(["jobId"]);
```

The same controlled suite proved same-key replay returns the original durable
acceptance without a second Dataset, Job, or delivery; concurrent duplicate
submission also converges to one durable acceptance. The explicit queue-outage
test then left a post-commit `QUEUED` Job with no delivery and had the recovery
scanner enqueue that same ID once with exactly `{ jobId }`. Queue payload and
safe HTTP response checks found no Dataset/source connection/repository/ref/
manifest/credential/ciphertext/MinIO/raw-Job/error/binary field.

Commands (all secret values remained in the local environment and were not
printed):

```bash
# Controlled web: Compose preflight override, Redis DB 15,
# BULLMQ_PREFIX=fieldframe-phase016-test, and no consumer on that namespace.
docker compose -f docker-compose.yaml -f docker-compose.preflight.yaml up -d --force-recreate web

cd apps/web
REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1 \
REPOSITORY_IMPORT_RUNTIME_TESTS=1 \
QUEUE_INTEGRATION_TESTS=1 \
REPOSITORY_PREFLIGHT_HTTP_BASE_URL=http://127.0.0.1:3000 \
GITHUB_API_BASE_URL=http://github-fixture:8080 \
GITHUB_FIXTURE_CONTROL_BASE_URL=http://127.0.0.1:18080 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase016-test \
REDIS_TEST_PREFIX=fieldframe-phase016-test \
REPOSITORY_IMPORT_TEST_CONSUMERS_STOPPED=1 \
pnpm test:repository-import-request
```

Result: 16 passed, 0 failed, 4 intentionally skipped opt-in cases (private
Gitea PAT and dedicated outage configuration). The dedicated outage/recovery
case was then enabled and passed: 1 passed, 0 failed. T037 is complete. T041–
T045 remain open and have not been treated as complete.

## Safe PostgreSQL Job projection evidence (2026-07-28)

An authenticated normal opaque-cookie HTTP test ran against the production web
build plus local Compose PostgreSQL/MinIO. Owner and authorized dataset member
both received the safe Job status projection; foreign, unknown, and malformed
Job IDs were concealed with `404`.

```bash
cd apps/web && REPOSITORY_ASSET_HTTP_TESTS=1 \
node --env-file-if-exists=../../.env \
  --require ./tests/auth-ownership/register-server-only.cjs \
  --import tsx --test --test-concurrency=1 \
  tests/repository-import-worker/safe-status-and-asset-access.test.ts
```

Result: 2 passed, 0 failed. `GET /api/jobs/[jobId]` returned only the safe
identifier, dataset/type/status/stage, PostgreSQL counters, allowlisted safe
summary, safe error code/message, and timestamps. `GET /events` returned safe
event vocabulary only, including `IMPORT_BATCH_COMPLETED`; raw Job input,
state, error details, storage identity, token sentinel, and event metadata
were not returned. The same test reconfirmed authorized Asset metadata/view
capability and foreign concealment.

## T041–T045 final controlled validation and closure evidence (2026-07-28)

The final run used PostgreSQL, password-protected Redis, private MinIO,
controlled provider fixtures, Compose web, and actual worker containers.
Test isolation used Redis DB `15` and the
`fieldframe-phase016-test` prefix. The MinIO tests used their scoped Phase 016
prefixes. Credentials, connection strings, tokens, ciphertext, and presigned
query strings were not printed.

### Fresh completion records

```bash
# Independent production build; run in a detached local session so the command
# can write its actual exit code after Turbopack completes.
pnpm build
```

Result: exit code `0` (approximately 60 seconds observed). Turbopack compiled,
finished TypeScript, collected page data, generated all 24 static pages, and
the worker TypeScript build completed.

```bash
LOCAL_IMPORT_INTEGRATION_TESTS=1 QUEUE_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase016-test \
REDIS_TEST_PREFIX=fieldframe-phase016-test \
pnpm --filter @fieldframe/web test:local-folder-import
```

Result: 18 passed, 0 failed, 0 skipped; duration 18.274 seconds. This was a
clean standalone rerun after the production build and includes authenticated
HTTP capability/completion, modality child-row, idempotency, authorization,
redaction, and local-folder routing checks.

```bash
# Recreate only the private test workers in the isolated namespace.
REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1 SOURCE_CONNECTION_TEST_MODE=1 \
GITHUB_API_BASE_URL=http://github-fixture:8080 \
BULLMQ_PREFIX=fieldframe-phase016-test REDIS_DB=15 \
docker compose -f docker-compose.yaml up -d --scale worker=2 --force-recreate worker

cd apps/worker && TWO_WORKER_COMPOSE_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase016-test \
REDIS_TEST_PREFIX=fieldframe-phase016-test \
node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 \
tests/repository-import/two-worker-compose.test.ts
```

Result: 1 passed, 0 failed, 0 skipped; duration 1.524 seconds. Two actual
worker containers received duplicate delivery for the same PostgreSQL Job.
Exactly one claim completed; the durable queue message contained only
`{ jobId }`.

### Validation and audit

```bash
pnpm exec prisma validate
pnpm exec prisma generate
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Result: all commands passed. `prisma validate` confirmed the current schema;
`prisma generate` completed successfully. Phase 016 introduced no migration
and no dependency. Existing working-tree migration/schema changes belong to
the prior approved repository-request work and are not attributed to Phase
016.

The wider controlled evidence remains green: repository-worker suite 23
passed / 0 failed / 3 intentional opt-in skips; retry reconciliation 4 / 0;
51-file cancellation 2 / 0; broad queue baseline 20 / 0 / 4 intentional
export opt-in skips; authenticated safe Job/status UI suite 3 / 0. The safe
projection, event mapping, queue-redaction, and browser acceptance evidence
above establishes that no credential, provider raw error, storage key/bucket,
presigned URL, raw Job input, queue metadata, stack trace, or infrastructure
configuration is exposed. Structured-log audit is N/A because no safe
test-accessible structured logger exists; HTTP, database event, queue, and UI
redaction are the enforced evidence.

Architecture/scope audit confirmed: PostgreSQL remains the Job authority;
BullMQ transports exactly `{ jobId }`; no worker HTTP listener exists; binary
is private in MinIO; SourceConnection decryption occurs only in worker memory;
repository and PreparedImport/local-folder processors remain isolated;
preflight stays read-only; and no scheduler, sync, delete propagation, browser
provider access, browser PAT storage, JWT/auth bypass, or Phase-016 migration
was introduced. The public repository Dataset/Job write boundary remains
`POST /api/datasets/from-repository`.

After the two-worker test, Compose was restored to one worker with the normal
`annotation-platform` queue namespace and test flags disabled. Web health and
MinIO liveness both passed; PostgreSQL, Redis, web, worker, and MinIO were up.

Known limitation: this MVP mirrors repository import files but intentionally
does not add repository scheduling, synchronization, delete propagation, or
browser-side provider access. Explicit opt-in export/PAT tests remain skipped
outside their dedicated runtime configuration.

## Post-closure Compose topology and retry regression (2026-07-28)

A user-created repository Job reached `FAILED / SOURCE_LIST_FAILED` before
processing because its active SourceConnection stored the browser-facing local
Gitea root. Inside Compose, a worker's `localhost` is its own container, not
the Gitea service. The worker now performs an exact server-controlled mapping
only when the stored URL equals the configured public Gitea root; it then uses
the configured internal Compose endpoint. Arbitrary browser/job internal URLs
remain forbidden.

`IMPORT_DATASET` retry now creates one successor Job from an allowlisted safe
repository-input projection and preserves the durable SourceConnection ID only
after an ACTIVE/owned/unenexpired transaction recheck. The failed predecessor
is immutable. No raw Job input, token, URL, ciphertext, lock data, or queue
state crosses the retry boundary; delivery remains exactly `{ jobId }`.

```bash
cd apps/worker
# The local PAT fixture is sourced without printing it.
WORKER_CONTAINER_INTEGRATION_TESTS=1 \
node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 \
tests/repository-import/worker-container-runtime.test.ts
```

Result: 2 passed, 0 failed. The second test persisted an encrypted ACTIVE
SourceConnection using the browser-facing local Gitea URL, delivered one
strict `{ jobId }` message to the actual Compose worker, and verified one
private MinIO object plus one Asset/ImageAsset and a `COMPLETED` Job. The PAT
was never printed or persisted into Job input, events, queue transport, or
response data. The same live test now uses the legacy `{ itemCount: 0,
declaredBytes: 0 }` durable input and confirms the worker applies its finite
server policy, discovers the real aggregate counters, and completes. Focused
retry tests: 5 passed, 0 failed; worker source-access tests: 4 passed, 0
failed; broad queue baseline: 20 passed, 0 failed, 4 intentional export
opt-in skips.
