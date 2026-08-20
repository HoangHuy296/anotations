# Annotation Platform

Annotation Platform is a multi-modal annotation product. The public application is a
Next.js App Router app; a separate private worker processes durable Jobs.

## Architecture

- PostgreSQL + Prisma: canonical metadata and Job lifecycle state.
- Redis + BullMQ: transport only; every queue payload is `{ jobId }`.
- MinIO: private binary storage; PostgreSQL never stores binary data.
- `Asset.modality`: canonical workspace modality.
- `Dataset.primaryModality`: optional UI default only; it does not constrain a Dataset.

## Prerequisites

- Node.js 22+
- pnpm 11.10+
- Docker Engine + Docker Compose v2

## Configure local environment

Create an ignored `.env` from the example and replace all placeholder secrets:

```bash
cp .env.example .env
```

For Compose, keep `DATABASE_URL_DOCKER` pointed at `postgres:5432`. For host
Prisma commands, use a host-reachable URL (normally `localhost:5433` when
using the checked-in Compose mapping). Never commit `.env` or expose provider
credentials to browser code.

## Start providers with Compose

```bash
docker compose up -d postgres redis minio
docker compose ps
```

Apply migrations from the repository root. If your `.env` uses the
container-only hostname, provide a host-reachable `DATABASE_URL` for this one
command rather than editing secrets into source control.

```bash
pnpm db:validate
pnpm db:generate
pnpm exec prisma migrate deploy
```

Start the full stack when you want Compose to own web and worker:

```bash
docker compose up --build
```

Web health is available at `/api/health`. The worker has no HTTP listener.

## Run locally in development

Use local Next.js when Compose is only providing PostgreSQL, Redis, and MinIO:

```bash
pnpm run dev
pnpm run dev:worker
```

Open `http://localhost:3000`. If Compose web already owns port 3000, either
stop it or use Next.js on port 3001:

```bash
docker compose stop web
pnpm run dev
```

If Next reports a permission error acquiring `.next/dev/lock`, a container has
left build output owned by another UID. Fix only this generated directory:

```bash
sudo chown -R "$USER:$USER" apps/web/.next
rm -f apps/web/.next/dev/lock
```

## Build and static checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Test suites

Unit/schema tests:

```bash
pnpm --filter @annotationplatform/web test:local-folder-import
pnpm --filter @annotationplatform/worker test:queue
```

Full queue integration is intentionally opt-in and must use passworded Redis
bound to `127.0.0.1`, a non-zero dedicated DB, and an isolated key prefix:

```bash
QUEUE_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 \
REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=annotationplatform-test REDIS_TEST_PREFIX=annotationplatform-test \
pnpm --filter @annotationplatform/worker test:queue
```

Do not use the normal `annotation-platform` queue prefix for integration tests.
Use the existing password from your ignored `.env`; never put it in shell
history, documentation, or source code.

## Important security rules

- Browser uploads use only short-lived, object-scoped presigned POST forms.
- MinIO, database, Redis, and provider credentials are server-only.
- Dataset and Job authorization is resolved server-side; client owner IDs are ignored.
- A denied request must not create Assets, Jobs, JobEvents, objects, or queue deliveries.

## Useful commands

```bash
pnpm db:generate
pnpm db:validate
pnpm db:migrate
pnpm db:studio
docker compose logs -f web worker
docker compose down
```

See [architecture documentation](docs/architecture.md) and
[phase roadmap](docs/phases.md) for the locked architecture and implementation
sequence.
