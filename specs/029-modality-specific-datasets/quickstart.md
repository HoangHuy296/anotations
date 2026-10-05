# Phase 029 validation guide

This is a future implementation validation guide, not an instruction to migrate now. Prerequisites: reviewed Phase029 implementation/migrations, isolated disposable database/storage, web and worker at compatible versions, existing environment configured without printing secrets. Never run seed/backfill against user datasets for these scenarios.

## Current planning-only check

Read `spec.md`, `research.md`, `plan.md`, `data-model.md`, and the contracts. Confirm `.specify/feature.json` targets this feature; actual Git branch may remain 025. Parse the saved audit with `python3 -m json.tool specs/029-modality-specific-datasets/audit-2026-09-29.json`. This does not refresh the database evidence.

## After implementation

From repository root:

```bash
pnpm db:validate
pnpm typecheck
pnpm lint
pnpm docs:validate-openapi
pnpm --filter @annotationplatform/web test:dataset-metadata
pnpm --filter @annotationplatform/web test:direct-upload
pnpm --filter @annotationplatform/web test:local-folder-import
pnpm --filter @annotationplatform/web test:repository-import-request
pnpm --filter @annotationplatform/web test:workspace
pnpm --filter @annotationplatform/web test:ai
pnpm --filter @annotationplatform/worker test:repository-import
pnpm --filter @annotationplatform/worker test:queue
pnpm build
```

Also run new Phase029 focused concurrency/migration suites and existing visualization tests using their registered commands once implementation defines them. No invented Phase029 command is assumed here. Validate migrations on disposable DB and prove rollback/replay before any production rollout.

## Browser/API scenarios

1. Create four explicitly selected empty Datasets; each shows its own engine without an Asset. Missing/invalid modality is rejected. No automatic IMAGE default.
2. Direct upload, local-folder new/append, repository fresh/replay and prepared completion: matching verified content succeeds, mismatched/ambiguous content cannot publish. Spoof extension/MIME and old client fields; server wins.
3. Choose modality/classes on imports/local-folder; use keyboard-only combobox and remove badges. Verify names, focus, active-descendant and Escape; no autofocus. Existing append modality cannot change.
4. Import valid content followed by incompatible content: valid assets remain; durable outcome is failed/incomplete with correct counts. Folder commit cannot silently omit rejected items.
5. Historical EMPTY/MIXED stay unchanged and block ingestion. Owner/system-admin explicit empty resolution succeeds only if still empty; MANAGER membership alone does not grant that command. A concurrent asset insert cannot defeat the guard.
6. Try Asset from another Dataset or modality in query/client state; no engine override. Test all COMPLETED/non-COMPLETED lifecycle destinations and reopened viewer guard.
7. Concurrent publish/backfill/reparent/restore and duplicate deliveries: no mismatched commit; retries preserve identities/revisions. Empty assigned Dataset cannot change modality, even after deleting its last Asset.
8. Permissions revoked, archived/deleted state, text policy/annotation revisions, AI unsupported modality and Phase028 mixed selection continue to fail safely.
9. Anchored CRUD panel stays beside its trigger, within viewport, single-open, keyboard-dismissible with focus return; verify existing APIs are unchanged. This separate UI discrepancy must be addressed before claiming that scenario passes.

Expected artifacts: safe test results, approved-ID dry-run evidence, migration/concurrency report, browser accessibility checks and explicit unsupported-classification limitations. No source bytes/provider credentials or raw Job inputs/results in reports.
