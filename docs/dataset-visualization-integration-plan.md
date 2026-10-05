# Dataset visualization integration plan

Status: proposed; repository review and planning only, 2026-09-28. No implementation phase has begun.

## Reviewed worktrees

- Annotation Platform: `/home/aioz-huy/anotations`, including existing uncommitted work. That work is not modified by this proposal; recheck the relevant files before implementation.
- Viewer: `/home/aioz-huy/dataset_visualize`, clean at `4524db5`. The requested `/home/aioz-huydataset_visualize` path was resolved to this existing directory.
- Review covers source code, contracts, package manifests, and architecture documents. Neither application was started, and runtime behavior was not verified.

This plan follows `AGENTS.md`, `docs/architecture.md`, `docs/job-system.md`, `docs/bullmq-postgres-job-flow.md`, `docs/clone-repository-plan.md`, and `docs/phases.md`. The five phases below are visualization delivery phases, not replacements for the platform foundation phases.

## Findings that affect integration

| Evidence | Implication |
| --- | --- |
| Platform `apps/web/src/app/(app)/datasets/page.tsx` already calls `getDatasetLibrary`, reads `metadata.workflowStatus`, and links both the dataset name and arrow to `/workspace/${dataset.id}`. | Change both destinations through one shared resolver. Make the card/body activation use that resolver too, without intercepting its management controls. |
| `apps/web/src/lib/datasets/dataset-library-query.ts` recognizes COMPLETED and REVIEWED and falls back to IN_PROGRESS. The validation schema permits IN_PROGRESS, COMPLETED, REVIEWED. | Only exact COMPLETED opens visualization. Missing, malformed, DRAFT, and future values remain workspace destinations; adding DRAFT to the editor is not necessary for routing. |
| `/api/datasets` selects `datasetMetadataSelect`, which excludes metadata. The catalog page uses its own server service, not that endpoint. | Expose an allowlisted workflowStatus projection in both list contracts; never serialize arbitrary dataset metadata just to expose one field. |
| `requireDatasetPermission` provides existing membership, owner/admin, deleted, and archived checks. Its selected dataset does not include metadata. | Reuse this permission policy, then read only necessary metadata server-side; do not assume the permission result already contains workflowStatus. |
| The existing workspace is `/workspace/[datasetId]`; `/datasets/[datasetId]` is a separate overview. | Preserve the actual workspace route, including its human/AI experience. |
| Viewer is already Next.js 15 / React 19 / Tailwind 3; platform uses Next.js 16 / React 19 / Tailwind 4. | Extract components into the platform; adapt styles, route params, and data fetching rather than moving a second application. |
| Viewer `components/dataset/dataset-detail.tsx` has seven tabs, defaults to Dataset card, and includes upload, revision deletion, grants, and export controls. | Extract exactly Data, Insights, Schema, Versions, Activity; default to Data and remove mutation controls. |
| Viewer `lib/api.ts` calls `/api/v1`, imports mock data, and enables mocks by default in development unless disabled. | Replace the API client and generated FastAPI contracts. Do not copy mock fallback, authentication, catalog, or import behavior. |
| Viewer data assumes revisions/configs/splits and `CanonicalRecord`; backend normalizes uploads into Parquet. | Adapt platform entities directly; no manifest upload, dataset duplication, or required Parquet intermediate for initial viewing. |
| Viewer backend uses FastAPI, SQLAlchemy, Celery, ProcessingJob, and Redis results/cache. | Reuse processing algorithms selectively, not this service topology or persistence model. |
| Platform image schema currently validates normalized xywh in 0..1; viewer image rendering consumes xywh percentages and converts to source pixels. | The initial bridge is normalized-to-percentage, not blindly normalized-to-pixel. See geometry boundary below. |
| Platform has AssetVersion and Annotation.revision, but no dataset snapshot model in the reviewed Prisma schema. | Versions cannot truthfully be populated from either as if they were immutable dataset revisions. |

## Target behavior and boundaries

