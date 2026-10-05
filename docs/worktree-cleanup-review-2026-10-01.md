# Worktree cleanup review — 2026-10-01

Initial review and removal plan (execution update below). No source, tests, migrations, environment files, generated Prisma files, Git index entries, containers, or services were changed by this review. One report was created. Raw rerun logs and machine-readable inventories are stored privately at `/tmp/annotation-cleanup-review-d3aubpy5`.

## Inventory and limitations

The first inspection found **1,413** changes (425 modified, 987 untracked, one deleted). The test-run snapshot contained **1416** paths; the final inventory contained **1469** paths before this report was created. **53** new paths appeared between those snapshots. Other work was changing the tree during this review; results describe the files seen during each command, not an immutable commit.

The final snapshot includes **853** Phase 029 verification artifacts (58.6 MiB). There are **47** byte-identical groups with **242** excess copies. Identical bytes do not prove an artifact is unneeded: separate runs have separate provenance and checksum references.

| Classification | Changed paths |
| --- | ---: |
| passing-test-removal-request-review | 10 |
| plan-untrack-generated | 2 |
| protected-generated-or-migration | 48 |
| retain-blocked-test | 331 |
| retain-recovery-evidence-pending-archive | 853 |
| retain-source-or-documentation | 225 |

## Fresh checks

| Check | Result |
| --- | --- |
| Domain tests | 84 passed, zero failed/skipped |
| Queue contract | 1 passed, zero failed/skipped |
| Database safety policy | 20 passed, zero failed/skipped |
| Web ESLint | Passed; no warnings reported |
| Web, worker, domain, queue, realtime TypeScript | All passed; incremental output disabled |
| OpenAPI validation | Passed; informational notes about extra tags and nine undocumented routes |
| 19 web, 4 worker, 1 realtime test commands | Blocked before test execution: `SAFETY_ABORT RECEIPT_REQUIRED` |

No newly executed test assertion failed. A guard rejection is neither a product test failure nor a pass. The application suite attempts deliberately omitted any inherited receipt so this general cleanup review could not reuse a receipt scoped to another operation. No bypass or live-database fallback was attempted.

Commands used: `pnpm --filter @annotationplatform/domain test`, `node --import tsx --test packages/queue/src/job-contract.test.ts`, `pnpm test:db-safety`, `pnpm --filter @annotationplatform/web lint`, `pnpm docs:validate-openapi`, and `pnpm --filter @annotationplatform/<workspace> exec tsc --noEmit --incremental false` for all five workspaces. Each application test entry was attempted through `node scripts/db-safety/cli.mjs test <catalog-command>`; exact commands and exit codes are in [results.json](/tmp/annotation-cleanup-review-d3aubpy5/results.json).

The nine OpenAPI notes concern `/api/ai/models/{modelId}/labels`, `/api/ai/tasks/{aiTaskId}/predictions`, `/api/assets/{assetId}/ai-results`, `/api/auth/preferences`, `/api/datasets/{datasetId}/assets/{assetId}/activity`, `/api/datasets/{datasetId}/modality-resolution`, `/api/health`, `/api/images/{imageId}/content`, and `/api/realtime/ticket`. The validator explicitly treats these as expected exclusions; they are not compiler/lint warnings.

## Concrete removal plan

