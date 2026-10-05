# Dataset visualization — Phase 4 completion report

Date: 2026-09-29. Phase 4 only. No Phase 5 implementation or separate visualization backend.

**Schema reconciliation:** when this job resumed, the Prisma schema was missing previously migrated TEXT/auth/asset-path definitions. Those definitions have been restored from the pre-Phase-4 schema, retaining the Phase 4 additions. Prisma validation passes and a fresh comparison with the actual database reports no difference. Prisma Client was regenerated using the approved normal command. No migration was added or rewritten, and no database data was modified during this repair. Fresh post-reconciliation checks all passed: web/worker typecheck, web lint, 12 visualization Node tests, 13 visualization Vitest tests, 5 database trigger/publication tests, 12 dataset metadata tests, workspace (56 passed/29 gated skips), production build, migration status, OpenAPI validation and the full two-snapshot browser smoke. No Phase 4 reconciliation blocker remains.

## Delivered

The existing Dataset remains authoritative. Its PostgreSQL content-generation fence covers the approved Dataset/Asset/Annotation/Label content mutations. Capture reads a single RepeatableRead view, freezes allowlisted content and independent original image bytes, and publishes only after a transactional generation/lifecycle/Job-lease check. Database triggers reject modifications to published snapshot/artifact references. Versions lists only actually published immutable snapshots; there is no invented pre-migration history.

Private worker processing uses the common durable `Job`, BullMQ `{jobId}` transport, private MinIO bytes and Prisma-only runtime database access. Capture publication also durably schedules derivation. The existing recovery scanner delivers that successor, including after a crash. Duplicate deliveries and same-generation concurrent publication reuse snapshot/artifact identities. Failed/stale regeneration cannot replace prior published results.

The viewer retains the platform AppShell, Phase 1 authorization/lifecycle guard, Phase 2 tab navigation and Phase 3 normalized geometry adapter. Versions can inspect captured images and persisted overlays. Data prefers current-generation thumbnails/previews and falls back to authorized original media. Insights and Schema expose bounded derived profiles with explicit snapshot scope; an earlier valid profile remains available while a newer capture waits for derivation. Activity projects the real durable processing Jobs. Viewer interactions remain read-only.

Every new viewer route independently authenticates, authorizes `dataset.read`, checks deleted/archived state and exact `COMPLETED`, then rechecks after I/O. Reopening returns `409 DATASET_NOT_COMPLETED`; the existing client clears data and replaces navigation with the workspace. Artifact/snapshot IDs are scoped to the Dataset. DTOs exclude private storage references, raw Job input/result, arbitrary metadata and provider details.

Processing submission is separate from the viewer: `POST /api/datasets/{datasetId}/visualization-processing`, empty JSON body, existing `dataset.update` permission. Existing failed-Job retry uses `job.retry`, current generation and one successor. Generic foundation submission rejects visualization kinds, preventing callers from supplying their own capture generation. No viewer control invokes these mutations.

The identity, publication, invalidation, retry, retention and trigger rules are documented in [the approved contract](dataset-visualization-phase-4-contract.md).

## Files created in Phase 4

- `docs/dataset-visualization-phase-4-contract.md`
- `docs/dataset-visualization-phase-4-report.md`
- `specs/proposals/visualization-phase-4/generation-triggers.review.sql`
- `prisma/migrations/20260929013000_visualization_snapshots/migration.sql`
- `packages/domain/src/visualization-processing.ts`
- `packages/domain/tests/visualization-processing.test.ts`
- `apps/worker/src/jobs/visualization.processor.ts`
- `apps/worker/tests/visualization/generation.test.ts`
- `apps/web/src/lib/visualization/processing-service.ts`
- `apps/web/src/lib/visualization/snapshot-read.ts`
- `apps/web/src/app/api/datasets/[datasetId]/visualization-processing/route.ts`
- `apps/web/src/app/api/datasets/[datasetId]/visualization/versions/route.ts`
- `apps/web/src/app/api/datasets/[datasetId]/visualization/versions/[snapshotId]/route.ts`
- `apps/web/src/app/api/datasets/[datasetId]/visualization/artifacts/[artifactId]/route.ts`
- `apps/web/src/app/api/datasets/[datasetId]/visualization/derived/route.ts`
- `apps/web/src/components/visualization/derived-status.tsx`
- `apps/web/src/components/visualization/snapshot-inspector.tsx`
- `apps/web/tests/visualization/processing.test.ts`
- `apps/web/tests/fixtures/visualization.png` — integration/browser-test fixture only
- `apps/web/scripts/visualization-phase4-smoke.ts`
- Generated normally: `lib/generated/prisma/models/DatasetSnapshot.ts`, `lib/generated/prisma/models/VisualizationArtifact.ts`.

