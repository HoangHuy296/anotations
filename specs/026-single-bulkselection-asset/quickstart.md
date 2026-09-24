# Validation Guide: Feature 026

**Not execution evidence.** Research E1–E3 and prior-phase approvals must close before implementation. These scenarios validate the eventual implementation; no live inference or test suite was run during this planning step.

## Prerequisites

Use an isolated acceptance Dataset and test database with real PostgreSQL, Redis/BullMQ, MinIO, web and private worker. Use the existing approved setup; do not replace these dependencies with mocks or edit env files/migrations during planning. Supply a versioned provider contract, verified capability/limit matrix and service-network download evidence. Have an authorized annotator and reviewer plus a revoked/foreign account; labels must match test classes.

Existing configuration names: DATABASE_URL; REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, BULLMQ_PREFIX; MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET, MINIO_PUBLIC_ENDPOINT; AIOZ_ANNOTATION_SERVICES_URL, AIOZ_COMPANY_API_KEY, AIOZ_ANNOTATION_SERVICES_TIMEOUT_MS. No new environment variable is proposed. Keep values out of reports. Provider key remains worker-side.

From repository root, use installed dependencies:

```bash
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/worker typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/web test:ai
```

Additional existing suite entry points:

```bash
cd apps/web
node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/assets-bulk/*.test.ts tests/workflow/*.test.ts
```

```bash
cd apps/worker
node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 tests/jobs/ai-*.test.ts tests/jobs/aioz-*.test.ts tests/providers/ai/*.test.ts
```

Run database-backed suites only against their isolated test environment; record skips as missing evidence. Newly implemented 026 tests should join these existing locations/commands. Start web/private worker with existing `pnpm dev` and `pnpm dev:worker` after the approved dependency stack is ready. No migration is expected for the proposed JSON contract extension.

## Acceptance scenarios and expected outcomes

| Scenario | Procedure | Expected result |
| --- | --- | --- |
| Current / one-member bulk equivalence | Run each on fresh equivalent IMAGE fixtures using same model/classes/thresholds | Same validation and canonical outputs, exactly one target each; existing single-Asset tests pass |
| Batch cardinality | Run 2, 7 and verified maximum distinct inputs | One Job/AiTask operation and one real provider create request with N files; no fan-out |
| Cross-page selection | Explicitly select seven across pages, hide some with filter; repeat filtered selection over at least three pages | All intended IDs included, no visible-page restriction; sort changes no membership |
| Duplicate/limits | Repeat explicit IDs; test effective maximum and maximum+1 for every target form | Duplicates execute once; over-limit rejects atomically and reports effective ceiling |
| Invalid targets | Empty, mixed IMAGE/VIDEO/AUDIO, frozen, archived, deleted, foreign, inactive/incompatible model, bad classes/thresholds | No provider POST or predictions; no substitute subset/current fallback; concealed resources remain concealed |
| Preview race | Change same-count membership/source after preview; return old preview response after a newer one | Stale response ignored; acceptance rejects changed target before Job creation |
| Fixed snapshot | Change filters and add matching Assets after acceptance | Accepted order/membership unchanged |
| Correlation | Same filenames, reordered outputs, duplicate/unknown/missing groups, same underlying object | Correct attribution or explicit failure; never guessed order; ambiguous duplicate inputs rejected before POST |
| Zero/malformed | Explicit zero group, missing group, and one malformed prediction among valid predictions for one Asset | Zero is success; missing is failure; malformed group commits no partial set |
| Workflow/source race | Freeze/change source/revoke access after submit; write while reviewer holds older revision | No unsafe delayed write; successful content changes invalidate stale review; existing manual work preserved |
| Partial outcomes | Make one Asset fail/skip while others succeed | Aggregate FAILED with retained visible successes; every target accounted for |
| Replay/retry | Redeliver after an Asset commit; request retry twice; redeliver predecessor and successor | No duplicate prediction/revision; one successor; reuse original external ID via owner reference |
| Ambiguous submission | Drop create response after remote acceptance and restart worker | Durable ambiguity, no second external create; recovery unavailable until reconciled |
| Enqueue/poll recovery | Interrupt post-commit enqueue and after recording external ID; refresh browser/restart worker | Durable references remain discoverable, scanner resumes without reconstructing from browser |
| Cancellation | Cancel before POST, during HTTP and against Asset write transaction | No writes after cancellation boundary wins; earlier successes visible, remaining targets canceled |
| Private download | Fetch through actual provider network without browser cookies, including expiry/unreachable cases | Scoped access works or durable safe failure; no public bucket, signed URL in logs or credential leak |
| VIDEO capability | Exercise two videos only with verified batch contract | One supported batch or clear unavailable reason; no unverified modality execution |
| Refresh/results | Leave/reopen with FAILED/CANCELED mixed outcomes and then revoke access | Same server-backed summaries/predictions; revoked task/result read concealed |

## Performance and usability

Use 100 accepted runs at concurrency five across sizes 1/2/7/effective maximum on isolated fixtures with dependencies healthy. Measure request-to-durable-reference latency, require at least 95% within five seconds, and count every accepted operation even when enqueue needs recovery. Record actual environment, provider/model version, limits, cache warm/cold state, fixture dimensions and dependency latency; never claim this measures inference completion. Verify one external task per normal accepted run.

With five representative annotators, at least four must configure a seven-Asset batch within two minutes excluding inference and identify target count/failed Assets unaided (SC-009). Record observed results, not an assertion based on automated tests.

## Evidence to retain

Sanitized request field schema and task/version evidence, N-file count and external POST count, Job IDs and source-free outcome summaries, before/after Annotation and Asset revisions, successful replay/cancel race assertions, browser captures with private information excluded, suite results including skipped tests and measured p95/usability results. Never retain credentials, signed links or raw provider payloads containing them. Cross-reference [API](contracts/ai-batch-api.md), [worker](contracts/ai-batch-worker.md), [UI](contracts/ai-batch-ui.md) and [data model](data-model.md).

## Next step

Close E1–E3 and the missing agent-context tooling limitation, then review/finalize the design and run speckit-tasks. This guide does not approve implementation, migrations or later phases.
