# T163 — root typecheck (web, worker, domain, queue, realtime)

Date: 2026-09-24.

```
$ pnpm run typecheck
$ pnpm --filter @annotationplatform/web typecheck && pnpm --filter @annotationplatform/worker typecheck && pnpm --filter @annotationplatform/domain typecheck && pnpm --filter @annotationplatform/queue typecheck && pnpm --filter @annotationplatform/realtime typecheck
$ tsc --noEmit   # web
$ tsc --noEmit   # worker
$ tsc --noEmit   # domain
$ tsc --noEmit   # queue
$ tsc --noEmit   # realtime
```

**Result**: PASS — zero errors across all five packages. `web`/`worker` were already typechecked repeatedly throughout this session after every change; `domain`/`queue`/`realtime` had not been separately re-checked at the root-script level and are confirmed clean here.
