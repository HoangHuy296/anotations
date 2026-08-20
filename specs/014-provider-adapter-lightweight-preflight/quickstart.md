# Phase 014 Validation Quickstart

## Prerequisites

- Controlled Compose PostgreSQL, password-protected Redis, MinIO, and web
  services are running. Redis must use an isolated test database/prefix for
  validation snapshots.
- A controlled GitHub/Gitea-compatible provider fixture is available for
  repository/ref/root, auth, DNS, and redirect cases. Do not put provider
  tokens, connection URLs, or credentials in command output.
- Test users authenticate through normal `/api/auth/login` opaque cookie
  sessions. Do not use an auth bypass or browser token storage.
- When credentialed Gitea coverage is required, an existing active owned
  SourceConnection is prepared through the approved Phase 013 lifecycle.

## Expected implementation validation commands

Run these after Phase 014 test targets have been added. Inject secrets
ephemerally with shell tracing disabled; do not print them.

```bash
pnpm exec prisma validate
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/web test:repository-preflight
pnpm --filter @annotationplatform/web build
```

No schema change is planned, so `prisma migrate` is not part of this phase.

## Phase-014 scope guard

This validation target exercises only the read-only preflight endpoint. It
must not create or mutate a Dataset, Job, JobEvent, SourceConnection,
ExternalRepository, Asset, persisted manifest, Redis/BullMQ delivery, or
MinIO object. It must not clone, download source bytes, call legacy import
routes, add a dependency, use raw SQL, change `schema.prisma`, or create a
migration. Use `pnpm --filter @annotationplatform/web test:repository-preflight` for
the targeted suite; do not substitute an import/worker test for this boundary.

## Controlled HTTP checks

1. Log in through `/api/auth/login` and retain the opaque cookie only in the
   test client.
2. Call `POST /api/source-repositories/preflight` for a controlled public
   GitHub and Gitea repository. Verify safe repository/ref/root results.
3. Repeat with an owner’s active Gitea connection and verify the response does
   not contain any connection/token material.
4. Verify unsupported provider, unsafe URL/DNS/redirect, foreign connection,
   invalid/expired credential, missing ref, and missing root each return their
   documented safe code.
5. Snapshot PostgreSQL durable entities, isolated Redis/BullMQ state, and an
   isolated MinIO prefix before and after every case. All snapshots must remain
   unchanged.
6. Verify no test result contains credential, private URL, provider body,
   storage/database/Redis configuration, or stack-trace sentinels.

## Expected outcome

Each preflight result is transient. It does not create a Dataset, Job,
JobEvent, queue delivery, object, clone, download, SourceConnection mutation,
or stored manifest. Record a redacted validation summary with date, services,
test command, pass/fail counts, snapshot result, and limitations before any
Phase 014 task is marked complete.

## Validation record — 2026-07-23

- Server-only adapter target: `pnpm --filter @annotationplatform/web
  test:repository-preflight` completed with **11 passed, 0 failed, 2 skipped**.
  The passing coverage uses only a loopback controlled provider fixture and
  validates strict request fields, GitHub/Gitea bounded metadata checks,
  exact/default refs, redirect-hop rejection, safe projection, and the
  unreachable `downloadFile` contract.
- `pnpm exec prisma validate`, `pnpm --filter @annotationplatform/web typecheck`, and
  `pnpm --filter @annotationplatform/web lint` passed. The production web build also
  passed outside the execution sandbox, which requires an internal local port
  for Turbopack.
- No credential, provider URL, session cookie, database URL, Redis password,
  storage credential, or encryption secret was printed in this record.
- The two authenticated Compose HTTP/snapshot tests remain explicitly skipped:
  this environment has not supplied `REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1`
  with a controlled Compose web URL and provider fixture. Consequently, the
  Phase-014 HTTP/no-side-effect runtime tasks remain open and this phase is not
  approved as complete.

## Controlled runtime evidence — 2026-07-24

- The opt-in `docker-compose.preflight.yaml` override ran web with `next dev`
  and server-controlled fixture settings only. Production Compose remains
  unchanged: it uses `next start` and continues to reject plaintext/private
  test endpoints.
