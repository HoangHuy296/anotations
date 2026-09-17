# Dataset library and source connection redesign

The `/datasets` library now filters by dataset workflow status and creation
method before pagination. Filters persist in the URL and pagination links;
changing or clearing a filter returns to the first page. Legacy metadata without
a recognized workflow status remains In progress. Import includes every
non-upload source mode. Existing owner/member/admin access rules remain applied.

The list uses aligned source, asset activity, status, and action columns on
desktop, with stacked rows on mobile. Zero-count modalities are omitted. Asset
activity retains the existing measure (assets past New), and is explicitly
separate from dataset completion status.

The sidebar has a reusable source section, an actionable Gitea card showing only
the current user's usable saved connection count, and expandable GitHub/GitLab
future-provider panels. The section also appears below page content on mobile.
The desktop sidebar stays visible and can scroll as provider panels expand.

## Completion report

| Field | Result |
| --- | --- |
| Files created | `apps/web/src/components/datasets/dataset-library-toolbar.tsx`; `apps/web/src/components/layout/source-connections-panel.tsx`; `apps/web/src/lib/datasets/dataset-library-query.ts`; `apps/web/src/lib/datasets/dataset-library-service.ts`; `apps/web/src/lib/source-provider-summary.ts`; `apps/web/src/types/dataset-library.ts`; `apps/web/tests/dataset-library/dataset-library.test.ts`; `docs/dataset-library-redesign.md` |
| Files modified | `apps/web/src/app/(app)/datasets/page.tsx`; `apps/web/src/components/layout/app-shell.tsx` |
| Commands to run | From the repository root: `pnpm --filter @annotationplatform/web typecheck`. From `apps/web`: `DATASET_LIBRARY_INTEGRATION_TESTS=1 node --env-file=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/dataset-library/dataset-library.test.ts` with a reachable development database. |
| Environment variables needed | No new application variables. Integration tests use `DATABASE_URL` and the opt-in `DATASET_LIBRARY_INTEGRATION_TESTS`. |
| Database migration changes | None. |
| Known limitations | GitHub/GitLab panels are informational; no new integrations were added. Saved Gitea connection count is not a live provider health check. Existing seven-row cursor pagination is retained. |
| Next recommended phase | None started. Review the updated interface before selecting further provider functionality. |

Validation passed: web TypeScript check, ESLint for the changed TypeScript files,
diff whitespace check, and two tests covering query validation and database
filtering/pagination/access boundaries/connection eligibility. Browser checks on
`http://localhost:3001/datasets` verified combined filters, clearing filters,
expanded provider panels, and layouts at 1440, 390, and 320 pixels. No browser
page errors or horizontal mobile overflow were observed. Temporary diagnostic
accounts and test records were removed.

This update refines existing functionality and does not implement future phases
early. No packages, credentials, environment files, generated Prisma files, or
migrations were changed by this update.
