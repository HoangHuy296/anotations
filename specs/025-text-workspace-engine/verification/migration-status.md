# T162 — migration status against the isolated acceptance deployment

Date: 2026-09-24.

```
$ pnpm exec prisma migrate status
Loaded Prisma config from prisma.config.ts.

Prisma config detected, skipping environment variable loading.
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "fieldframe", schema "public" at "127.0.0.1:5433"

19 migrations found in prisma/migrations

Database schema is up to date!
```

**Target**: the local dev-stack Postgres (`docker-compose.yaml`'s `postgres` service, `fieldframe` database on `127.0.0.1:5433`) — the same instance every integration test in this session ran against. This is the acceptance-style deployment this feature has been developed and tested against throughout, not a separately-provisioned target.

**Result**: PASS — no pending migrations, all 19 applied cleanly, including the T017/T018 `text_workspace_engine` migration. This confirms `migrate status` sees no drift for *this* instance; it does not prove the absence of drift on any other target (e.g. a real staging/production rollout), which would need its own separately-authorized check before applying migrations there.
