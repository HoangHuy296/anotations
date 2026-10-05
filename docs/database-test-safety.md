# Disposable migration and integration-test safety (Phase029 G1)

G1 permits local disposable tooling only. It grants no application migration,
backfill, feature deployment, service-control or recovery authorization. The
accepted recovery launcher, v1/v2 SQL and all historical migrations remain audit
artifacts and must not be repurposed as a general deployment permission.

## Supported execution

Use Node 22.23+, the installed Prisma CLI, Docker, PostgreSQL 16 `psql` and `pg_dump`. No new packages or
application environment variables are required. `DB_SAFETY_RECEIPT` is a
short-lived operator/test-runner input, never a persistent application setting.
Do not edit `.env` to run tests.

1. Provision **new** disposable PostgreSQL, Redis and MinIO containers. Use unique
   `phase029-g1-*` names, labels `annotation.safety=g1-disposable` and
   `annotation.role=postgres|redis|minio`, and explicit loopback-only bindings in
   ports 55460–55479. Use fresh credentials. PostgreSQL database name is
   `fieldframe`; identical names do not confer identity. Verify the container ID,
   port binding and control-file system identifier. The application system ID
   `7662655305624969250` is always rejected.
2. Prepare a private directory (0700), `schema.prisma`, a `migrations/` directory
   with reviewed history, and a private `prisma.config.ts` (0600/0400) with a
   literal disposable URL. No shell URL, root dotenv or implicit datasource is
   an authorization. No `directUrl`, shadow database or URL query parameters are
   supported. Migration development/reset/push/execute/studio are disabled.
3. Prepare and review a request JSON. It contains `operation` (`deploy`, `test`
   or `seed`), exact config path and `configSha256`, `schemaSha256`, and
   `migrationHashes` mapping **every absolute migration.sql path** in lexical
   order to its SHA-256. `postgres` contains `name`, `id`, `port`, `internalPort`
   and `systemIdentifier`. Review the whole pending set, not just its last file.
   A checksum proves bytes, not business authorization.
4. For tests/seeds also select an exact `command` from
   `scripts/db-safety/commands.json`. Supply `providers` (two pinned containers
   with `role`, identity and binding) and a private `providerFile` JSON containing
   isolated Redis/MinIO credentials/endpoints, `REDIS_DB="0"`, and unique
   `g1-*` `BULLMQ_PREFIX`/`MINIO_BUCKET`. Only allowlisted environment fields are
   accepted. Do not mix a disposable database with application queue/storage.
5. Issue a new receipt. The issuer resolves Prisma's effective config, checks
   positive disposable identities, reads history in read-only sessions, and
   registers the exact private receipt hash. A read-only schema-only dump pins
   current public-schema definitions/ownership/ACLs as well as full history;
   only pg_dump’s random restrict/unrestrict transport markers are excluded. It does not migrate or seed:

   ```sh
   node scripts/db-safety/approve-disposable.mjs /private/request.json /private/receipt.json
   ```

6. Execute only the receipt's selected operation:

   ```sh
   DB_SAFETY_RECEIPT=/private/receipt.json node scripts/db-safety/cli.mjs deploy
   DB_SAFETY_RECEIPT=/private/receipt.json node scripts/db-safety/cli.mjs test g1:fixture
   ```

   These are alternative commands requiring different receipts, not one receipt
   reused for both. Repository `db:migrate`, `db:seed`, and web/worker/realtime
   test scripts delegate to this launcher. The launcher supplies one verified
   URL to both a private frozen config and child-only DATABASE_URL; it ignores
   inherited shell URLs. Schema and migration bytes are copied and checked in
   the private stage. It rechecks identity, files, scope and history after
   validation and immediately before the runner. Never append arbitrary CLI
   flags or fall back to bare Prisma when a check rejects execution.
7. After a migration, capture schema, application table fingerprints and complete
   migration history; run read-only status with the same verified config/URL.
   Issue a **fresh test receipt** against the new history. Receipts expire in
   20 minutes, reject file/history/database-schema changes, and are not production permissions.
8. Teardown only newly created resources whose immutable container IDs were
   recorded. Remove their volumes, private credential stages and their exact
   receipt registry entries. Never delete by broad container/volume pattern.

The executable end-to-end example is `python3 scripts/db-safety/rehearse.py`. It
creates only new local containers, replays the 23 unchanged historical migrations,
exercises negative cases, performs a rolled-back Prisma fixture write plus
isolated Redis/MinIO operations, captures evidence and tears down its own resources
in `finally`. It does not run Phase029 feature migrations.

## Failures and disabled entry points

Any identity, receipt, scope, checksum, history or provider mismatch stops before
the mutating child starts. There is no automatic retry, reset, history repair,
application-target override, migration resolve or service restart. Retain the
safe error code and pinned PostgreSQL diagnostics; do not print configuration
objects or credentials. If a child migration itself fails, inspect that disposable
instance only; do not reinterpret the failure as permission to touch the app DB.

