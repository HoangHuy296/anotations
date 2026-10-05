# Visualization Phase 3 completion report

2026-09-29. Phase 3 only; no Phase 4 work.

## Outcome and architecture boundary

The existing guarded page and platform AppShell now host a functional read-only image viewer. The adapter is strictly:

```text
Prisma Dataset / Asset / Annotation / Label / Job
  -> allowlisted in-memory response DTO
  -> existing visualization shell and image viewer
```

There is no second dataset identity, persistence layer, imported copy, manifest, Parquet file, revision model, cache, snapshot, or asynchronous processing. `Dataset.id`, `Asset.id` (row_id), `Annotation.id`, and `Label.id` remain the original identities. Label names/colors come from persisted labels. AI prediction records are never queried as annotations.

Presentation adapts the source viewer's contact sheet, focused inspection, selection, overlay toggle, previous/next controls, and keyboard concepts into platform primitives. Its API client, FastAPI/Celery architecture, generated contracts, catalog, import/export, and mutation controls were not copied.

## 1. Files created

Under `apps/web/src/lib/visualization/`:

- `dataset-read.ts`
- `asset-read.ts`
- `annotation-adapter.ts`
- `geometry.ts`
- `insights-read.ts`
- `schema-read.ts`
- `activity-read.ts`
- `media-read.ts`
- `http.ts`
- `read-client.ts`

Under `apps/web/src/components/visualization/`:

- `image-viewer.tsx`
- `visualization-session.tsx`
- `read-state.tsx`

Under `apps/web/src/app/api/datasets/[datasetId]/visualization/`:

- `route.ts`
- `assets/route.ts`
- `assets/[assetId]/route.ts`
- `assets/[assetId]/media/route.ts`
- `insights/route.ts`
- `schema/route.ts`
- `activity/route.ts`

Tests and documentation:

- `apps/web/tests/visualization/adapter.test.ts`
- `apps/web/tests/visualization/http.vitest.spec.ts`
- `apps/web/tests/visualization/viewer.vitest.spec.ts`
- `specs/api/schemas/visualization.yaml`
- `docs/dataset-visualization-phase-3-report.md`

## 2. Files modified

- `apps/web/src/types/visualization.ts`
- `apps/web/src/lib/validation/visualization.ts`
- `apps/web/src/lib/api-response.ts` — added DATASET_NOT_COMPLETED; preserved unrelated pre-existing additions.
- `apps/web/src/components/visualization/visualization-shell.tsx`
- `apps/web/src/components/visualization/data-tab.tsx`
- `apps/web/src/components/visualization/insights-tab.tsx`
- `apps/web/src/components/visualization/schema-tab.tsx`
- `apps/web/src/components/visualization/activity-tab.tsx`
- `apps/web/tests/visualization/presentation.test.ts` — kept query tests; moveqqqqd component assertions to viewer Vitest coverage with the new session boundary.
- `specs/api/openapi.yaml` — seven read operations added; preserved unrelated existing work.

Phase 1 guard/entry page, index redirect, header, and Versions presentation remain intact. Existing Phase 1/2 files were untracked before this phase, so this inventory describes changes relative to their approved contents, not merely Git's tracked status. Tool-managed test output may be refreshed by Vitest.

## Read contracts and behavior

Every new endpoint independently validates IDs, resolves the authenticated actor, requires existing dataset.read permission, and requires exact metadata.workflowStatus COMPLETED. A shared handler checks again after reading/preparing media; a reopened dataset returns 409 DATASET_NOT_COMPLETED, including a reopen during media preparation. Inaccessible, archived, or deleted datasets return a safe 404. Unauthenticated requests return 401. Asset reads are explicitly scoped to the requested dataset.

The client uses same-origin GET/no-store requests only. On a completion/access failure it clears the rendered viewer subtree (including record state and object URLs) and replaces navigation with the existing workspace or catalog. Focus/visibility checks also revalidate the dataset without background polling or writes.

