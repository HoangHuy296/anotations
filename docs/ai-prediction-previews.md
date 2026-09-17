# AI prediction previews without dataset label creation

Opening AI Detection on an image loads its latest completed detection task from PostgreSQL. The normalized predictions appear as dashed amber boxes on the image, with class names and confidence. Each prediction is listed in the drawer. Previews remain separate from the annotation store and do not create labels or annotations.

To save a preview, select an existing dataset label and click Save. The server reloads the prediction from the completed task, validates its asset scope and the selected label, checks annotation-create permission, and creates an AI-sourced draft. Client requests cannot supply replacement geometry or confidence. Saving never creates dataset labels. Existing automatic annotations are recognized and marked saved.

On task completion the UI immediately requests `GET /api/ai/tasks/{aiTaskId}/predictions?assetId={assetId}` for that exact task, independently of the annotation refresh. Reopening the drawer without a newly completed task uses `GET /api/assets/{assetId}/ai-results` for the latest completed run; the explicit save route is `POST /api/ai/tasks/{taskId}/predictions` with `{assetId,index,labelId}`. Provider result retrieval and normalization remain worker responsibilities. Neither browser route fetches AIOZ, exposes raw provider output, or resubmits a task. Saving uses the existing asset-content transaction guard with a stable task/prediction annotation ID. Concurrent saves serialize, replay preserves later annotation edits, and a different-label replay is rejected.

## Verified existing task

On 2026-09-10, the read-only preview service returned all five predictions for task `cmtvdi9q001wfof0khnzont6d`: motorcycle, car, bus, bicycle, and boat. Its provider ID is `80cd746b-5888-44e5-b8e2-969c90829294`. The worker had already fetched and normalized these results successfully. The original writer skipped annotation creation because none of the predicted classes matched a dataset label. Verification left the existing task and its zero annotation count unchanged.

## Completion report

Files created:

- `apps/web/src/types/ai-prediction.ts`
- `apps/web/src/lib/ai/ai-prediction-results.ts`
- `apps/web/src/components/workspace/ai-prediction-review.tsx`
- `apps/web/src/app/api/assets/[assetId]/ai-results/route.ts`
- `apps/web/src/app/api/ai/tasks/[aiTaskId]/predictions/route.ts`
- `apps/web/tests/ai/ai-prediction-results.test.ts`
- `docs/ai-prediction-previews.md`

Files modified:

- `apps/web/src/components/workspace/ai-detect-dialog.tsx`
- `apps/web/src/components/workspace/image-engine.tsx`
- `apps/web/src/components/workspace/canvas-stage.tsx`
- `apps/worker/src/jobs/ai-prediction-writer.ts`

Commands to run from the repository root:

```bash
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/worker typecheck
```

From `apps/web`, with local PostgreSQL available:

```bash
node --env-file=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx tests/ai/ai-prediction-results.test.ts
node --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/ai/ai-detect-view.test.ts tests/ai/ai-task-api-client.test.ts tests/ai/ai-model-labels.test.ts
```

From `apps/worker`, with local PostgreSQL available:

```bash
node --env-file=../../.env --import tsx --test tests/jobs/aioz-provider-pipeline.test.ts
```

Environment variables needed: no additions; existing `DATABASE_URL` and application/worker configuration are reused. No environment files were changed.

Database migration changes: None. No new dataset labels are created.

Known limitations: image bounding-box predictions only; the drawer shows the latest completed run for the image, not full task history. Older automatic annotations without prediction indices are recognized by their original class and geometry; already-edited legacy rows cannot always be associated reliably. New worker writes include stable prediction indices. The UI has not been interactively verified in a browser. Existing automatic creation of matching-label annotations remains intact.

Next recommended phase: open the affected image's AI Detection drawer and review its five previews. No future phases were implemented early.

## Completion refresh correction

The status endpoint continues to return lifecycle fields only. Provider output is fetched and normalized in the worker before `SUCCEEDED`; the browser renders the safe persisted results through the task-specific predictions endpoint. A completion refresh starts before the separate annotation fetch, and changing tasks remounts the preview panel to clear stale results and assignments.

Modified for this correction: `apps/web/src/lib/ai/ai-prediction-results.ts`, `apps/web/src/app/api/ai/tasks/[aiTaskId]/predictions/route.ts`, `apps/web/src/components/workspace/image-engine.tsx`, `apps/web/src/components/workspace/ai-prediction-review.tsx`, `apps/web/src/components/workspace/ai-detect-dialog.tsx`, `apps/web/tests/ai/ai-prediction-results.test.ts`, and this document. No files created, migrations, environment changes, new dependencies, or dataset labels. Use the verification commands above. Next step is checking the completed run in the workspace; no future phase was implemented.