## Files modified in Phase 4

- `prisma/schema.prisma` — additive Dataset fields, two reference models, two common Job kinds.
- `packages/domain/package.json` — server/worker visualization-processing subpath export.
- `packages/queue/src/job-contract.ts` — supported visualization Job kinds.
- `apps/worker/src/queue/queue-router.ts` — existing private dispatch.
- `apps/worker/src/queue/minio-orphan-scanner.ts` — published/in-flight artifact references.
- `apps/worker/src/queue/deleted-dataset-cleanup.ts` — capture snapshot artifact keys before cascading deletion.
- `apps/web/src/lib/jobs/authorization.ts`, `retry-job.ts`, `safe-job-status.ts` — submission boundary, safe retry and errors.
- `apps/web/src/lib/visualization/media-read.ts` and `apps/web/src/app/api/datasets/[datasetId]/visualization/assets/[assetId]/media/route.ts` — authorized preview selection/fallback.
- `apps/web/src/types/visualization.ts` — bounded browser DTO types.
- `apps/web/src/components/visualization/{data-tab,insights-tab,schema-tab,versions-tab,activity-tab,image-viewer}.tsx` — read-only derived/snapshot presentation.
- `apps/web/tests/visualization/{adapter.test.ts,http.vitest.spec.ts,viewer.vitest.spec.ts}` — new reads/access, actual Versions and GET-only behavior.
- `specs/api/openapi.yaml`, `specs/api/schemas/{visualization,jobs}.yaml` — new routes, bounded contracts, Job kinds and retry 202 response.
- Existing `lib/generated/prisma/**` files refreshed only by the normal approved Prisma generation command; no manual generated-client edits.

Phase 1–3 files were already present as untracked work; their presence in `git status` does not mean they were all created by this phase. Unrelated AI/export/workspace/asset-path changes were preserved. No commit was made.

## Validation results

| Check | Result |
| --- | --- |
| Web typecheck | PASS, `pnpm --filter @annotationplatform/web typecheck` |
| Web lint | PASS, no warnings/errors |
| Worker typecheck | PASS |
| Visualization Node tests | 12 passed, 0 failed/skipped; includes real PostgreSQL/MinIO capture/derive/retry test |
| Visualization Vitest suites | 13 passed, 3 files, 0 failed |
| Domain identity/profile tests | 4 passed |
| PostgreSQL trigger/publication suite | 5 passed on a freshly migrated disposable database |
| Dataset metadata suite | 12 passed |
| Workspace Node suite | 56 passed, 29 explicitly skipped, 0 failed |
| Web Job queue suite | 9 passed, 26 explicitly skipped, 0 failed |
| Worker queue suite | 60 passed, 25 explicitly skipped, 0 failed |
| Worker source-access suite | 27 passed, 0 failed |
| Worker repository-import suite | 14 passed, 14 explicitly skipped, 0 failed |
| Additional worker config/jobs/media/providers/visualization run | 57 passed, 11 skipped, 1 unrelated failure described below; this run included the first 4 trigger tests, with the additional concurrency test validated separately in the 5-test disposable-database run |
| Prisma validation | PASS |
| Migration status | All 21 migrations applied, including the new additive Phase 4 migration |
| Fresh migration replay | All 21 migrations applied successfully to disposable `vis4_migration_validation`; no schema difference afterward; database and temporary validation config removed |
| Development database/schema comparison | No difference detected |
| Production build | PASS: domain, queue, Next.js production build and private worker TypeScript build |
| OpenAPI inventory/schema validation | PASS: 93 actual route files, 85 documented paths; 8 existing documented exclusions |
| Optional OpenAPI HTTP contract suite | All 16 explicitly skipped by its existing integration opt-in gate; not counted as passed |
| Real browser smoke | PASS with real PostgreSQL, MinIO, isolated BullMQ transport and the current private worker dispatch |