- Services used: Compose PostgreSQL, passworded Redis, MinIO, web, and the
  private `github-fixture` service. Authentication used normal
  `/api/auth/signup` followed by `/api/auth/login`; the test client retained
  the opaque cookie only in memory. No auth bypass or `DEV_AUTH_EMAIL` was
  used.
- Exact redacted command:

  ```bash
  REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1 REDIS_HOST=127.0.0.1 \
  REDIS_DB=15 REDIS_TEST_DB=15 BULLMQ_PREFIX=fieldframe-phase014-test \
  REDIS_TEST_PREFIX=fieldframe-phase014-test \
  pnpm --filter @annotationplatform/web test:repository-preflight
  ```

- Result: **14 passed, 0 failed, 0 skipped** in 6.23 seconds. The authenticated
  public-GitHub success, unauthenticated denial, repository/ref failure, and
  before/after PostgreSQL, isolated Redis/BullMQ, and MinIO-prefix snapshots
  passed. Responses were checked for configuration, credential, and stack
  sentinels; no secret values, session cookie, database URL, or presigned URL
  query string was printed.
- This is partial HTTP evidence only. Public Gitea and owned active Gitea
  connection success, canonical-ID snapshot expansion, full failure/DNS/
  redirect matrix, and cross-provider redaction parity are still open. Thus
  T013, T014, T021, T022–T027, T032–T035, T038, and T041 remain unchecked and
  Phase 014 is not complete.

## Controlled US1 runtime evidence — 2026-07-24

- Services: Compose web with the opt-in `docker-compose.preflight.yaml`
  override, PostgreSQL, passworded Redis, MinIO, local Gitea, and the local
  GitHub-compatible fixture. The override is local/test-only and grants the
  server-controlled `github-fixture` hostname; browser input cannot add it.
- Authentication: normal `/api/auth/signup` followed by `/api/auth/login`.
  The opaque cookie lived only in the test client; neither `DEV_AUTH_EMAIL`
  nor a session bypass was used.
- Redacted command: `REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1`, loopback web,
  Redis DB `15`, prefix `fieldframe-phase014-test`, and a PAT sourced only
  from untracked local test environment, followed by
  `pnpm --filter @annotationplatform/web test:repository-preflight`.
- Result: **19 passed, 0 failed, 0 skipped** in 6.83 seconds. Authenticated
  HTTP coverage proved public GitHub, public Gitea, and an owned ACTIVE Gitea
  SourceConnection preflight. Every successful and tested rejected preflight
  compared canonical PostgreSQL Dataset/Job/JobEvent/SourceConnection/
  ExternalRepository/Asset projections plus isolated Redis/BullMQ and
  `phase014-test/` MinIO-prefix snapshots before and after the route call.
- Responses were checked for credentials, ciphertext field names, database,
  Redis and MinIO settings, authorization headers, and stack sentinels. No
  secret, cookie, PAT, database URL, provider private URL, or presigned query
  string was printed. This evidence completes T013, T014, and T021 only; the
  expanded failure, DNS/redirect, parity, and final controlled matrix remain
  open.

## Controlled US1/partial-US2 rerun — 2026-07-24

- Rebuilt only the web image with `COMPOSE_BAKE=false` (the local Compose
  Bake path panicked), ran the opt-in preflight override, then restored the
  normal Compose web service. PostgreSQL, Redis, MinIO, Gitea and worker were
  never recreated for this run.
- The controlled command again used normal opaque-cookie signup/login,
  loopback web, Redis DB `15`, prefix `fieldframe-phase014-test`, the local
  GitHub fixture, and a local PAT loaded without echoing it. Result:
  **20 passed, 0 failed, 0 skipped** in 9.42 seconds.
- The added HTTP cases prove stable `UNSUPPORTED_PROVIDER`,
  `REPOSITORY_NOT_FOUND`, `REF_NOT_FOUND`, and `ROOT_PATH_NOT_FOUND` outcomes
  with no durable, queue, or MinIO-prefix side effect and no response secret
  or stack sentinel. The route now distinguishes an explicit unsupported
  provider from an otherwise malformed request; malformed bodies still return
  `INVALID_REQUEST`.
