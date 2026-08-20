# Phase 005 Validation Quickstart

1. Sign in as an owner, create a MULTI_MODAL Dataset without `primaryModality`, then list/detail/update/archive it.
2. As a non-member, use the Dataset id against detail, labels, and assets: each must return `404` with no metadata.
3. Create labels whose display names normalize identically; the second request must fail without another Label record.
4. Add Assets in two datasets; paginate/filter one authorized Dataset and verify every result remains in scope and contains only safe metadata.
5. Run the Node/tsx route tests plus `pnpm typecheck` and `pnpm --filter @annotationplatform/web lint`.

## Phase 005 execution record (2026-07-14)

- Authorization implements the approved effective-permission rule: `UserRole.ADMIN` is a system-wide override; a non-admin user must own or be a member of an existing Dataset. `UserRole.MANAGER` may create a Dataset but does not gain access to every Dataset.
- `pnpm --filter @annotationplatform/web test:dataset-metadata` passed in a short-lived Compose-network container: 8 tests passed, 0 failed. The focused HTTP coverage signs in through `/api/auth/login` with opaque cookies, runs against `next start`, and verifies Dataset CRUD/archive with server-derived ownership, Label duplicate/denial no-side-effects, and Dataset-scoped Asset pagination/filtering. Fixtures use Prisma and clean their uniquely named records.
- `pnpm typecheck`, `pnpm --filter @annotationplatform/web lint`, and `pnpm --filter @annotationplatform/web build` passed. The production build was run outside the restricted shell because Turbopack needs an internal worker port.
- Asset responses use an explicit projection and omit binary, storage, cache, provider, source URL/path/fingerprint, and arbitrary metadata fields.

## Required verification commands

```bash
pnpm typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/web build
```

Run the Prisma-backed Phase 005 tests inside the Compose network because the local `DATABASE_URL` resolves `postgres` there:

```bash
docker compose run --rm --no-deps \
  -v "$PWD:/workspace" -v /workspace/node_modules \
  -v /workspace/apps/web/node_modules \
  --entrypoint sh worker \
  -lc 'cd /workspace && pnpm --filter @annotationplatform/web test:dataset-metadata'
```

## Phase 005 limitations

- Dataset and label browser forms remain incremental UI work; this phase delivers the authorized browser-facing APIs and a safe Dataset detail read view.
- No upload, binary access, repository sync, Job enqueue/processing, or SourceConnection lifecycle is added.
- No schema, migration, generated Prisma client, worker, queue, or binary-storage behavior changes.
