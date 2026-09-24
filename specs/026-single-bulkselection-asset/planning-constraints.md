# Phase 026 Planning Constraints and Evidence Gates

**Date**: 2026-09-24  
**Specification**: [spec.md](spec.md)  
**Original request**: [input.md](input.md)

This document preserves the supplied technical constraints outside the stakeholder specification. It records a read-only worktree inspection, not proof of the external AI Service contract or completion of an implementation plan.

## Binding architecture

- Reuse Next.js application authorization/validation, PostgreSQL with Prisma as common Job and annotation authority, BullMQ/Redis as `{ jobId }` transport only, MinIO private binaries and the private worker. No duplicate public backend, bulk-only Job store or browser-to-AI call.
- Extend existing AI orchestration and canonical prediction writers. The existing AiTask integration record is subordinate to its common Job; it is not a second bulk execution architecture.
- Queue messages never carry the selected Asset list, Job input, credentials, provider URLs or signed download URLs.
- Keep binary data out of PostgreSQL and secrets out of browser props/state, public errors, logs, Job input and queue payloads. Persist stable non-secret correlation, not expiring signed URLs.
- Annotation.geometry, Annotation.revision and Phase 023 Asset.revision/workflow guards remain authoritative. Retry uses one authorized linked successor and allowlisted recovery context; duplicate delivery of predecessor or successor must not duplicate predictions.
- Do not edit environment files, migrations, generated Prisma output or add packages during specification preparation.

Authorities: [AGENTS.md](../../AGENTS.md), [architecture](../../docs/architecture.md), [Job system](../../docs/job-system.md), [queue flow](../../docs/bullmq-postgres-job-flow.md), [clone/security boundaries](../../docs/clone-repository-plan.md), [phases](../../docs/phases.md).

## Observed worktree contracts

| Area | Evidence | Planning implication |
| --- | --- | --- |
| Client selection | `apps/web/src/stores/asset-selection-store.ts` uses NONE / EXPLICIT / FILTERED and treats filteredCount as display-only. | Reuse the store; do not materialize filtered membership in the browser or let another Dataset's selection leak into the request. |
| Selection request and resolution | `apps/web/src/lib/validation/asset-bulk.ts` and `apps/web/src/lib/assets/asset-bulk-service.ts` define existing explicit/filter forms and resolve against Dataset scope. Explicit request validation allows at most 1000 IDs; the default bounded resolver limit is 200 (`apps/web/src/types/workspace.ts`). | Reuse these contracts, document the effective AI limit, and distinguish an input-shape ceiling from a safe execution limit. Audit missing/archived explicit members, stable ordering and count/read races before reuse. |
| AI request/service | `apps/web/src/lib/validation/ai-task.ts` currently accepts datasetId, modelId, assetIds, classes and thresholds. `apps/web/src/lib/ai/ai-task-service.ts` creates one common Job and linked AiTask before enqueue. | Add target resolution before the existing path; do not make a second single/bulk execution implementation. Exact DTO names and compatibility for existing callers belong to planning. |
| Existing Job lifecycle | `prisma/schema.prisma` declares QUEUED, RUNNING, RETRYING, COMPLETED, FAILED, CANCELING and CANCELED. | No COMPLETED_WITH_ERRORS addition. Specify how a failed aggregate still exposes successful per-Asset outcomes through existing reads. |
| External submission | `apps/worker/src/providers/ai/aioz-annotation-services-provider.ts` already sends one `files` array. Its current schema uses scalar UUID `model_id`, IMAGE/VIDEO with detection/tracking; the supplied illustrative request uses an array for model_id. | Do not copy the illustration as an authoritative service schema. Verify actual versioned request/model/task contracts and supported combinations. |
| Input resources | `apps/worker/src/providers/ai/aioz-task-resources.ts` signs objects server-side and retains an Asset-to-URL-digest manifest before submission. | Audit/reuse existing signing, submission reservation and recovery. A persisted digest avoids storing a signed URL but does not itself prove the provider returns an unchanged URL. |
| Result correlation | The existing provider maps returned `image_path` / `video_path` URL digests back to submitted Assets. | Require authoritative evidence for exact returned URL identity, completeness and grouping. Prefer stable input identifiers where supported; positional mapping requires an explicit ordering guarantee. Same filenames are never sufficient. |
| Submit/poll/cancel | `apps/worker/src/jobs/ai-submit.processor.ts`, `ai-poll.processor.ts`, `apps/worker/src/queue/ai-poll-scanner.ts`, and `packages/domain/src/ai-provider.ts`. | Reuse durable submit/poll flow, known external IDs and optional cancellation. Audit uncertain-submit recovery and cancellation/write races. |
| Prediction writes | `apps/worker/src/jobs/ai-prediction-writer.ts`, `ai-video-prediction-writer.ts`, and Phase 023 workflow guards. | Audit current transaction boundaries and parent revision behavior before extending per-Asset outcomes. Do not assume that normalized predictions alone describe missing versus zero-result Assets. |