| Endpoint suffix | Projection |
| --- | --- |
| `/` | Authorized existing dataset ID/name |
| `/assets` | Paginated active assets, stable row_id, filename, modality, dimensions, media eligibility |
| `/assets/[assetId]` | Asset detail and up to 500 persisted annotations with stable IDs, revisions, labels, normalized geometry or explicit unavailable reason |
| `/assets/[assetId]/media` | Authorized application image stream; no provider/storage location returned |
| `/insights` | Direct Prisma counts, top label groups and valid image dimension ranges |
| `/schema` | Actual response field/type descriptions and paginated real label definitions |
| `/activity` | Paginated durable Job ID/type/status/created/finished summaries |

Zod bounds pages to 1–10,000 and page sizes to 1–50 (default 18). Assets support allowlisted filename/createdAt sorting, asc/desc order, filename search up to 100 characters, modality filtering, and persisted annotation label-ID filtering. Repeated, unknown, or malformed list parameters are rejected. Ordering includes a stable ID tie-breaker. Schema and Activity also paginate. Label distribution returns at most 50 groups and explicitly marks truncation.

The UI lists all active modalities by default, including explicit VIDEO/AUDIO/TEXT unsupported cards. A mixed dataset retains its images and visibly unsupported other assets. The contact sheet has filename search, sorting, bounded pages, and a focused modal with Escape, arrow-key navigation within the current page, focus restoration, label names/colors, and overlay visibility. Missing media has an explicit state.

Bounding boxes remain normalized xywh 0..1 in both persistence and DTOs. The renderer derives pixels using original width/height, then scales the SVG viewBox with the image. Missing/invalid geometry or dimensions suppress the overlay. A decoded-image/stored-dimension mismatch also suppresses overlays instead of guessing. Other annotation geometry types are explicitly unavailable. Nothing writes coordinates or revisions.

Media is streamed from existing MinIO storage through the application after authorization; external-only/uncached media remains unavailable. Raster MIME types are allowlisted (JPEG, PNG, WebP, GIF, AVIF); SVG is not streamed by this viewer. Objects are capped at 25 MiB both at stat and during streaming. Provider errors are sanitized. Responses use private/no-store and nosniff. No bucket names, keys, provider URLs, credentials, general metadata, or signed storage URLs enter DTOs. The client lazily fetches visible images into transient object URLs, revoking them when their views unmount.

Insights scopes are explicit: all active dataset assets; persisted annotations across all statuses/modalities on those assets; label counts use annotations rather than distinct images; dimension ranges cover only images with valid persisted dimensions. COMPLETED never implies accepted/reviewed/correct annotations. Activity is limited to persisted Jobs and does not claim a reconstructed edit/review history. Versions remains unavailable.

## 3. Commands and validation results

From repository root:

```sh
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/web build
pnpm --filter @annotationplatform/web test:dataset-metadata
pnpm --filter @annotationplatform/web test:workspace
pnpm --filter @annotationplatform/web test:direct-upload
python3 scripts/validate-openapi.py
git diff --check
```

From `apps/web`, with the existing test environment:

```sh
DATASET_LIBRARY_INTEGRATION_TESTS=1 node --env-file=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/visualization/*.test.ts tests/dataset-library/dataset-library.test.ts
node --env-file=../../.env ./node_modules/vitest/vitest.mjs run tests/visualization/*.vitest.spec.ts --environment node
```

| Check | Result |
| --- | --- |
| Node visualization/catalog tests | 13 passed, no skips |
| Visualization Vitest tests | 11 passed, including real Prisma endpoint fixtures and isolated media-provider tests |
| Dataset metadata suite | 12 passed |
| Workspace suite | 56 passed, 29 skipped by existing gates |
| Web typecheck | Passed |
| Web lint | Passed |
| Production build | Passed; all seven new routes emitted |
| OpenAPI validation | Passed: 88 route files, 80 documented paths; existing eight inventory exclusions unchanged |
| Whitespace check | Passed |
| Existing direct-upload suite | 1 passed, 7 failed; unrelated environment limitation detailed below |

