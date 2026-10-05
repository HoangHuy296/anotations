# Implementation Plan: Phase 029 — Modality-Specific Datasets

**Feature context:** `029-modality-specific-datasets`  
**Actual Git branch:** `025-text-workspace-engine` (unchanged; no branch created)  
**Date:** 2026-09-29  
**Spec:** [spec.md](./spec.md)  
**Status:** DESIGN DRAFT — planning policies confirmed; implementation/release gates remain. Not an implementation authorization.

## Summary

Add nullable `Dataset.modality` using the existing Modality enum, require an explicit modality for every new Dataset, validate classified asset content against its parent at every publication boundary, and eventually resolve `/workspace/{datasetId}` solely from the authorized Dataset. Preserve the central Dataset identity, lifecycle resolver, RBAC, revisions, Job model, private worker and `{ jobId }` queue transport. Preserve Phase 028 format/asset defenses and visualization snapshot immutability.

This check establishes the implementation sequence and records risks. The user confirmed conservative historical and incomplete-import policies during this run. This does not run a backfill, select a modality for an empty Dataset, or implement workspace/UI changes. The user's anchored CRUD panel requirement is an independent UI acceptance constraint; this planning run must not recenter or change its actions.

## Technical Context

- **Language/version:** TypeScript 5.x, Node.js runtime; Next.js 16.2.9 App Router, React 19.2.4.
- **Dependencies:** existing Prisma 6.19.3, Zod 4, BullMQ 5, MinIO client, React workspace registry and Tailwind 4; no package installation proposed.
- **Storage:** PostgreSQL/Prisma domain and durable Job authority; MinIO binaries; Redis queue transport only. No new modality-specific persistence stack.
- **Testing:** Node test runner/tsx, Vitest, web/worker typecheck, existing integration suites, disposable authenticated browser smoke; migration/concurrency tests require separately approved implementation and isolated DB.
- **Platform/project:** Linux-hosted monorepo; Next.js public web/API and private worker.
- **Performance goals:** no media probing in workspace GET; engine determination from one authorized Dataset projection; preserve bounded asset queries. Ingestion probes must have explicit byte/time limits before implementation; no invented latency SLA.
- **Scope:** three live Dataset creation boundaries, two shared source Asset publishers, dormant legacy importer to fence; current saved audit has 116 Datasets and 609 Assets. Counts are dated evidence, not a fresh migration manifest.
- **Constraints:** no mutation to established modality through ordinary PATCH; no default IMAGE; no asset/client/extension-derived engine; all archived/deleted children considered for final invariant; no automatic split/delete/reparent/annotation rewrite.
- **Resolved planning choices:** owner/admin-only EMPTY resolution, unresolved ingestion blocked, late mismatch retains valid assets and reports incomplete import, uncertain classification rejected, no invented recommendations. See research decision register for bounded support and release gates.

## Constitution Check

`.specify/memory/constitution.md` is an unratified placeholder template. Its bracketed principles are not product rules; do not fabricate ratification or amend it during this plan. Apply explicit user requirements and AGENTS.md plus Phase 0 architecture authorities. The requested future Dataset-driven routing supersedes the earlier Asset-driven rule for the planned phase only; document that amendment during approved implementation.

| Gate | Pre-research | Post-research/check |
| --- | --- | --- |
| One Next.js public backend; Prisma domain authority | PASS | PASS |
| Private worker/common Job/BullMQ `{ jobId }` | PASS | PASS |
| No data/schema/migration/source edits during planning | PASS | PASS |
| Current lifecycle, permissions, revisions and snapshots preserved | PASS | PASS by design; implementation tests pending |
| All source publishers identified; no extension-only final classification | Review | PASS for design: stream-based worker classification, uncertain web completion rejected; implementation parity gate remains |
| Race-safe historical assignment | Review | PASS for design: drain legacy writers + shared Serializable protocol; concurrency proof is a release gate |
| Historical policies explicitly decided | Pending | PASS: user explicitly confirmed conservative historical and incomplete-import policies |
| Final equality versus fixed modality distinguished | Review | PASS in research: FK alone is insufficient for empty-dataset fixedness |
| Agent-context updater available | Pending | TOOLING LIMITATION: script absent in both script locations; no governance file overwritten |