- `pnpm --filter @annotationplatform/web typecheck`, `pnpm --filter @annotationplatform/web
  lint`, and `git diff --check` passed. This is still partial US2 evidence:
  T022 stays open until access-denial and forbidden-body HTTP cases are added;
  DNS, redirect, concealment, expired-token, parity, and full-matrix tasks are
  also intentionally open.

## T046/T047 source-import boundary evidence — 2026-07-24

- Controlled normal-cookie test: **1 passed, 0 failed, 0 skipped** in 4.07
  seconds against Compose PostgreSQL, isolated passworded Redis DB `15`,
  MinIO, Gitea and web. The local PAT was loaded only in process memory and
  never printed.
- `POST /api/source-import-preflight` remained read-only for PUBLIC,
  EXISTING_SOURCE_CONNECTION and ONE_TIME_PAT modes. `POST
  /api/source-import-jobs` re-preflighted then created a Dataset and QUEUED
  Job; saved ONE_TIME_PAT created exactly one owned ACTIVE encrypted
  SourceConnection. PUBLIC created neither a SourceConnection nor credential
  reference; EXISTING_SOURCE_CONNECTION reused the owned connection.
- Every queue delivery was asserted as exactly `{ jobId }`. Job input, API
  responses and JobEvents contained no PAT or encrypted credential. The
  unsaved one-time-PAT route remains tested as
  `422 ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT` with PostgreSQL, isolated
  Redis and MinIO snapshots unchanged. This completes T046 and T047.

## Scope audit — 2026-07-23

The Phase-014 implementation introduces only the server-only provider
boundary, strict validation, one safe preflight route, targeted tests, and
documentation. The audit found no Phase-014 changes to Prisma schema or
migrations, dependencies/lockfile, raw SQL, legacy Gitea import routes, Job
creation/enqueue code, Redis/BullMQ transport, MinIO writes, repository clone
operations, file download operations, or persisted manifests. `downloadFile`
is contract-only and its Phase-014 implementation rejects invocation.

## Amendment validation record — 2026-07-24

- Rebuilt the web image successfully, then used the opt-in
  `docker-compose.preflight.yaml` only for the controlled fixture run. Web was
  recreated again with normal `docker-compose.yaml` after the run.
- Exact redacted command:

  ```bash
  REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1 REDIS_HOST=127.0.0.1 \
  REDIS_DB=15 REDIS_TEST_DB=15 BULLMQ_PREFIX=fieldframe-phase014-test \
  REDIS_TEST_PREFIX=fieldframe-phase014-test \
  pnpm --filter @annotationplatform/web test:repository-preflight
  ```

- Result: **18 passed, 0 failed, 0 skipped**. It used normal
  `/api/auth/signup` + `/api/auth/login` opaque-cookie sessions, PostgreSQL,
  isolated Redis DB 15/prefix `fieldframe-phase014-test`, MinIO snapshot
  prefix `phase014-test/`, web, and the controlled GitHub fixture. No
  `DEV_AUTH_EMAIL`, JWT, mock provider/storage/database/queue, credential,
  cookie, database URL, Redis password, MinIO credential, or presigned query
  string was printed.
- The run proves that an unsaved one-time PAT Start Import request returns
  `422 ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT` before provider access and
  leaves PostgreSQL, Redis/BullMQ, and MinIO snapshots unchanged. It also
  proves authenticated legacy endpoint deprecation as
  `410 GITEA_IMPORT_DEPRECATED`.
- `pnpm --filter @annotationplatform/web typecheck`, targeted ESLint, the web
  production image build, and `git diff --check` passed.
- Still open: a controlled Gitea repository/token happy path proving
  full UI credential-mode matrix and all response redaction cases. Therefore
  T045 and T047 remain open and this record is not phase-completion evidence.

## Partial US2 security-matrix evidence — 2026-07-27

This is deliberately **not** the Phase-014 closure record and does not run
T041. It records only the completed T022–T027/T032 security tranche.

