# Provider Configuration Contract

This contract is consumed only by `apps/web` and `apps/worker`; it is not a
browser API.

## Required names

```text
DATABASE_URL
MINIO_ENDPOINT
MINIO_ACCESS_KEY
MINIO_SECRET_KEY
MINIO_BUCKET
REDIS_HOST
REDIS_PORT
REDIS_PASSWORD
BULLMQ_PREFIX
```

## Validation behavior

1. Parse and validate all required values at process startup.
2. Do not emit any secret value, URL userinfo, token, or password in a thrown
   error, structured log, health response, or queue payload.
3. If a required value is invalid, the process is not ready and exits or stays
   unavailable with a safe message naming only the invalid variable.
4. Web and worker use internal Compose hostnames when running in Compose;
   local host overrides are supplied only through ignored environment files.

## Readiness ownership

| Process | Required checks |
| --- | --- |
| web | configuration and PostgreSQL; Redis/MinIO client construction must remain server-only |
| worker | configuration, PostgreSQL, Redis/BullMQ, and MinIO |

The worker never exposes this status through a public HTTP server. Any web
readiness route returns only service status labels and no configuration values.