Focused tests cover exact completion, reopened/denied/archived/deleted access on every endpoint, cross-dataset assets, pagination/filter validation, real identities/colors, SVG rectangles at two image dimensions, invalid/missing geometry, unsupported modalities, missing/oversized media, safe aggregates/Jobs, response allowlists, GET-only requests, and clearing before navigation replacement. Phase 1 route guards and Phase 2 URL defaults remain covered.

### Existing unrelated failure

The direct-upload suite initially failed to start its test server when run alongside the build. It was rerun separately after the build. The retry reached upload requests but still reported 7 `fetch failed` cases. Its existing `tests/direct-upload/helpers.ts` forces `MINIO_PUBLIC_ENDPOINT` to `http://minio:9000`; DNS resolution of `minio` on this host returned EAI_AGAIN. No upload code, helper, endpoint configuration, or environment file was changed to work around that condition. This suite is not reported as passing. The visualization's real-media smoke used the existing configured private MinIO endpoint successfully.

### Actual browser smoke

A temporary production server on port 3107 and local headless Chrome exercised a disposable, genuinely persisted COMPLETED dataset, MinIO PNG, label, and annotation. The fixture used a 200×100 image and normalized xywh (0.1, 0.2, 0.3, 0.4).

Verified in the browser:

1. `/datasets` -> completed dataset link -> guarded viewer Data tab.
2. Open image inspector and load the real MinIO-backed image through the application route.
3. SVG box was (20, 20, 60, 40) pixels with persisted label color #e11d48.
4. Overlay toggle, Escape, Insights navigation, and browser back worked.
5. Observed application viewer requests were GET-only.
6. Reopening the fixture and triggering focus revalidation cleared the viewer and navigated to `/workspace/[datasetId]`.

The screenshot was visually inspected at `/tmp/vis3-browser-smoke.png`; execution summary is at `/tmp/vis3-browser-result.log`. Fixture dataset/user/session/labels/annotations and MinIO object were removed in finally cleanup. The temporary browser and server were stopped. No product dataset was duplicated or imported.

## 4. Environment variables needed

None added. Existing database, authentication, and private MinIO/provider configuration is reused. No environment files changed. Existing test flags are used only by test commands.

## 5. Database migration changes

None. No schema, migrations, generated Prisma output, packages, workers, Jobs for visualization, or infrastructure configuration was added or changed.

## 6. Known limitations and risks

- Original images are used, with a 25 MiB per-object limit and lazy bounded pages; there are no thumbnails, transcoding, or derived previews. Large decoded images can still cost browser memory.
- Non-image assets, unsupported image formats, external-only media without MinIO storage, and non-box geometry remain explicitly unsupported/unavailable.
- At most 500 annotations are returned per asset, with total/truncation disclosure. The inspector navigates within the loaded page. Top-50 label distribution discloses omitted groups.
- Counts are direct database aggregates, not cached statistics. Independently executed aggregates and offset pages may reflect concurrent changes; this phase does not promise an immutable snapshot or global COMPLETED write lock.
- Lifecycle is checked on requests, after reads, and when focus/visibility returns. Already-delivered bytes cannot be revoked retroactively; there is no continuous polling.
- Activity contains only safe Job summaries. Versions is intentionally unavailable until a separately approved immutable-snapshot design.
- The repository still contains unrelated uncommitted work. The skipped workspace checks and failing host-specific upload suite remain verification limitations.

## 7. Next recommended phase

Visualization Phase 4: separately specify derived artifacts, heavy processing, cache invalidation, and immutable snapshots after review/approval. Stop here: no Phase 4 schema, worker, preview/statistics job, cache, or snapshot was implemented.