- Services: controlled `docker-compose.preflight.yaml` web runtime, PostgreSQL,
  passworded Redis DB `15`, MinIO, local Gitea, and the private
  `github-fixture`. Web was recreated with server-only
  `SOURCE_TEST_DNS_OVERRIDES`, then restored with normal
  `docker-compose.yaml` after the matrix.
- Authentication: every Fieldframe request used normal `/api/auth/signup` then
  `/api/auth/login` opaque-cookie sessions. No JWT, `DEV_AUTH_EMAIL`, seeded
  session, or browser auth bypass was used.
- Redacted command shape: `REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1`,
  `SOURCE_CONNECTION_TEST_MODE=1`, isolated Redis DB/prefix
  `15`/`fieldframe-phase014-test`, `PHASE014_DNS_MATRIX=1`,
  `PHASE014_TIMING_MATRIX=1`, then
  `pnpm --filter @annotationplatform/web test:repository-preflight`.
- Result: **30 passed, 0 failed, 0 skipped** in 35.26 seconds. The suite
  covered forbidden request bodies, public-with-connection and
  existing-connection-with-PAT denials, foreign/malformed/unknown connection
  concealment, a real controlled private-Gitea-without-connection concealment
  result, private GitHub denial, expired/revoked/corrupt/provider-401
  credential convergence, numeric/userinfo/query/fragment URL policy,
  loopback/private/mixed/failing DNS, blocked redirects, and bounded redirect
  loops.
- No-side-effect snapshots compared canonical Dataset, Job, JobEvent,
  SourceConnection, ExternalRepository, and Asset projections; isolated
  Redis namespace key names plus BullMQ counts; and MinIO
  `phase014-test/` object names. All tested preflight denials and successes
  left these snapshots unchanged.
- Provider-call evidence is intentionally asymmetric: the GitHub fixture uses
  fixture-only `POST /__test/reset` and `GET /__test/counter`; pre-policy
  GitHub denials observed zero calls. Real Gitea has no counter route, so
  tests take a Compose access-log timestamp and assert zero matching
  `/api/v1/` repository calls, excluding health/static/admin/setup traffic.
  No production test route was added.
- Response redaction passed for success, semantic failure, provider
  unavailable, concealed connection, and credential-invalid responses. The
  log audit is **N/A**: no safe test-accessible structured application logger
  exists; HTTP redaction is the evidence. PATs, ciphertext, session cookies,
  provider URLs, database/Redis/MinIO configuration, and stack traces were not
  printed in this record.
- Timing convergence: aggregate-only test samples used 30 requests each for
  expired, revoked, corrupt-ciphertext, and provider-401 states. **Max median
  delta observed: 4.33ms; threshold: 100ms; PASS.** No individual timings or
  credential material were recorded.
- The credential-invalid response policy is intentional: expired, revoked,
  corrupt ciphertext, and provider-side 401 all return the same `422
  SOURCE_TOKEN_INVALID` safe body. `REF_NOT_FOUND` and
  `ROOT_PATH_NOT_FOUND` remain intentionally distinct safe selector errors.

## T033–T035 prerequisite verification — 2026-07-27

This verification was completed before beginning T033–T035 and must be
reconfirmed before T041. It is not a T041 consolidated record.

- **PASS — redirect target evidence is path-scoped.** The fixture resets both
  its total and per-path counters before each redirect case. The allowed
  initial path `/repos/fixture/redirect-blocked` must be exactly `1`, while the
  untrusted Compose alias target `/__test/blocked-target` must be exactly `0`.
  This distinguishes the allowed initial redirect response from a prohibited
  redirect-target fetch; it is not an aggregate-only counter assertion.
- **PASS — Gitea access-log assertions are serial.** The Node test command
  uses `--test-concurrency=1`; the two tests that open a Gitea access-log
  window additionally declare `concurrency: false`. The access-log mechanism
  remains intentionally distinct from the GitHub fixture counter mechanism.