## Required research before implementation

1. Obtain authoritative request/create-response/status/result/cancellation evidence for the deployed AI Service version. Record scalar versus array model selection, supported task/modality combinations, batch size/payload limits and download timing. Do not contact private providers from the browser.
2. Prove correlation for each accepted input, including reordered outputs, same filenames, duplicate source objects, missing outputs and explicit zero detections. Identify what evidence supports the selected identity scheme. If guarantees are absent, record an implementation blocker rather than infer ordering or weaken correctness.
3. Audit Phase 022 server resolution reuse, archive/deletion handling, duplicates, deterministic order, snapshot acceptance under concurrent changes, limits and preview/acceptance consistency. Preserve filtered selection beyond the current page.
4. Audit MinIO signing and actual network reachability from the AI Service, not only localhost or the worker. Determine a safe TTL using download timing. Never log signed query strings or credentials.
5. Map aggregate and per-Asset success/failure/skipped/canceled outcomes onto current Job/AiTask state and result metadata. Document atomic per-Asset writes, permission/workflow/source rechecks, stale reviewer rejection and zero-result handling.
6. Verify submission reservation, external idempotency/reconciliation, delivery redelivery, polling recovery, authorized successor retry and cancellation. Demonstrate that an ambiguous timeout cannot create a duplicate external task by a blind retry.
7. Identify exact affected contracts and regression coverage, including old single-Asset callers. Planning may propose a safely justified different batch limit; it must be documented and reflected in the specification before implementation.

## Required release evidence

- Real PostgreSQL, Redis/BullMQ, MinIO and private worker execution with multiple Assets producing one external create-task request containing N files and exactly one normal external task.
- A verified real-service or authoritative recorded contract establishing request fields and correlation guarantees; test doubles alone are insufficient evidence for those guarantees.
- Single-Asset regression, explicit and filtered multi-page selection, invalid target rejection, limits, permissions and concealment.
- Out-of-order/same-filename correlation, unknown/duplicate/missing result handling, explicit zero predictions, partial persistence outcomes and safe diagnostics.
- Delayed review freeze, stale reviewer rejection, no duplicate writes on replay/retry, and cancellation races.
- Browser verification of authoritative count/modality, one shared configuration panel, run action wording, refresh recovery and per-Asset summaries.

## Preparation status

- Requested directory: `specs/026-single-bulkselection-asset`.
- Active template resolution: `specify preset resolve spec-template` resolved the core `.specify/templates/spec-template.md`.
- No `.specify/extensions.yml` exists; before/after hooks are absent and skipped.
- `.specify/memory/constitution.md` remains an unratified placeholder template; it was read and not rewritten.
- No git branch created/switched and no application worktree changes made by specification preparation.
- External contracts, running infrastructure, and Phase 026 feasibility at the provider's maximum scale have not been verified in this step. Planning is the next step; implementation and earlier-phase completion are not implied.