Skipped cases retain their existing controlled-environment/opt-in gates; they were not silently treated as passes. No Phase 4 focused test was skipped.

The host has no ffmpeg. The real processing test and browser smoke used ffmpeg already installed in `annotationplatformdev-worker-1`, through a temporary host command adapter that copied only each disposable processing directory into/out of that container. This exercised the real encoder, not a mock renderer. No package was installed, no container was rebuilt, and no runtime code depends on that test adapter.

On the post-reconciliation pass, the first metadata HTTP attempt overlapped production build output regeneration and its test server could not start. Running it after the build completed passed all 12 tests; no product code change was needed.

Expected failure-injection tests emit `JOB_FAILED` or PostgreSQL immutability exceptions while passing. They are not product/test failures.

### Existing unrelated failure

`apps/worker/tests/jobs/aioz-video-pipeline.test.ts`: “video submit/poll/restart writes ten unlabeled tracks and 38 AI keyframes once” fails `0 !== 10`. Its provider assertion references `key`, declared only inside the separate `setup()` function. That out-of-scope reference is present in HEAD as well; this test file was not modified. The provider submission fails, leaving no tracks. This is outside Phase 4 and was left unchanged.

`git diff --check` also flags trailing whitespace emitted by the normal Prisma generator in generated files. Those files were not manually normalized because approval explicitly limits regeneration to Prisma's normal generation command. The checked handwritten Phase 4 tracked changes have no whitespace errors.

## Browser evidence

The smoke script creates a disposable COMPLETED image dataset, persisted label/annotation, real source image and authenticated session. An isolated BullMQ prefix carries only `{jobId}` to the existing private worker dispatcher.

Verified sequence:

1. Publish snapshot 1, then real thumbnail/preview/profile derivation.
2. Navigate `/datasets` → completed dataset → visualization Data.
3. Open the real image; verify pixel box coordinates, original label color, overlay toggle, Escape, tab navigation and browser Back.
4. Open Versions: exactly Version 1; inspect frozen image and overlay.
5. Change source annotation geometry/revision and label color through Prisma.
6. Confirm Version 1's projected capture and copied original bytes remain unchanged.
7. Publish and derive snapshot 2; Versions shows exactly Versions 2 and 1.
8. Inspect ready derived Insights and current Data overlays/color; confirm Version 1 remains unchanged.
9. Verify every viewer-originated API request used GET.
10. Reopen dataset; viewer clears and replaces navigation with `/workspace/[datasetId]`.

Artifacts from the latest post-reconciliation run: `/tmp/vis4-browser-data.png`, `/tmp/vis4-browser-versions.png`, `/tmp/vis4-reconcile-browser.log`. Earlier validation logs remain under `/tmp/vis4-*.log`. The Versions screenshot was visually inspected and uses the existing platform sidebar/topbar/theme. Test dataset, sessions/user, source and snapshot objects, and isolated queue were removed afterward.

## Migration and deployment

Only new migration `20260929013000_visualization_snapshots` was added. Existing migrations were not rewritten. The user-approved raw SQL is confined to its generation/immutability triggers. Application and new worker database access remains Prisma-only.

The migration adds three Dataset publication/generation fields, immutable DatasetSnapshot and VisualizationArtifact references, and `VISUALIZATION_CAPTURE` / `VISUALIZATION_DERIVE` Job enum values. Names/events/necessity, deterministic increment rules, rollback and retention behavior are in the contract. PostgreSQL tests cover relevant/no-op/unrelated writes, transaction rollback, concurrent increments/publications, stale publication, reopening/archive/delete, expired/canceled leases and immutable row mutation rejection.

