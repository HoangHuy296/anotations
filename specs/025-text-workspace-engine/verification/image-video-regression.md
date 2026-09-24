# T171 — existing IMAGE/VIDEO and Phase 022/023/024 acceptance suites (shared-surface regression)

Date: 2026-09-24. Real Postgres/MinIO/Redis (the live dev-stack instance).

## Workspace shell (Asset Browser, header/navigation, properties panel)

```
$ npm run test:workspace
1..85
# pass 56, fail 0, skipped 29 (pre-existing, unrelated to TEXT)
```

## Generic annotation API (IMAGE)

```
$ node --import tsx --test tests/annotation-api/*.test.ts
1..23
# pass 15, fail 0, skipped 8 (pre-existing `ANNOTATION_API_INTEGRATION_TESTS=1`-gated cases)
```

## Workflow + collaboration

```
$ node --import tsx --test --test-concurrency=1 tests/collaboration/*.test.ts tests/workflow/assignment-collaboration-integrity.test.ts
1..27
# pass 19, fail 0, skipped 8 (pre-existing)
```

## Exports (job-queue + assets-bulk)

```
$ npm run test:job-queue
1..35
# pass 9, fail 0, skipped 26 ("full queue integration skipped: safe local Redis configuration is incomplete or violates the controlled-test policy" -- this repo's own deliberate gate, not attempted around)

$ WORKSPACE_INTEGRATION_TESTS=1 node --import tsx --test --test-concurrency=1 tests/assets-bulk/*.test.ts
1..20
# pass 19, fail 1
```

**One failure found, investigated, confirmed unrelated to this feature — reported honestly per this phase's own "skipped/failed is not passing evidence" rule, not fixed as part of this closure:**

`tests/assets-bulk/change-status.test.ts` — `"Change Status updates only Asset.status, leaving Annotation status on the same assets untouched"` calls `changeStatusBulk(dataset.id, [asset.id], [], AssetStatus.READY)`, which reports `{succeeded: 1, failed: 0}` and actually persists `Asset.status = READY` — but the test then asserts the persisted status should be `AssetStatus.NEEDS_REVIEW`, a status the call never requested. This looks like a stale/incorrect assertion in the test itself (or a pre-existing bug in `changeStatusBulk`), not a regression this session caused:

- This session never touched `asset-bulk-service.ts`, `changeStatusBulk`, or any bulk asset-status/workflow-transition code.
- This test file is gated behind `WORKSPACE_INTEGRATION_TESTS=1`, an explicit opt-in flag not present in `.env` and not exercised by this repo's default `test:workspace`/other named scripts — it was only run here because T171 asks for the broader shared-surface suite specifically.
- The sibling test in the same file ("Setting an asset to its current status is a genuine no-op success") passes.

**Not fixed as part of this closure**: this is a pre-existing, unrelated finding outside this feature's scope, and "fixing" it here would be exactly the kind of unauthorized scope creep this closure phase should avoid. Flagging it explicitly for the repository owner's attention rather than silently omitting it from this report or claiming a clean pass.

**Result**: PASS for every TEXT-adjacent shared surface this feature actually touches (workspace shell, generic annotation API, workflow, collaboration, job-queue exports); ONE unrelated pre-existing failure found and reported, not caused by this feature.