No violations are waived. Initial policy ERROR gates were resolved by explicit user answers. Planning may proceed with fail-closed classification and conservative recommendation defaults. Implementation must still stop on unmet release gates; no trigger SQL, backfill, or production compatibility claim is approved by generating these contracts.

## Project Structure

Planning artifacts:

```text
specs/029-modality-specific-datasets/
├── spec.md                        # existing audit/spec; preserved
├── audit-2026-09-29.json          # existing evidence; preserved
├── plan.md                       # this draft and gate report
├── research.md                   # decisions, risks, release gates
├── data-model.md
├── contracts/
└── quickstart.md
```

Design outputs include `data-model.md`, `contracts/creation-ingestion.md`, `contracts/workspace-ui.md`, `contracts/migration-rollout.md`, and `quickstart.md`. No `tasks.md` is generated by this command.

Proposed implementation ownership (not created now):

```text
prisma/schema.prisma + new additive migrations only
packages/domain/src/              # pure modality compatibility/classification contracts
apps/web/src/lib/                 # authorized Dataset read/creation, upload and import guards
apps/web/src/app/api/              # existing creation/ingestion routes and safe DTOs
apps/web/src/app/(app)/workspace/  # Dataset context and engine dispatch
apps/web/src/components/imports/   # modality + taxonomy selection
apps/web/src/components/workspace/# context/selection split and empty engines
apps/worker/src/jobs/              # repository verification + guarded publication/replay
scripts/                          # later reviewed dry-run/backfill tooling, Prisma-only
specs/api/                        # contract updates with implementation
```

Reuse `spec.md` section 3 as the writer inventory; re-run production create/upsert/nested-write searches before enforcement ships. Do not introduce a parallel viewer backend or copy reference-app architecture.

## Proposed delivery sequence and exit gates

1. **Policy/design completion:** apply the confirmed register in research; inspect available worker media probing tools; design exact stable-source verification and bounds. Preserve read-only unavailable states for evidence gaps. Planning policy gates are now clear; implementation release gates remain.
2. **Expand migration:** reviewed additive nullable `Dataset.modality`, no default and no blind backfill. Normal Prisma generation only after authorization; preserve existing migrations. Keep `primaryModality`/type for compatibility as non-authoritative fields.
3. **Coordinated compatibility deployment:** new creation requires modality at generic, repository, and local-folder entry points; append reads parent. Include modality/taxonomy in idempotency identity. Upgrade web and worker together; inventory in-flight prepared imports/old jobs. Old writers must be drained/stopped or explicitly fenced before an assignment can occur.
4. **All publisher enforcement:** direct + prepared upload share `publishUploadedAsset`; repository fresh/upsert/reconciliation/retry validate actual classification and current parent; dormant `persistDatasetImport` remains fenced. Fail before incompatible Asset/subtype creation. Validate any future reparent/restore/nested write. Preserve legitimate workflow/dimension/revision writes.
5. **Historical dry-run then approved assignment:** repeat DB/media audit, match source identity, verify all child modalities including archived/deleted. Do not treat existing Redis quiescence as the serialization protocol. Use a tested all-writer Serializable strategy with retries and/or approved DB enforcement; separate source storage identity race from DB row race. Execute only explicitly approved unambiguous IDs. EMPTY and MIXED remain unresolved until their confirmed policy is applied through separately reviewed and authorized resolution work.
6. **Dataset-driven engine context:** server authentication + Dataset access/lifecycle, explicit modality, nullable selected Asset. Registry engine from Dataset only. Empty Dataset renders deterministic engine capabilities. Wrong Asset/query modality fails closed. Unresolved Dataset must not silently use first/current Asset at the switch gate.
7. **Database backstop and required field:** evaluate final composite FK after historical null/mismatch resolution. Separately enforce fixedness, especially empty datasets. Any custom trigger SQL requires Phase029-specific approval. Only then consider NOT NULL and retirement of old write contracts.
8. **Regression/release validation:** preserve Phase022–028 and visualization behavior. Audit revision/permission/source identities, retries, queue payloads and source change races. Publish migration evidence and rollback constraints before deployment.

