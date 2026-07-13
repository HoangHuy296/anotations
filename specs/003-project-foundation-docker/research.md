# Phase 1 Research: Project Foundation

## Decision 1: Compose waits for healthy providers

**Decision**: PostgreSQL, Redis, and MinIO receive provider-appropriate
healthchecks. Web and worker depend on `service_healthy` rather than merely a
started container and also perform their own bounded readiness validation.

**Rationale**: Compose starts containers in dependency order but a running
container may not be ready to accept connections. Health-gated dependencies
avoid startup races; process-level validation produces a safe diagnostic when a
provider later becomes unavailable.

**Alternatives considered**:

- Start web/worker after a fixed delay — rejected because readiness time varies.
- Treat a running provider container as ready — rejected because it does not
  prove connection availability.

**References**: [Docker startup order](https://docs.docker.com/compose/how-tos/startup-order/), [Compose service dependencies](https://docs.docker.com/reference/compose-file/services/).

## Decision 2: Use one minimal BullMQ payload contract

**Decision**: Define the queue payload as `{ jobId }` in the shared queue
package. Configure queue prefix with `BULLMQ_PREFIX`; do not use the Redis
client `keyPrefix` option.

**Rationale**: This preserves PostgreSQL as Job authority and keeps provider
credentials/full Job input out of Redis. BullMQ owns its queue prefixing and
worker connections have different retry requirements from web producers.

**Alternatives considered**:

- Serialize Job input into the queue — rejected by Phase 0.
- Use an ioredis `keyPrefix` — rejected because BullMQ documents it as
  incompatible with its own prefixing.

**References**: [BullMQ connections](https://docs.bullmq.io/guide/connections), [BullMQ queues](https://docs.bullmq.io/guide/queues).

## Decision 3: Preserve the prepared Prisma schema and generated-client output

**Decision**: Keep `prisma/schema.prisma`, migrations, and its configured
`lib/generated/prisma` output unchanged. Run Prisma commands from the workspace
root through the existing config.

**Rationale**: Prisma generation follows the schema generator output and the
root config already owns schema/migration locations. Changing either would
enter Phase 2 scope.

**Alternatives considered**:

- Move the schema into an application package — rejected because it changes the
  approved schema ownership and migration path.
- Change the generator output — rejected because schema changes are forbidden
  in Phase 1.

**References**: [Prisma generate](https://docs.prisma.io/docs/cli/generate), [Prisma config](https://docs.prisma.io/docs/orm/reference/prisma-config-reference).

## Decision 4: Use pnpm workspace boundaries without a second public backend

**Decision**: The root workspace orchestrates `apps/web`, `apps/worker`,
`packages/domain`, and `packages/queue`; only `apps/web` exposes browser
routes. The worker starts a process and readiness probe but no HTTP server.

**Rationale**: This matches the accepted Phase 0 structure and enables shared
typed contracts without duplicating providers or server logic.

**Alternatives considered**:

- Keep web and worker scripts mixed in the root — rejected because it obscures
  public/private boundaries.
- Create a second API for the worker — rejected by Phase 0.

## Decision 5: Keep provider credentials server-only

**Decision**: Validate the named environment values in server/worker code only.
Commit an `.env.example` containing names and non-sensitive local placeholders;
do not change existing `.env` or `.env.local` files.

**Rationale**: Configuration validation gives actionable startup failures while
the separation prevents credentials entering browser bundles, source control,
or logs.

**Alternatives considered**:

- Put provider values in client runtime configuration — rejected by Phase 0.
- Hard-code local credentials — rejected because it makes secrets portable and
  unsafe.