```text
/datasets                         one existing catalog
  exact metadata.workflowStatus === COMPLETED
    -> /datasets/visualize/[datasetId]
       Data | Insights | Schema | Versions | Activity
  every other value
    -> /workspace/[datasetId]     existing human annotation / AI experience

/datasets/visualize -> /datasets  redirect; no second catalog
```

Use relative paths; local development therefore resolves to `http://localhost:3000/datasets/visualize/{datasetId}` without hardcoding a host.

```text
Platform AppShell + viewer components
  -> authorized Next.js reads / Route Handlers
  -> visualization adapter
  -> Prisma Dataset / Asset / Annotation / Label

Heavy processing:
Next.js -> durable PostgreSQL Job -> BullMQ { jobId }
  -> private apps/worker -> MinIO artifacts + PostgreSQL result metadata
```

No second public API, Celery queue, SQLAlchemy database access, separate dataset records, source catalog, or export/import bridge. If a Python algorithm is retained later, the private worker may invoke a bounded internal processor; database authority, authorization, Job state, and publication remain with the existing platform. Any new runtime/dependency requires a concrete proposal before adoption.

### Navigation and access contract

1. A pure, browser-safe destination resolver accepts dataset ID and projected workflow status. It returns `/datasets/visualize/${id}` only for exact COMPLETED; otherwise `/workspace/${id}`. Both links and card activation use it. Keep progress counters independent.
2. The viewer server page validates the ID, authenticates the actor, checks `dataset.read`, excludes deleted/archived datasets, and reads current workflowStatus before loading viewer content. Unavailable or unauthorized datasets produce the existing safe not-found/forbidden behavior. Non-COMPLETED datasets redirect to the workspace.
3. Every visualization data endpoint repeats authorization and the completion check. Return a structured 409 `DATASET_NOT_COMPLETED` for an authorized dataset reopened since page load; the client clears viewer data and replaces the route with the workspace. API callers do not receive HTML redirects.
4. Do not put the only guard in a persistent layout. Check it at server-page/data-read boundaries, including future tab routes and media capability issuance. Do not globally change the existing workspace media endpoint to require completion.
5. Initially use uncached/private viewer responses and fresh server reads. Refresh and subsequent requests must observe reopening; client caches must be scoped by dataset and cleared on sign-out, access denial, or state change. Authorization must precede later artifact/cache access too.
6. The viewer exposes no annotation, label, dataset, upload, AI submission, revision deletion, grant, or processing mutations. Read services must not invoke workspace initialization such as `ensureDefaultImageLabels`, which can write during a read.
7. Scope distinction: this requirement makes the visualization experience read-only. It does not, by itself, establish a global freeze on all existing workspace/API writes for COMPLETED datasets. A global lifecycle lock would require a separately defined write policy covering ongoing workers and reopen transactions. Do not claim immutable content before snapshots exist.

## Source reuse map

Source paths below are relative to `/home/aioz-huy/dataset_visualize/apps/web/src`.

| Source | Destination / treatment |
| --- | --- |
| `components/dataset/dataset-detail.tsx` | Extract header and five tab presentations into platform `components/visualization/`; replace source routing, session calls, revision-ready routing logic, and mutation controls. |
| `components/viewers/image-viewer.tsx` | Reuse contact sheet, focus inspector, selection, overlay visibility, and keyboard behavior; adapt record contract, label colors, media URLs, and dependencies. |
| `components/viewers/dataset-viewer.tsx` | Reuse bounded pagination/selection behavior; replace source API queries and modality registry. Initial scope is image only. |
| `components/dataset/adaptive-insights.tsx`, `insights-rail.tsx`, `components/charts.tsx` | Reuse applicable presentation concepts against real platform metrics; source charts require ECharts, which is not currently installed in the platform. |
| `components/dataset/scope-state.ts`, `lib/revision-diff.ts` | Adapt pure state/diff helpers only where platform scope/snapshot contracts actually support them. |
| `lib/types.ts` | Extract a small viewer DTO contract into platform `src/types/visualization.ts`; do not import the full source domain. |
| Source AppShell, catalog, upload/auth/access/export pages, `lib/api.ts`, `lib/mock-data.ts`, generated API schema | Exclude. Use platform navigation, authentication, permissions, and API conventions. |
| `services/api/app/processing/image.py`, `profiler.py`, media processors | Algorithm references for phases 4–5; replace filesystem ingestion and source persistence orchestration. |

