# Contract: Observability Surface

Extends the existing `GET /api/health` (`apps/web/src/app/api/health/route.ts`). No new route is introduced (research.md decision 10 — reuse, don't duplicate).

## Today (before this feature)

```json
GET /api/health
HTTP 200 { "status": "ready" }     // Postgres reachable
HTTP 503 { "status": "not_ready" } // Postgres unreachable
```

## After this feature

The top-level `status`/HTTP-code contract for existing callers (e.g. container orchestration health checks) is **preserved exactly** — `status` still reflects overall readiness and the HTTP code still flips to `503` when any required dependency is down, so no existing liveness/readiness probe breaks. A new `checks` object is added, additive only:

```json
GET /api/health
HTTP 200
{
  "status": "ready",
  "checks": {
    "postgres": { "ready": true },
    "redis": { "ready": true },
    "minio": { "ready": true }
  },
  "jobs": {
    "queueBacklog": 12,
    "active": 4,
    "failed": 2,
    "stale": 0,
    "retrying": 1,
    "deadLettered": 0
  },
  "cleanup": {
    "lastJobEventCleanupAt": "2026-08-17T02:00:11.000Z",
    "lastOrphanScanAt": "2026-08-17T02:05:03.000Z",
    "lastOrphanScanDryRun": true
  }
}
```

- `checks.*` reuses the same `probeProvider` result shape `apps/worker/src/readiness.ts` already produces at startup (`@fieldframe/domain`'s `ProviderReadiness`), applied here to a live, on-demand web-side call instead of a one-time worker-startup probe.
- `jobs.*` counts come from grouped Prisma `count()` queries against `Job.status` (`active` = `RUNNING`+`QUEUED`+`RETRYING`+`CANCELING`; `stale` = the derived stale-job predicate from `data-model.md`; `deadLettered` = the derived dead-letter predicate) and `queueBacklog` from BullMQ's own `Queue.getJobCounts()`.
- `cleanup.*` timestamps come from the most recent successful run of each scheduled pass — sourced from the most recent matching `JobEvent`/internal marker each scanner writes, not a new table.
- **Never included, at any nesting level**: connection strings, credentials, Redis/MinIO/Postgres URLs, signed URLs, or any `Job.input`/`Job.state` payload content — this endpoint reports counts and booleans only, per AGENTS.md's security rules and FR-050.

## Authorization

This endpoint's existing behavior (no authentication required, consistent with a container health check) is preserved for the `status` field. The new `checks`/`jobs`/`cleanup` detail is gated behind the existing elevated-role check already used for platform-wide surfaces (see `spec.md`'s Assumptions — "any platform-wide view limited to existing elevated roles"): an unauthenticated or non-elevated caller receives only `{ "status": ... }` as before; an authenticated `ADMIN`-role actor receives the full body. This keeps the health check usable by infrastructure (no auth) while keeping operational detail restricted, without introducing a new role or permission model.