- **PASS — fixed aggregate timing record.** Thirty authenticated HTTP requests
  were measured for each converged state. Expired: median `26.25ms`, p95
  `35.36ms`; revoked: median `25.32ms`, p95 `35.52ms`; corrupted ciphertext:
  median `25.03ms`, p95 `31.64ms`; provider-side 401: median `29.36ms`, p95
  `36.29ms`. Max median delta observed: **4.12ms**; threshold: **100ms**;
  **PASS**. Only aggregates were recorded; individual timings were not logged.
- **PASS — `REVOKED` is pre-existing.** `git show HEAD:prisma/schema.prisma`
  contains `SourceConnectionStatus.REVOKED`, and
  `git diff -- prisma/schema.prisma` is empty for the Phase-014 working tree.
  No schema change or migration was introduced for this state.
- Verification command result: **30 passed, 0 failed, 0 skipped** in 40.89
  seconds under the controlled Compose override. Normal Compose web runtime
  was restored after the run.

## Provider parity and HTTP redaction evidence — 2026-07-27

This records T033–T035/T038 only. It is not the final Phase-014 closure and
does not mark T041 complete.

- Controlled Compose result: **32 passed, 0 failed, 0 skipped** in 43.05
  seconds. Authentication used only normal signup/login opaque cookies with
  PostgreSQL, isolated passworded Redis DB `15` / prefix
  `fieldframe-phase014-test`, MinIO `phase014-test/`, local Gitea, and the
  fixture-only GitHub service.
- Contract parity compares public GitHub, public Gitea, and owned credentialed
  Gitea result envelopes without requiring provider-specific preview content
  to match. It verifies safe provider/repository/visibility/ref/root fields,
  no credential or raw provider DTO, and normalized repository/ref/root/
  access/unavailable failures. Gitea provider 401 is intentionally normalized
  to `422 SOURCE_TOKEN_INVALID`; Phase 014 has no GitHub credential lifecycle.
- HTTP parity covers public GitHub, public Gitea, owned active Gitea,
  concealed private GitHub, and repository/ref/root failures. Every case uses
  before/after PostgreSQL canonical projections, isolated Redis key/queue
  snapshots, and MinIO prefix snapshots; no preflight creates a Dataset, Job,
  JobEvent, queue delivery, or object.
- HTTP redaction covers success, semantic failure, provider unavailable,
  foreign/unknown/malformed connections, expired/corrupt/provider-401
  credentials, and the actual deprecated `POST /api/gitea/import` route. That
  route exists, returns `410 GITEA_IMPORT_DEPRECATED`, and is the former
  persistence boundary—not an invented compatibility endpoint. Responses were
  checked for PAT/token/ciphertext field exposure, authorization/session data,
  raw provider errors, stacks, configuration, private credentials-in-URL, and
  presigned query syntax. Structured-log audit remains N/A because no safe
  test-accessible logger exists; HTTP response redaction is the enforced
  evidence.

## Final Phase-014 controlled validation and closure — 2026-07-27

- T041 controlled Compose matrix: **32 passed, 0 failed, 0 skipped** in 44.23
  seconds. Services were PostgreSQL, passworded Redis DB `15` with isolated
  `fieldframe-phase014-test` prefix, MinIO `phase014-test/`, web, local Gitea,
  and the fixture-only GitHub provider. A worker was not needed: this phase's
  preflight boundary is read-only and creates no durable Job to deliver.
- Every request authenticated with normal signup/login opaque cookies. The
  matrix re-confirmed no Dataset, Job, JobEvent, Redis/BullMQ delivery, or
  MinIO object mutation; response redaction, provider parity, per-path
  redirect-target non-contact, serial Gitea access-log evidence, and the
  converged credential-invalid response contract all passed.
- T041 timing rerun: max median delta **5.45ms**, fixed threshold **100ms**,
  **PASS**. Only aggregate timing output was retained.
- Final commands passed: `pnpm exec prisma validate`,
  `pnpm --filter @annotationplatform/web typecheck`,
  `pnpm --filter @annotationplatform/web lint`,
  `pnpm --filter @annotationplatform/web build`, and `git diff --check`.