1. **Generated files:** plan to untrack the **77** tracked dependency/cache/export paths in [untrack-generated-plan.json](/tmp/annotation-cleanup-review-d3aubpy5/untrack-generated-plan.json), keeping installed dependencies on disk. Existing `.gitignore` rules already cover them. Most are currently unchanged, so this is repository hygiene rather than a 77-file reduction in the initial dirty count. Do not delete `node_modules` to reduce the count.
2. **Passing tests:** [passing-test-removal-review.json](/tmp/annotation-cleanup-review-d3aubpy5/passing-test-removal-review.json) lists the **14** source files covered by successful independent test runs, including unchanged files. They meet the requested passing-test criterion, but **none has been established as unused**. Recommend keeping their regression coverage. Retiring them deliberately would also require updating package commands, imports and safety references; do not delete solely because assertions pass.
3. **Errors, warnings and blocked checks:** retain all application tests, their helpers, guarded launchers, and unresolved recovery evidence. Historical G3 failure and subsequent retry records must remain distinguishable from fresh results. Do not rerun saved `before/` source snapshots as active tests.
4. **Verification volume:** use [duplicate-evidence.json](/tmp/annotation-cleanup-review-d3aubpy5/duplicate-evidence.json) to prepare an external archive and compact run index. Before removing any loose evidence, verify archive hashes and retrieval, retain failed/warning runs and their required context, and update all Markdown links and executable/checksum references together. Current G2/G3 handoffs explicitly retain successful and failed receipts, and recovery verifiers consume saved evidence paths; passing logs are not yet standalone deletion candidates. An archive is a proposed next action, not an artifact created by this review.
5. **Preflight Compose:** retain `docker-compose.preflight.yaml`. Its old HTTP fixture runtime is intentionally disabled through `scripts/db-safety/deny.mjs`, and multiple quickstarts and the safety guide reference it. Removal is a separate retirement of that documented entry point, not removal of a passing test.
6. **Remaining verification:** application tests require newly provisioned isolated PostgreSQL/Redis/MinIO targets and fresh command-scoped receipts through the documented safety workflow. Historical HTTP suites remain unavailable without an isolated runtime scope. Recovery/candidate-migration rehearsals are operational workflows and were not replayed as cleanup tests. This review does not open a later implementation phase.

## Deliverables and next step

- Created: `docs/worktree-cleanup-review-2026-10-01.md`; private temporary logs and inventories linked above.
- Modified/deleted existing project files: none by this review.
- Environment variables: none added. A subsequent guarded integration run needs a fresh `DB_SAFETY_RECEIPT`; do not edit `.env`.
- Database migrations: none.
- Next recommended work: preserve the current concurrent work, untrack generated artifacts from the exact manifest, then separately archive verification evidence with reference updates. Keep passing regression tests unless their functionality is intentionally retired.

The complete path-by-path inventory is [inventory.json](/tmp/annotation-cleanup-review-d3aubpy5/inventory.json). Temporary files under `/tmp` are not durable audit storage; preserve the report and any needed diagnostics before clearing that directory.

## Cleanup executed — 2026-10-01

The authorized first cleanup pass removed generated-file noise from Git while preserving local evidence at its original paths. No tests, application code, migrations, environment files, generated Prisma files, containers or services were deleted or changed.

- Untracked **77** dependency/cache/export paths with `git rm --cached`. All **76** installed dependency/cache paths remain on disk; `repomix-output.xml` was already deleted before cleanup. These removals are staged and will stop being repository content when committed. Existing unrelated changes remain unstaged.
- Added narrowly scoped `.gitignore` rules for Phase 029 verification `.log`, `.json`, `.gz`, `.diff`, `.txt` and `.before` artifacts. Both passing and failing raw evidence stays available locally; Markdown reports, test/source files and SQL remain visible. Other phases are unaffected. These generated files will no longer be included in a normal `git add`.
- Archived **867** evidence files to `.data/cleanup-archives/20261001T032449Z/phase029-verification.tar.gz` (**7.45 MiB**) and verified every member against its SHA-256 manifest. None of those files changed during archive verification. The archive is a local snapshot, not an off-machine backup; future runs are not included. It may include sensitive diagnostics: keep it private and do not commit or publish it.
- Archive SHA-256: `a8e0c5e89743e3f66beb85c38ab0e122097114fe845c354ba2339181d30ac838`. The adjacent `manifest.json`, `summary.json`, and `generated-index-before.z` retain exact membership, execution results and previous index metadata.
- Git status decreased from **1484** to **725** changed/untracked paths, including the 77 staged removals. Concurrent work may change these counts.

Validation: archive hashes checked; all 76 previously present generated paths still exist; the export was confirmed absent in the initial status snapshot; no dependency/export paths remain tracked; ignore checks confirm logs/JSON are excluded while reports, tests and migrations remain visible. Runtime tests were not repeated for this Git-only cleanup. No new environment variables or migrations are needed.

Files modified by cleanup: `.gitignore` and this report. Files created: ignored local archive and manifests. Index changes: the 77 generated-file removals.

This pass reduces Git noise, not disk usage. Keep the local evidence for recovery tooling and existing links. Before physical removal or sharing this worktree, move the verified archive to durable private storage and arrange retrieval for consumers of the original paths. Passing regression test source remains in place. No later product phase was started.