Existing platform UI primitives and React state/fetch are the initial alternatives to source Radix packages and TanStack Query. Simple charts can use existing code/SVG before a chart package is justified. Do not copy source package.json or install packages implicitly. Any request must name the capability, existing alternative, and browser/server impact.

## Phase 1 — Lifecycle routing and server guard

Build:

- Shared destination helper and safe list workflowStatus projection.
- Consistent dataset title, arrow, and card activation, preserving keyboard links, new-tab behavior, and independent management controls.
- Guarded viewer landing page containing real dataset identity and a read-only notice; no pretend data or future processing.
- `/datasets/visualize` redirect to the existing catalog.

Create under `apps/web/`:

- `src/lib/datasets/dataset-destination.ts`
- `src/lib/visualization/access.ts` (server-only authorized completion check)
- `src/app/(app)/datasets/visualize/page.tsx`
- `src/app/(app)/datasets/visualize/[datasetId]/page.tsx`
- `tests/visualization/` routing and access tests

Modify: `src/app/(app)/datasets/page.tsx`, `src/lib/datasets/dataset-library-service.ts`, `src/types/dataset-library.ts`, `src/app/api/datasets/route.ts`, applicable dataset response contract/tests. Extend `src/lib/dataset-metadata.ts` only with an explicit safe projection helper; do not add raw metadata to all responses. Reuse `readDatasetWorkflowStatus`; extract it into a pure shared module if needed rather than creating divergent parsers.

Acceptance: COMPLETED routes to viewer; IN_PROGRESS, REVIEWED, DRAFT, absent/invalid values route to workspace regardless of Asset/Annotation statuses. Test both UI entry points, unauthorized/direct access, UUID and CUID IDs, deleted/archived datasets, and completion followed by reopen and refresh. No new catalog or Visualize button.

Risk: stale prefetched destinations and uncommitted catalog/API changes. The destination page must always enforce fresh server state.

Environment/migrations/packages: no new variables, migrations, or packages. Existing authentication and PostgreSQL configuration required.

## Phase 2 — Read-only shell and tab presentation

Build the header and Data/Insights/Schema presentations within the existing server `AppShell`, retaining its sidebar, topbar, theme, and accessibility preferences. Add Versions and Activity tab frames. Default to Data; use validated `?tab=data|insights|schema|versions|activity` state initially, preserving dataset selection and back/forward navigation. Separate tab folders are optional later.

Create: `apps/web/src/components/visualization/{visualization-shell,dataset-header,data-tab,insights-tab,schema-tab,versions-tab,activity-tab}.tsx`, `src/types/visualization.ts`, and `src/lib/validation/visualization.ts` as needed. Modify the phase-1 viewer page and add focused UI coverage.

Use real header metadata from phase 1. Panels whose data contracts arrive in phase 3 explicitly state that their capability is not yet available; they must not show synthetic counts, charts, versions, or datasets. Do not release this intermediate shell as a completed viewer. Versions remains unavailable until phase 4.

Acceptance: five named tabs, keyboard-accessible navigation, platform styling, Data default, no source navigation or mutations, no source API/mock calls, and no unsupported dependency imports.

Risk: source global CSS/tokens, heavy component coupling, and source Next/Tailwind differences. Extract small presentations rather than copying the 1,000+ line controller.

Environment/migrations: none new. Prefer installed dependencies; document any additional package request separately.

## Phase 3 — Direct entity adapter and functional image viewer

Create under `apps/web/src/`:

- `lib/visualization/{dataset-read,asset-read,annotation-adapter,insights-read,schema-read,activity-read}.ts`
- `components/visualization/image-viewer.tsx` and a platform API client if needed
- `app/api/datasets/[datasetId]/visualization/route.ts`
- Read endpoints beneath that directory for `assets`, `assets/[assetId]`, `assets/[assetId]/view-url`, `insights`, `schema`, and `activity`, limited to what the tabs require
- Adapter/access regression tests in `apps/web/tests/visualization/`

