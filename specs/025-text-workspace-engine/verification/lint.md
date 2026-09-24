# T164 — root lint (web, worker, domain, queue, realtime)

Date: 2026-09-24.

```
$ pnpm run lint
$ pnpm --filter @annotationplatform/web lint && ... worker && ... domain && ... queue && ... realtime
$ eslint   # web
[one pre-existing warning found and fixed in this pass -- see below]
$ tsc --noEmit   # worker / domain / queue / realtime (these packages' "lint" script is tsc --noEmit)
```

**First run**: one warning, `'expectedPolicyRevision' is assigned a value but never used` in `apps/web/tests/text-annotations/text-relation-commands.test.ts:180` — pre-existing test code (not written this session originally; a destructured value superseded a few lines later by a freshly-read `refreshedRevision`, needed because an intervening label creation bumps `textPolicyRevision`). Fixed by dropping the unused destructure and documenting why the fresh read is needed. Re-ran the affected test file directly (10/10 passing, unchanged behavior) before re-running lint.

**Second run**: 0 errors, 0 warnings across all five packages.

**Result**: PASS.