Root Prisma config rejects mutating Prisma commands before dotenv loading.
All application test files have a first-import guard, including direct `tsx` and
Vitest paths. A receipt for one suite cannot authorize a different direct entry.
The preload constrains JavaScript sockets to verified providers and local servers
created within that test process. A separate constructor gate handles native
Prisma and freezes its literal datasource; generated clients are not modified.
Loader threads are reverified but are not separate executable entry scopes.

Legacy backfill/live-provider/smoke/sync utilities and the pre-recovery modality
fixture are disabled until separately scoped. Historical HTTP suites that need
an external application/fixture runtime remain unavailable under G1; no running
application is silently substituted. Pure application unit suites are also
conservatively gated when co-located with integration suites. Domain/queue pure
package suites remain independent. This may be narrowed only after auditing and
separately classifying pure entry points.

`docker-compose.review.yaml` no longer invokes bare migrate/seed. Its one-offs
fail closed without a host-verified receipt; consequently a fresh review stack
cannot currently start its dependent web/worker services through these one-offs.
Do not mount Docker's socket or application credentials into a review container
to bypass the host guard. A container-native approved operator path is separate
work. `docker-compose.preflight.yaml`'s old test-enabled web runtime is disabled.
No running Compose stack was changed or restarted by G1.

## Remaining boundaries

This is repository accident prevention, not a sandbox against code holding
administrator credentials. A user can still explicitly use another Prisma config,
psql, Docker exec, a native driver, remove the guard, or invoke retained recovery
operator tools. Those actions are **not authorized** by a disposable receipt.
Separate least-privilege application credentials and network/OS isolation are
needed to prevent a malicious process or administrator from bypassing tooling.
Existing running application entry points are intentionally unchanged.

Remote targets, shadow databases, arbitrary external HTTP runtimes and native
non-Prisma database clients are not approved integration targets. Unknown
entry points fail closed or require a new reviewed scope; a skipped test is not
proof of safety or feature correctness. The guard does not resolve the existing
worktree Prisma schema versus recovered application-schema mismatch. Never
rebuild/deploy this partial worktree against the application DB as part of G1.

G2 needs a separate approval and a new additive isolated candidate migration.
Neither the erroneous Phase029 migration nor its corrective migration may be
edited, reset, reapplied as a feature, or deleted.

## G4 receipt-owned HTTP/provider/worker runtime extension

The separately authorized G4 extension is limited to `g4:runtime:safety` and
`g4:runtime:e2e` through the existing G1 launcher. It does not authorize an
ambient Next.js server, provider, worker, database, or application deployment.

`python3 scripts/db-safety/g3-rehearse.py --runtime-safety` first replays the
23 historical migrations and the unchanged candidate on new G1-pinned
PostgreSQL/Redis/MinIO. The runtime supervisor resolves the verified G1 receipt,
copies source into a private project without `.env` files, hashes the source
snapshot and worker/domain dependencies, and generates a private runtime config.
No package script that sources application `.env` is invoked.

A registered runtime receipt binds the G1 receipt, configuration checksum,
expiry, source hashes, role/entry/argument allowlist, exact HTTP/provider ports,
and supervisor PID, UID and Linux process start time. Each child must pass full
G1 identity/history/provider verification before importing application code.
It records its PID/start-time/parent identity in the private process ledger.
Child startup and loader verification require the registered supervisor as
parent; a matching hostname or an inherited environment variable is insufficient.
Unknown executable entries, roles, configuration changes, stale receipts and
alternative datasource/provider targets fail closed. Runtime listeners bind
only their receipted `127.0.0.1` ports. Socket access to another runtime port
requires its matching live process receipt. Native Prisma retains the existing
verified literal-datasource constructor gate.

`--runtime-e2e` repeats the runtime safety suite first, verifies its unchanged
database capture, then issues a fresh receipt for the HTTP/provider/worker suite.
The HTTP server uses real Next.js handlers from the private source snapshot;
the worker invokes the existing private worker entry; the provider fixture
implements the bounded Gitea transport rather than replacing import/publication
logic. Test fixtures supply explicit modality/opaque resolver attribution.

Cleanup signals only the children created by this supervisor after rechecking
PID/UID/start-time identity, waits for their exit, checks their `/proc` absence,
and removes its exact registry entry and private project/configuration. The
outer G1 harness then removes only its recorded container IDs and volumes,
configuration stage and receipt registrations. A shutdown timeout or changed
process identity fails cleanup; it does not authorize killing another process.
Safety-negative runs must preserve schema, history and all 35 table fingerprints.
Keep success/failure logs and cleanup receipts; a safety-suite pass alone is not
G4 E2E success, G4 closure, G5 approval, or migration-24 deployment permission.