Normal deployment commands, after reviewing the additive migration:

```sh
pnpm exec prisma migrate deploy
pnpm exec prisma generate
pnpm build
```

Restart the existing web and private worker processes with the new build using the platform's normal deployment procedure. This session validated a separate production server for the browser smoke; it did not redeploy the already-running main Compose web/worker services.

No new environment variable, dependency, public backend, Celery process, dataset catalog or visualization-specific Job/persistence authority was introduced. Existing PostgreSQL/MinIO/Redis/auth configuration is reused.

## Reproducible validation commands

From repository root:

```sh
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/worker typecheck
pnpm --filter @annotationplatform/web test:dataset-metadata
pnpm --filter @annotationplatform/web test:workspace
pnpm --filter @annotationplatform/web test:job-queue
pnpm --filter @annotationplatform/worker test:queue
pnpm --filter @annotationplatform/worker test:source-access
pnpm --filter @annotationplatform/worker test:repository-import
node --import tsx --test packages/domain/tests/visualization-processing.test.ts
pnpm exec prisma validate
pnpm exec prisma migrate status
pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
pnpm build
pnpm run docs:validate-openapi
```

From `apps/web`, with existing services and ffmpeg available in the executing environment:

```sh
node --env-file=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/visualization/*.test.ts
node --env-file=../../.env ./node_modules/vitest/vitest.mjs run tests/visualization/*.vitest.spec.ts --environment node
```

From `apps/worker`:

```sh
node --env-file=../../.env --import tsx --test tests/visualization/generation.test.ts
node --env-file=../../.env --import tsx --test --test-concurrency=1 tests/config.test.ts tests/media/*.test.ts tests/providers/*.test.ts tests/jobs/*.test.ts
```

For browser smoke, start the production web app on port 3107 and a disposable Chrome profile with CDP port 9227, then from `apps/web` run:

```sh
node --env-file=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx scripts/visualization-phase4-smoke.ts
```

This script requires real existing PostgreSQL/MinIO/Redis and ffmpeg; it creates/cleans disposable fixtures and its own queue prefix. It never submits work to the shared production queue.

## Limits and risks

- Image processing only. Other modalities remain explicitly unsupported. Capture limits are 1,000 active assets, 100,000 annotations, 10,000 labels, 25 MiB per image, 512 MiB total source bytes and 32 MiB descriptor. Exceeding a required capture bound fails safely rather than publishing a partial snapshot.
- Derivation is an atomic bounded batch. A required preview failure prevents that batch's new profile/previews from publishing; original-media viewing and earlier valid snapshots/profiles remain available. Historical inspection currently uses frozen originals; the live contact sheet prefers bounded generated thumbnails.
- Processing is requested through the authorized management API/existing retry path. It is not automatically started by viewing a completed dataset or by a new viewer mutation control. Capture-to-derive queue delivery normally waits up to the existing recovery scan interval (60 seconds), potentially longer under backlog/outage.
- Source writes contend on the parent Dataset generation fence. Normal PostgreSQL transaction rollback prevents partial invalidation; higher-load bulk-write contention/deadlock behavior should be observed in deployment.
- Frozen captures own image bytes, but source object changes performed outside the application's database write protocol cannot advance a Prisma entity generation. Legitimate source replacement must update Asset media identity. Copy-time ETag/size checks detect changes during copying.
- Published snapshots are retained with the Dataset; archival retains bytes and revokes reads, deletion makes bytes eligible for existing delayed cleanup. No age-based version pruning or user-facing snapshot deletion was added.
- No persistent Redis/browser result cache exists. Artifact reuse identities include Dataset, generation/snapshot, kind, algorithm and scope; all reads still reauthorize and return no-store responses.
- Main running services need the new build/normal restart before serving this implementation. The unrelated AI-video test and existing opt-in integration gaps above remain separate validation limitations.

## Next phase

Stop here for Phase 4 review. Phase 5 (video/audio/text/mixed-modality visualization) is the next planned phase only after separate approval; none was started.
