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
pnpm --filter @fieldframe/web typecheck
pnpm --filter @fieldframe/web lint
pnpm --filter @fieldframe/web test:repository-preflight
pnpm --filter @fieldframe/web build
```

No schema change is planned, so `prisma migrate` is not part of this phase.

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