Modify: phase-2 components, DTOs, Zod query schemas, and applicable API documentation.

Mapping:

| Platform record | Viewer projection |
| --- | --- |
| Dataset | Existing ID, name, safe description, exact lifecycle eligibility; no source slug identity. |
| Asset | Stable row_id = Asset.id; bounded record pages; filename, dimensions, MIME type and actual modality. Exclude deleted/archived assets. |
| Annotation | Stable annotation ID, label reference, revision, source, and validated canonical geometry; never substitute AI prediction records for persisted annotations. |
| Label | Stable ID, name, and platform color; avoid source label-name hashes as the authority. |
| MinIO reference | Authorized application media access or newly issued short-lived object-scoped view URL; no general storage metadata dump. |
| Config/split | Hide controls where the platform has no real split/config model. An internal all-assets scope is a view projection, not a persisted synthetic dataset. |
| Activity | Safely projected existing durable Jobs and relevant persisted events, with bounded pagination and clearly stated coverage; no reconstructed/fabricated history. |

Geometry boundary: the current `normalizedBoundingBoxSchema` persists xywh in 0..1, while source `image-viewer.tsx` expects `annotations.detections` coordinates in 0..100 and divides by 100 when rendering. Either adapt normalized values by multiplying by 100 once, or refactor the renderer to accept an explicitly typed normalized DTO. Prefer the latter for a platform-native contract. Pixel rendering derives `x * originalWidth`, `y * originalHeight`, etc.; resizing must not change stored geometry. Do not change persisted geometry in this integration. The governance wording about original-image coordinates and the current normalized implementation differ; record this discrepancy rather than attempting a silent geometry migration. Invalid geometry and missing dimensions need explicit unavailable-overlay behavior, not guessed boxes.

Define bounded page/query limits and allowlisted sorting/filtering in Zod. Fetch selected off-page assets through a scoped detail read. Avoid serializing full metadata/properties, raw Job.input/result, provider URLs, or credentials. Convert dates and BigInt sizes to safe DTO values. Missing media returns a real unavailable state. Before generated thumbnails exist, reuse authorized existing media with bounded lazy loading and disclose the performance limitation.

Initial Insights contains only real inexpensive Prisma aggregates (asset/annotation totals, label distribution, dimensions where available). Declare scope and denominator; completion does not imply all annotations are reviewed or correct. Schema describes actual projected fields, types, geometry units, and labels. Expensive profiles remain unavailable until phase 4.

Acceptance: same dataset/asset IDs with no writes or imports; correct boxes at different image sizes; label colors preserved; missing/invalid geometry handled; paginated large datasets; cross-dataset asset IDs rejected; revoked access and reopening handled by every new read; no mutation requests during viewer interaction. Unsupported modalities have an explicit state until phase 5.

Environment/migrations/packages: existing PostgreSQL/auth/MinIO settings only; no required migration or new package. Image viewing is functional at this phase, without claiming snapshot semantics.

## Phase 4 — Derived artifacts, profiles, and dataset snapshots

Specify the artifact/snapshot contract before schema work. Create private worker processors for image previews, statistics/schema profiles, and immutable dataset snapshots, driven by new kinds on the common Job model. Processing is separate from workflowStatus: COMPLETED still opens the viewer when a derived artifact is pending or failed.

Proposed files: `apps/worker/src/jobs/visualization-*.ts`, supporting `apps/worker/src/visualization/`, shared validated contracts in `packages/domain/src/visualization.ts`, web `src/lib/visualization/` artifact/version services, and worker/web regression tests. Modify worker dispatch, Job validation/retry allowlists, Prisma schema via a new reviewed migration, viewer Versions/Activity, and API contracts. Final model/migration names belong to the phase-4 design.

Store bytes in MinIO and safe artifact/snapshot references in PostgreSQL. A DatasetSnapshot, if introduced, references the existing Dataset; it is not a second dataset catalog or a visualization-specific Job table. Annotation.revision, AssetVersion, and repository commit strings remain distinct from snapshot identity.