- Scope confirmation: no schema/migration/dependency/JWT/auth-bypass change;
  no provider clone/download/persisted manifest during preflight; no provider
  credential, encrypted token, private URL, storage/database/Redis setting,
  cookie, or stack trace entered an HTTP response, Job input, queue payload,
  Dataset metadata, or this record. The only fixture endpoints are private to
  the GitHub test service. Normal Compose web runtime was restored after the
  matrix.

Phase 014 is validated and closed. The next phase may build on the provider
preflight contract, but must preserve read-only preflight and the existing
source-backed durable Job boundary.

## Real Gitea saved-one-time-PAT evidence — 2026-07-24

- Verified the local provider using only safe metadata: repository
  `annotation-admin/ImageDataset`, public visibility, default ref `main`.
  The PAT was read from `.env.PAT.local` in process memory and was never
  printed or written to `.env`.
- The browser-facing server field was `http://localhost:3100`. For this exact
  configured `GITEA_PUBLIC_URL`, the server maps to its configured
  `GITEA_INTERNAL_URL` before provider access. This permits Compose web to
  reach Gitea without allowing a browser to choose a private host. A clone URL
  such as `/annotation-admin/ImageDataset.git` is not a server URL; owner and
  repository are separate fields.
- Exact redacted test command (run from `apps/web` after sourcing the local
  PAT without echoing it):

  ```bash
  SOURCE_CONNECTION_INTEGRATION_TESTS=1 \
  SOURCE_CONNECTION_HTTP_BASE_URL=http://127.0.0.1:3000 \
  SOURCE_CONNECTION_GITEA_BASE_URL=http://localhost:3100 \
  QUEUE_INTEGRATION_TESTS=1 REDIS_HOST=127.0.0.1 \
  REDIS_DB=15 REDIS_TEST_DB=15 \
  BULLMQ_PREFIX=fieldframe-phase014-test \
  REDIS_TEST_PREFIX=fieldframe-phase014-test \
  node --env-file-if-exists=../../.env \
    --require ./tests/auth-ownership/register-server-only.cjs \
    --import tsx --test --test-concurrency=1 \
    tests/source-connections/source-import-start-runtime.test.ts
  ```

- Result: **1 passed, 0 failed, 0 skipped** in 3.57 seconds. It used normal
  signup/login opaque-cookie authentication and a MANAGER actor. Preflight
  covered PUBLIC, saved ONE_TIME_PAT, and EXISTING_SOURCE_CONNECTION modes;
  every preflight created no Dataset, SourceConnection, Job, queue delivery,
  or MinIO object. Start Import then created a Dataset named
  `IMG987-<random suffix>`, an owned ACTIVE SourceConnection whose stored
  token was encrypted and unequal to the PAT, and a `QUEUED IMPORT_DATASET`
  Job. The isolated BullMQ delivery was read back as exactly `{ jobId }`; Job
  input and JobEvents did not contain the PAT. No `phase014-test/` MinIO
  object was created.
- The test cleans up only its Dataset cascade, its created SourceConnection,
  its user, and its isolated queue delivery. It does not touch the normal
  `annotation-platform` namespace. No secret, cookie, database URL, provider
  token, or storage credential appears in test output or this record.
- A separate normal-Compose (`next start`) public-preflight test passed:
  **1 passed, 0 failed, 0 skipped** in 1.52 seconds. It proves an exact
  configured `GITEA_PUBLIC_URL` of `http://localhost:3100` maps to the
  server-owned `GITEA_INTERNAL_URL` in production mode. The same test confirms
  both PUBLIC and ONE_TIME_PAT Preview requests return the safe
  `annotation-admin/ImageDataset` projection and create no Dataset,
  SourceConnection, or Job. This exception is limited to that exact configured
  root; arbitrary HTTP destinations and every cross-host redirect remain
  subject to the normal SSRF policy.
- Host-run `pnpm run dev` uses the browser-reachable `http://localhost:3100`
  directly, while Compose web uses the exact server-controlled mapping above.
  An authenticated host-dev run against `http://127.0.0.1:3001` passed
  (**1 passed, 0 failed**): both public and one-time-PAT Preview Import
  projected `annotation-admin/ImageDataset` safely with no durable writes.