Stages 3–4 must protect new data before backfill, not after. Engine-switch readiness and final NOT NULL readiness are distinct; unresolved legacy records must be explicit. This sequence does not claim a permanent MIXED exception satisfies the final invariant.

## UI and workflow preservation

- Keep `/datasets` as the only catalog, exact COMPLETED → visualization; other workflow states → workspace.
- `/datasets/imports` and `/datasets/local-folder` gain explicit modality selection only during implementation. Recommended classes remain user-confirmed taxonomy. Use labeled combobox/listbox/option semantics, input-held focus/active descendant, keyboard navigation and no autofocus on mount.
- CRUD panel should be anchored beside the trigger with collision/viewport handling, one active panel, outside/Escape dismissal, focus restoration, unchanged existing APIs/permissions. **Current-check discrepancy:** `dataset-row-actions.tsx` still uses `showModal()` with `fixed inset-0 m-auto`, so the claimed anchored refactor is not present in this checkout. Record and resolve in separate UI work; no positioning changes are made here.
- Do not seed IMAGE labels from a generic workspace read for non-image Datasets. Existing label references/colors/scope rules survive; read-only callers must not acquire taxonomy mutation privileges.

## Validation and rollback plan

Future quickstart must cover four explicit empty datasets, every ingestion writer, spoofed extension/MIME, ambiguous media, duplicate/retry, old jobs, stale selection URLs, archived/deleted targets, revocation, import partial outcomes, labels and revision workflow. Concurrency fixtures must include two writers plus null→modality assignment, parent mutation on an empty dataset, reparenting and source-object replacement. Test no mismatch commit, stable IDs, safe errors and no silent omissions.

Existing commands to incorporate after implementation: root `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm db:validate`, `pnpm docs:validate-openapi`; web dataset-metadata/direct-upload/local-folder/repository-import/workspace/AI/visualization suites; worker repository-import/queue suites. A migration or seed is not a planning validation command. No runtime commands or DB audit were repeated in this documentation-only check.

Rollback retains additive schema/data values, pauses incompatible old ingestion, and never undoes assignments by rewriting Assets/Annotations. Constraint/NOT NULL rollback requires its own reviewed migration. No permanent trust in cached/client modality.

## Complexity Tracking

No second service/model or package is justified. Additional serialization/constraint machinery is justified only by demonstrated concurrent writer/backfill races; use existing typed transaction facilities where sufficient and obtain explicit approval for any custom migration SQL.

## Workflow execution record

- Pre-hooks: `.specify/extensions.yml` absent; none dispatched.
- PowerShell setup path absent; used installed Bash equivalent with explicit absolute Phase029 feature directory.
- Setup JSON: FEATURE_SPEC `specs/029-modality-specific-datasets/spec.md`; IMPL_PLAN this file; SPECS_DIR this directory; reported feature context `029-modality-specific-datasets`. Actual Git branch remains `025-text-workspace-engine`.
- Setup updated `.specify/feature.json` from Phase026 to Phase029; no checkout or commit performed.
- Agent context updater absent from installed scripts and repository search. No substitute script invented and AGENTS.md not overwritten.
- Post-hooks checked: extensions file absent; none dispatched.
- Result: plan, research, data model, contracts and validation guide generated. No tasks or implementation. Agent-context automation could not run because its script is absent; this tooling limitation is reported rather than silently replaced.

## Final review proposal (2026-09-30)

[implementation-review.md](./implementation-review.md) refines the baseline into the proposed Prisma delta, named DB guards/fence protocol, owner/admin EMPTY endpoint, behavior matrix, partial-result contract and release criteria. It supersedes the earlier list of enforcement alternatives for review purposes only. Custom SQL, schema and backfill remain unexecuted and require the approvals listed there.
