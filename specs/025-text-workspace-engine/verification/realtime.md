# T169 — realtime package tests, US6, and existing non-TEXT collaboration suites

Date: 2026-09-24. Real Redis/Postgres (the live dev-stack instance).

## `apps/realtime` package tests

```
$ node --env-file=../../.env --import tsx --test --test-concurrency=1 tests/**/*.test.ts
1..4
# pass 4, fail 0
```

Note: `pnpm --filter @annotationplatform/realtime test`'s own script has no `--env-file` flag, so `REDIS_PASSWORD` isn't loaded and all 4 tests report `SKIP` by default; ran with `--env-file=../../.env` to get real executed results instead of silently-skipped ones (per this phase's own "skipped tests are UNVERIFIED, not passing evidence" rule). Covers: ticket verification/scoped Redis fan-out/revocation, presence aggregation with EDITING precedence and expiry, scoped heartbeat broadcast creating no edit lock, and invalid/expired-ticket rejection. `"presence aggregates tabs, gives EDITING precedence, expires, and never locks"` is the structural proof behind T140's presence-privacy claim — it exercises the exact `PresenceMember` payload shape (`{userId, assetId, activity}`) TEXT reuses unmodified.

## US6 TEXT collaboration suite

```
$ node --import tsx --test --test-concurrency=1 tests/text-collaboration/*.test.ts
1..3
# pass 3, fail 0
```

## Existing non-TEXT collaboration suites (regression check)

```
$ node --import tsx --test --test-concurrency=1 tests/collaboration/*.test.ts tests/workflow/assignment-collaboration-integrity.test.ts
1..27
# pass 19, fail 0, skipped 8 (pre-existing, unrelated to TEXT)

$ vitest run tests/workspace/use-collaboration-realtime.vitest.spec.ts tests/workspace/collaboration-presence.vitest.spec.tsx tests/workspace/collaboration-workspace-ui.vitest.spec.tsx
Test Files  3 passed (3)
Tests  4 passed (4)
```

**Result**: PASS across all three groups — realtime package (4/4), US6 TEXT-specific (3/3), and the pre-existing generic collaboration suite shows no regression (19/19 executed passing, same 8 pre-existing skips as before this feature).
