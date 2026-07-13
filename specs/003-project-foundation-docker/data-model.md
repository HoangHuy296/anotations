# Foundation Data Model

This is a runtime-configuration model, not a Prisma schema. Phase 1 does not
change `prisma/schema.prisma` or migrations.

## Provider Configuration

| Value | Consumer | Validation rule | Exposure rule |
| --- | --- | --- | --- |
| `DATABASE_URL` | web and worker | Required non-empty database URL | Server/worker only |
| `MINIO_ENDPOINT` | web and worker | Required endpoint URL | Server/worker only |
| `MINIO_ACCESS_KEY` | web and worker | Required non-empty credential | Never log or serialize |
| `MINIO_SECRET_KEY` | web and worker | Required non-empty credential | Never log or serialize |
| `MINIO_BUCKET` | web and worker | Required valid bucket identifier | Server/worker only |
| `REDIS_HOST` | web and worker | Required host | Server/worker only |
| `REDIS_PORT` | web and worker | Required valid TCP port | Server/worker only |
| `REDIS_PASSWORD` | web and worker | Required by Compose profile; may be explicitly empty only if development Compose disables auth | Never log or serialize |
| `BULLMQ_PREFIX` | web and worker | Required non-empty namespace | Server/worker only |

## Service Readiness

| Entity | State | Meaning |
| --- | --- | --- |
| Provider | unavailable | Connection cannot be established or required configuration is invalid. |
| Provider | ready | Connection and minimal safe operation succeed. |
| Web | not ready | Database or required configuration validation fails. |
| Worker | not ready | Database, MinIO, Redis, or required configuration validation fails. |
| Compose service | healthy | Its healthcheck has passed; dependent service may start. |

## Queue Contract

| Item | Rule |
| --- | --- |
| Payload | Exactly `{ jobId: string }`. |
| Namespace | Derived from `BULLMQ_PREFIX`, not ioredis `keyPrefix`. |
| Authority | PostgreSQL Job is authoritative; Redis is transport only. |
| Worker behavior | Starts a connection/readiness loop only in Phase 1; it does not process business Jobs. |

## Relationships

```text
web ────────► PostgreSQL
web ────────► Redis / BullMQ producer contract
web ────────► MinIO (private object client)
worker ─────► PostgreSQL
worker ─────► Redis / BullMQ consumer contract
worker ─────► MinIO
```

Neither process exposes provider credentials to the browser. No entity in this
document replaces the durable Job/Asset/Annotation model planned for Phase 2.
