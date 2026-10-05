# T069–T076, T089 — regression evidence (026 implementation, HG-1-narrowed scope)

Date: 2026-09-24. Real local PostgreSQL/Redis/MinIO (the live dev stack; the running `web` container is the pre-change build, so HTTP-gated suites were **not** pointed at it). Scope: everything except the HG-1-blocked write path (T035–T050, T064, T083–T087).

| Task | Command | Result |
| --- | --- | --- |
| T069 typecheck | `pnpm run typecheck` (web, worker, domain, queue, realtime) | PASS, 0 errors |
| T070 lint | `pnpm run lint` | PASS, 0 errors/warnings |
| T076 build | `pnpm run build` (domain → queue → web → worker) | PASS; new route `/api/ai/tasks/preview` registered dynamic |
| Domain | `pnpm --filter @annotationplatform/domain test` | 34/34 pass (25 pre-existing + 9 new `ai-batch`) |
| T071 web AI | `npm --prefix apps/web run test:ai` | 84 tests: 61 pass, 0 fail, 23 skipped (pre-existing `AI_HTTP_BASE_URL`-gated HTTP suites); 23 of them new: `ai-batch-targets` (8), `ai-batch-task-creation` (10), `ai-batch-retry` (5) |
| T071 worker AI | `node --env-file=../../.env --import tsx --test --test-concurrency=1 tests/jobs/*.test.ts tests/providers/ai/*.test.ts` (apps/worker) | 87 tests: 77 pass, **1 fail (pre-existing, see below)**, 9 skipped (pre-existing gates); 10 new (`ai-batch-dispatch` 4, `ai-batch-polling` 6) |
| T072 Phase 022 | `WORKSPACE_INTEGRATION_TESTS=1 … tests/assets-bulk/*.test.ts` | 20 tests: 19 pass, **1 fail (pre-existing, see below)**; `selection-resolution` 4/4 unchanged |
| T073 Phase 023 | `WORKSPACE_INTEGRATION_TESTS=1 … tests/workflow/*.test.ts` | 22 tests: 21 pass, 0 fail, 1 skipped (`WORKFLOW_HTTP_TESTS` gate) |
| T074 workspace | `npm --prefix apps/web run test:workspace` | 85 tests: 56 pass, 0 fail, 29 skipped (same as the 025 baseline) |
| T075 worker queue | `npm --prefix apps/worker run test:queue` | 78 tests: 53 pass, 0 fail, 25 skipped (pre-existing gates) |
| T075 job-queue | `npm --prefix apps/web run test:job-queue` | 35 tests: 9 pass, 0 fail, 26 skipped ("safe local Redis configuration" gate, unchanged) |
| annotation API | `… tests/annotation-api/*.test.ts` | 23 tests: 15 pass, 0 fail, 8 skipped (pre-existing gate) |
| client logic | `vitest run tests/workspace/ai-batch-selection.vitest.spec.ts` | 11/11 pass |
| OpenAPI | `docs:validate-openapi`, `docs:bundle-openapi`, `docs:swagger-ui` | PASS (73 documented paths incl. `/api/ai/tasks/preview`; 189 schemas bundled) |

## Pre-existing failures/skips (T089) — recorded separately, not regressions

1. `apps/worker/tests/jobs/aioz-video-pipeline.test.ts` › "video submit/poll/restart writes ten unlabeled tracks and 38 AI keyframes once": `VideoObjectTrack_createdById_fkey` foreign-key violation inside `ai-video-prediction-writer.ts`. **Verified pre-existing:** it fails identically with the `HEAD` versions of `ai-submit.processor.ts` and `aioz-task-resources.ts` restored (this feature's only changes to that path). Not investigated further; VIDEO is out of v1 scope.
2. `apps/web/tests/assets-bulk/change-status.test.ts` › "Change Status updates only Asset.status…" (same finding as 025's T171: asserts `NEEDS_REVIEW` after requesting `READY`).
3. Skips are the repository's own gates (`AI_HTTP_BASE_URL`, `WORKFLOW_HTTP_TESTS`, `OPENAPI_CONTRACT_TESTS`, safe-Redis policy) and are not counted as passes. The HTTP contract tests could not be exercised against this code because the live `web` container runs the pre-change build (a rebuilt/isolated web is part of T077).

## Deliberate contract/test changes (never silent)

- `apps/web/tests/ai/helpers.ts` `createAiTaskFixture`: the HTTP fixture Asset now has a size and storage location and the model uses the test-only provider `aioz-test-result` (acceptance now requires source identity — decision D-U1 — and a real-provider model must be in the deployed catalog — DI-5). Those suites are gated and were not run against this code.
- Frozen/skipped Asset ⇒ FAILED aggregate (D-I2) is implemented in the domain reconciler (`reconcileAiOutcomes`) and tests; the existing worker test asserting only data safety for a review-frozen Asset is unchanged and passes.

## Update after runtime verification (final code)

Two fixes were made during runtime verification (cancel of a queued operation now closes its AiTask; the panel shows the canceled status). Re-run on the final tree: `pnpm run typecheck` 0 errors, `pnpm run lint` clean, web `test:ai` 89 tests: 66 pass, 0 fail, 23 gated skips; client logic 11/11. Regression coverage added for Assets missing a size/storage location (`ai-batch-task-creation.test.ts`, also `ai-batch-targets.test.ts`) and for preserving single-Asset VIDEO AI through the unified path with a VIDEO batch refused.