Publication must identify the full content generation, including label changes, annotation revisions, asset additions/deletions, and media identity. Dataset.updatedAt alone is insufficient. Capture a consistent input boundary using Prisma transactions/version checks; never publish mixed generations or promote stale results after reopening. Define completion-triggered or authorized background scheduling outside GET viewer requests. Retry successors reuse deterministic output identity; duplicate delivery cannot duplicate artifacts/snapshots. Failed derivation must not replace the last valid snapshot.

Use PostgreSQL/artifact-backed result references for caching; Redis remains queue transport only. Cache keys include dataset, content generation/snapshot, algorithm version, and query scope. Always reauthorize before serving cached content. Presigned URLs are refreshed capabilities, never durable cache/snapshot values.

Acceptance: preview/profile readiness independent of completion; duplicate delivery, failed/retried processing, out-of-order publication, reopen during processing, deletion/access revocation, and invalidation on each content change tested. Versions represents actual immutable captures; no historical versions invented for preexisting datasets. Activity reports sanitized durable events.

Risks: concurrent writers, consistent snapshot capture, storage growth, processor dependency/runtime selection, and existing worker changes. Define retention/deletion and safe resource limits before rollout.

Environment/migrations: reuse existing database/MinIO/Redis configuration; any processor limits are server-only settings specified during design. New additive schema migration expected for snapshot/artifact metadata; do not rewrite existing migrations or generated files without explicit approval. New dependencies require explicit permission.

## Phase 5 — Additional modalities

After image/bounding-box acceptance, add video, audio, text, and mixed-modality viewing under the same dataset route. Select renderers from Asset.modality. Reuse existing platform media/text services and persisted geometry before introducing new processing.

Source video supports temporal segments but explicitly lacks frame-level boxes/tracks; platform video annotations therefore need additional adapter/rendering work. Source has no dedicated text viewer in its registry; build one against platform text contracts, preserving UTF-16 offsets and existing policies. Source mesh/tabular viewers are outside this requested expansion.

Create modality-specific components inside `components/visualization/`, adapters inside `lib/visualization/`, and worker processors only where existing derivatives are inadequate. Modify registry, DTO/validation/API contracts, and any approved processing dispatch. Lazy-load each renderer and avoid loading media streams for unselected cards.

Acceptance: modality-specific geometry/timing/offset fidelity, mixed datasets on one URL, bounded media loading, and the same authorization/completion/read-only rules. Migration and dependency needs are assessed per modality; HLS/waveform packages are not installed preemptively.

## Validation and delivery gates

Before each phase, report its build scope, files created/modified, and risks. After each phase, stop with the seven required report fields and obtain the preceding completion approval before the next phase, as required by `docs/phases.md`. Do not execute all five as one change.

Existing commands to use during implementation (not run for this documentation review):

```sh
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/web test:dataset-metadata
pnpm --filter @annotationplatform/web test:workspace
pnpm --filter @annotationplatform/web exec node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/dataset-library/dataset-library.test.ts
pnpm --filter @annotationplatform/web exec node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/visualization/*.test.ts
pnpm --filter @annotationplatform/web build
```

The visualization test command applies after phase 1 creates those tests. Use existing test isolation conventions and a test database. Add worker/schema checks only when phase 4 changes those areas. Capture existing worktree failures separately from regressions caused by the integration. Browser acceptance must exercise catalog entry points, direct URLs, all five tabs, role restrictions, and reopening; source tests do not prove the new platform boundary.

## Planning completion report

1. Files created: `docs/dataset-visualization-integration-plan.md`.
2. Files modified: none by this review.
3. Commands to run: none required to use this plan; implementation validation commands are listed above.
4. Environment variables needed: none for this review. Implementation reuses existing configuration.
5. Database migration changes: none.
6. Known limitations: static review only; source runtime and platform runtime not exercised; geometry convention discrepancy and dataset snapshot semantics require the explicit treatment above; platform already has substantial uncommitted work.
7. Next recommended phase: visualization Phase 1, lifecycle routing and server guard. No implementation or future phase was performed early.
