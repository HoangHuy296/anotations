# Foundation Readiness Contract

## Compose services

| Service | Ready when | Depends on |
| --- | --- | --- |
| postgres | PostgreSQL accepts a readiness query | persistent database volume |
| redis | Redis responds to ping with its configured authentication | persistent Redis volume |
| minio | object-storage health endpoint succeeds and the configured bucket is reachable/created by approved bootstrap behavior | persistent object-storage volume |
| web | server-only configuration and database readiness succeed | postgres, redis, minio healthy |
| worker | configuration plus PostgreSQL, Redis/BullMQ, and MinIO readiness succeed | postgres, redis, minio healthy |

## Browser-facing readiness response

The web application may provide a same-origin readiness endpoint returning only:

```text
{ status: "ready" | "not_ready" }
```

It must not include connection strings, hostnames, bucket names, usernames,
passwords, queue names, or diagnostic stack traces.

## Worker readiness

The worker reports readiness through process exit status and sanitized stdout/
stderr logs suitable for Compose. It has no HTTP listener or browser route.

## Startup and restart behavior

- Compose must wait for provider healthchecks before starting web and worker.
- Web and worker retry bounded provider initialization after a transient startup
  race, then fail safely if readiness cannot be established.
- Restarting a provider must not cause the application to treat Redis as the
  durable Job authority or create a duplicate output.
