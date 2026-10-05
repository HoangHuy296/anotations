# Dataset visualization UI refinement

Scope: presentation refinement inspired by the local Dataset Studio reference at port 3001. Reuses Annotation Platform AppShell, safe read endpoints, real dataset identity, lifecycle/access guards and immutable snapshot behavior. Reference demo records, auth, backend, catalog and mutation controls were not migrated. Phase 029 remains an audit/specification; no modality schema or engine-routing change is included.

## Files

Created: `apps/web/src/components/visualization/dataset-summary.tsx` and this report.

Modified:
- `apps/web/src/components/visualization/dataset-header.tsx`: compact identity header, catalog return link, completion/read-only indicators.
- `apps/web/src/components/visualization/visualization-shell.tsx`: icon navigation and responsive content/overview columns.
- `apps/web/src/components/visualization/data-tab.tsx`: filename search, sorting, accessible grid/list controls, consistent contact sheet and existing image inspector.
- `apps/web/src/components/datasets/dataset-row-actions.tsx`: native management dialog, Escape/backdrop dismissal, focus containment/restoration, accessible rename label, awaited request pending state, accurate Archive label.
- `apps/web/src/components/imports/import-form.tsx`: selected radio text inherits contrasting foreground; keyboard focus outline.
- `apps/web/tests/visualization/viewer.vitest.spec.ts`: real overview counts and accessible layout-control regression coverage.

No packages, environment variables, migrations, schema changes, new API routes, or viewer mutations. Existing dirty worktree changes were preserved.

## Validation

- Web typecheck and lint: passed.
- Node visualization presentation/routing/adapter tests: 10 passed.
- Vitest visualization viewer/page guard/HTTP tests: 14 passed with the existing environment loaded. An initial invocation without DATABASE_URL failed setup; rerunning with `node --env-file=../../.env` passed.
- Production build: passed; updated web image deployed to the existing localhost:3000 service.
- Browser smoke: real target dataset, grid/list selection, image inspector Escape, mobile overflow, management dialog focus containment/restoration, and visibility radio contrast/selection passed. Screenshot review identified a narrow-screen search overlap, corrected by placing the input on its own mobile row. Final mobile recheck is recorded below.
- OpenAPI validation not required: no API contract changed.

Commands: `pnpm --filter @annotationplatform/web typecheck`, `pnpm --filter @annotationplatform/web lint`; from apps/web use the existing server-only registration with Node/tsx for the three Node test files, and `node --env-file=../../.env ./node_modules/vitest/vitest.mjs run tests/visualization/viewer.vitest.spec.ts tests/visualization/page-guard.vitest.spec.ts tests/visualization/http.vitest.spec.ts`.

## Existing data limitation

The requested dataset `049ee9f6-2e3d-4610-bc2a-8a08f7e8e236` is COMPLETED and has 10 active records, but original media requests in the pre-change browser returned unavailable. The UI preserves explicit missing-media states. No replacement images or invented counts were added, and no dataset lifecycle or records were modified for the smoke test. Media/storage diagnosis is separate from this presentation change.

Next recommended work: review the updated UI; address unavailable source media separately. Continue Phase 029 only after its historical-data and enforcement policies are approved.

Final mobile recheck passed at 390 px: no document overflow and the filename input does not overlap the Search button. Final deployed web image: `e08fb7b96de3`. Desktop, mobile, management-dialog and imports screenshots were reviewed from `/tmp/ui-viewer-desktop.png`, `/tmp/ui-viewer-mobile.png`, `/tmp/ui-manage.png`, and `/tmp/ui-imports.png`. The temporary authenticated browser session was removed after validation. No rename/status/archive/import operation was submitted on the user's records.
