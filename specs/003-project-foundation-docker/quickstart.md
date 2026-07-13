# Phase 1 Validation Guide

## Prerequisites

- Docker Engine with Compose v2.
- Node.js 22.13 or later and pnpm 11.10.0 available to the developer.
- An ignored local environment file containing all names in
  [provider-configuration.md](./contracts/provider-configuration.md).
- No changes to `prisma/schema.prisma` or existing migrations.

## Expected implementation outputs

- `docker-compose.yaml` with `web`, `worker`, `postgres`, `minio`, and `redis`.
- Valid pnpm workspace packages for web, worker, domain, and queue.
- Private provider configuration/readiness modules.
- Dockerfiles for web and worker plus a safe `.dockerignore`.
- `.env.example` with names/placeholders only.

## Validation sequence

1. Install workspace dependencies using the documented root command.
2. Generate the Prisma client from the prepared root schema.
3. Validate Compose configuration before starting containers.
4. Start the full Compose topology and wait for all five services to be ready.
5. Query the same-origin web readiness response and verify it returns only a
   status label.
6. Inspect worker logs for its ready message and verify it has no HTTP listener.
7. Restart the topology three times and verify web/worker reconnect each time.
8. Search normal browser output and logs for the configured secret values; none
   may appear.

## Commands to document during implementation

```bash
pnpm install --frozen-lockfile
pnpm db:generate
docker compose -f docker-compose.yaml config
docker compose -f docker-compose.yaml up --build
docker compose -f docker-compose.yaml ps
docker compose -f docker-compose.yaml down
```

## Expected outcomes

- Every Compose dependency reports healthy before web/worker are ready.
- Prisma generation succeeds without a schema or migration diff.
- Web and worker use real provider connections.
- The worker is private and does not serve an HTTP port.
- Missing configuration causes a safe non-ready result without secret leakage.

## Validation record — 2026-07-13

- `pnpm db:generate` completed with the generated client at
  `lib/generated/prisma`. A before/after checksum check confirmed that this
  command did not modify `prisma/schema.prisma` or migration files.
- Worker source readiness connected to PostgreSQL, Redis/BullMQ, and MinIO on
  the internal Compose network; it also ensured `MINIO_BUCKET` exists.
- Queue payload validation accepts exactly `{ jobId: string }` and rejects
  unexpected fields, including an `input` object.
- Later validation commands and their results are recorded in this section
  after they complete. This Phase 1 validation does not create a Job processor.
- Workspace lint and typecheck passed after resolving legacy schema-compatible
  web data-access types and packaging shared ESM workspace packages.
- `docker compose -f docker-compose.yaml config --quiet` and both web/worker
  image builds passed. PostgreSQL, Redis, and MinIO reported healthy; the
  worker reported `Fieldframe worker ready.` without an HTTP listener.
- A temporary web container on the private Compose network returned exactly
  `200 {"status":"ready"}` from `/api/health`. This avoids an unrelated local
  host-port conflict on `3000`; it does not expose the worker or a provider.
- The normal web/worker logs were checked against local database, MinIO, and
  Redis credential values without printing them; none were present. No
  `NEXT_PUBLIC_` provider configuration reference exists, and queue validation
  rejects an unexpected `input` field.
- After Docker runtime recovery, three worker restart cycles and three private
  web restart cycles passed. Each worker returned its ready message; each web
  cycle returned `200 {"status":"ready"}`. The final Prisma generation
  checksum check again confirmed schema and migration files were unchanged.
