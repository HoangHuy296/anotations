# Research: Single-Asset and Bulk-Selection AI Preannotation

Date: 2026-09-24. Sources are the current worktree, not evidence of deployed behavior.

## Gate result

**ERROR / BLOCKED for implementation:** E1–E3 below require provider/deployment evidence. Platform design decisions are resolved, but the research exit gate is not passed. The accompanying design artifacts are reviewable drafts; their existence does not waive this gate.

| Gate | Available evidence | Required closure |
| --- | --- | --- |
| E1: deployed contract and limits | `docs/aioz-annotation-services.md` records OpenAPI/two-image confirmation on September 9 and video inspection on September 11; current adapter accepts scalar UUID model_id and sends files[] | Version-identifiable request/create/status/result evidence for deployed service; maximum inputs and payload/response budgets per enabled modality/model. 200 is only the platform ceiling, not a verified provider limit. |
| E2: completeness and identity | Notes describe exact image_path echo and one explicit result group per image, including zero detections; adapter uses URL digests | Confirm those guarantees for deployed version and enabled batch sizes; establish VIDEO batch support separately. Duplicate source objects must have distinct proven correlation or be rejected before POST. No positional/filename fallback. |
| E3: private download topology | Current signing TTL is 20 minutes; polling budget is 15 minutes; configuration uses MINIO_PUBLIC_ENDPOINT | Evidence from the actual AI-service network that private scoped downloads work, and documented maximum download delay supporting TTL. Worker-local connectivity is insufficient. |

Absent idempotency/lookup/cancellation guarantees are handled by fail-closed recovery, not assumed capabilities. Missing E1–E3 evidence prevents declaring planning ready for implementation. No private provider calls or live infrastructure validation were performed.

## 1. Target resolution and snapshot

**Decision:** Reuse Phase 022 selection schema and `buildAssetListWhere`, extend the shared resolver with a transaction-client/strict-resolution option rather than changing the behavior of existing bulk mutations. The AI caller deduplicates explicit IDs before enforcing the execution limit and rejects every missing, archived, deleted, out-of-Dataset or unauthorized member. Filtered resolution uses one ordered query with `take: effectiveLimit + 1`; reject the extra row, never accept a truncated list. Use deterministic `id ASC`, independent of UI sorting. Resolve and persist the snapshot within one Prisma transaction, with serialization conflicts retried a bounded number of times. Keep remote model/class discovery outside that transaction; recheck local active capability inside it.

**Rationale:** `asset-bulk-service.ts` currently counts then reads filtered IDs with take=max, so concurrent inserts can silently truncate. Explicit resolution does not filter archivedAt and returns notFoundIds for partial bulk actions. AI acceptance has stricter all-or-nothing semantics. Preview is advisory; creation re-resolves and compares an opaque digest of the preview context/membership/source identities, returning TARGET_CHANGED on mismatch. The digest is a freshness check, never authorization.

**Alternatives considered:** Browser-page IDs lose filtered/cross-page members; client counts are stale; accepting notFoundIds violates FR-007; a separately implemented filter language diverges from Phase 022.

## 2. Unified request and durable authority

**Decision:** Add current/bulk target variants to the existing AI endpoint; retain legacy assetIds through a mutually exclusive normalization branch. All variants enter the same resolver and service. Store versioned accepted input in Job.input, with AiTask.input a subordinate compatibility projection validated against it. Existing task creation currently leaves Job.input empty; this must be corrected for new versioned tasks. Historical tasks remain readable and their existing single-asset pipeline gets a guarded compatibility path.

**Rationale:** `ai-task-service.ts` already atomically creates Job + AiTask and enqueues only afterward. One task is selected by accepted target count, not by whether the UI used bulk mode. Durable membership must survive browser loss and enqueue interruption.

**Alternatives considered:** N single-asset requests, another bulk endpoint with separate execution logic, and Redis target storage violate the specification or architecture.

## 3. Provider boundary and correlation

**Decision:** Retain existing AIOZ adapter and submission reservation, with the executable scalar model_id schema as the draft baseline. Persist ordered Asset/source identities before submission and URL digests at reservation; generate signed links transiently. Validate a complete correlation envelope before any writes. Unknown/duplicate/ambiguous groups fail the envelope closed; missing accepted IDs are explicit failures, never empty successes. Independently identified groups may proceed only after E2 proves separation safe. Preserve explicit per-input empty results in the normalized contract.

**Rationale:** Current AiProviderStatusResult exposes flattened predictions; an empty list cannot distinguish all missing inputs from explicit empty output groups. Existing provider checks global cardinality; tests must preserve fail-closed behavior while introducing per-input outcomes.

**Alternatives considered:** Filenames are nonunique; position lacks a guarantee; persisting signed URLs leaks transient credentials; a URL digest is useful only when exact echo is guaranteed.

## 4. Per-Asset persistence and outcomes

**Decision:** Extend the existing image/video writers to commit one verified Asset at a time, including its durable outcome checkpoint in the same Prisma transaction. Fence the transaction on current Job lease/status/cancellation and a checkpoint generation in Job.state; then recheck source, access and workflow with existing guarded Asset revision writes. Prevalidate the entire Asset prediction set. Any failure rolls back all writes on that Asset. Aggregate only after every target has an outcome. Replayed success checkpoints produce no new annotations or revision increments.

**Rationale:** Current completion logic is tied to the task-level writer transaction; partial outcomes need a different completion boundary without a new Job lifecycle. JSON checkpoints fit the bounded maximum of 200. Source fingerprint/checksum plus canonical locator digest is distinct from Asset.revision, which may change for unrelated edits. If no stable source version can be established, reject eligibility.

**Alternatives considered:** One giant batch transaction prevents independent outcomes; one prediction per transaction can leave unreported partial writes; marking a frozen Asset as successful hides policy failure. No per-Asset Job table is needed.

## 5. Retry and cancellation

**Decision:** Extend `apps/web/src/lib/jobs/retry-job.ts` with an explicit AI allowlist. Use the existing unique retryOfJobId to create/reuse one successor, preserving accepted membership/configuration, successful checkpoint references and original external-task owner. Keep externalTaskId on its original AiTask because it is unique. A successor has its own AiTask with a validated reference to the original task and no duplicate externalTaskId; worker and poll scanner resolve that reference under the current Job lease. Predecessor terminal history is immutable. Known external results are repolled/reused; successful targets are inherited without writes. Definite pre-submission failure can submit once. An unknown submission cannot be retried until reconciled; record AIOZ_SUBMISSION_AMBIGUOUS and require recovery evidence. Known terminal remote failure without reusable results is not blindly resubmitted as recovery; a new intentional run is distinct.

**Rationale:** Generic retry currently excludes AI; adapter reservation already prevents same-task blind resubmit. Remote and local commits cannot be made atomic. Local cancellation fences writes, reports committed successes and marks remaining targets canceled; remote cancellation remains unsupported unless verified.

**Alternatives considered:** Copying externalTaskId violates its unique index; mutating failed predecessor loses history; clearing reservation risks duplicate external tasks; introducing a new partial-success enum violates FR-025.

## 6. Lifecycle and UI

**Decision:** Job is authoritative: all succeeded => COMPLETED / AiTask SUCCEEDED; any failed or skipped => FAILED / AiTask FAILED; cancellation => CANCELED / AiTask CANCELED after fencing and outcome reconciliation. Existing QUEUED, RUNNING, RETRYING and CANCELING keep their meanings. Extend safe task/Job reads to expose bounded per-Asset summaries for every terminal status, not only success. Existing prediction reads must permit successful outputs in failed/canceled operations under current Dataset authorization.

**Rationale:** `ai-detect-dialog.tsx` submits one asset and only handles completion callbacks on success. `ai-task-read-service.ts` lacks per-Asset outcomes. Selection-aware preview and aggregate display belong in this same panel; model discovery must use the resolved target modality, not the currently open Asset when bulk selection is active.

**Alternatives considered:** A second bulk panel fragments model controls; silently falling back from invalid bulk selection changes intent; a global Job Center redesign exceeds scope.

## 7. Tooling and phase constraints

**Decision:** No packages, schema migration, provider traffic, application edits or branch changes in planning. Use repository test runners and Prisma APIs. The constitution is an unratified template; AGENTS.md and Phase 0 documents govern. PowerShell setup is absent; the Bash counterpart was run and resolved feature 026. setup reports the configured feature name as BRANCH, while actual Git branch remains 025-text-workspace-engine. The agent-context updater is absent from the repository (hidden-file search included); report that workflow step as unavailable rather than inventing a script or rewriting governance.

**Alternatives considered:** Installing tooling or rewriting AGENTS.md merely to satisfy a missing script adds unrelated risk. Record the limitation in the completion report.

## Independent research attempt

The delegated worker/provider audit could not read the workspace because its sandbox failed and the escalated read did not complete. It supplied design cautions only, not independently verified findings. Repository observations above were verified by the primary agent's local reads. Its cautions are reflected in the drafts: unique external-task ownership, separate provider/result checkpoints, transactional generation/lease fencing, no provider calls in database transactions, and no blind ambiguous resubmission. No independent implementation or runtime verification is claimed.

## Decision register — `/speckit-analyze` reconciliation (2026-09-24)

These decisions close analysis findings I1, I2 and U1 as documented decisions. They do **not** close G1 (E1–E3 evidence) and do not authorize crossing T006.

### D-I1: plan and tasks consistency
`tasks.md` exists because the user requested a conditional breakdown; it is not evidence that the plan gate passed. `plan.md` now states this explicitly. The single stop gate is T006; T007 onward must not run while E1–E3 are open.

### D-I2: outcome of a review-frozen or otherwise skipped Asset
**Decision:** The unified path applies FR-026 to every operation, including a single-Asset one: any target finalized `SKIPPED` (for example `WORKFLOW_FROZEN`) makes the aggregate Job/AiTask `FAILED`, while its data-safety guarantees stay unchanged (no annotation, no status/revision change, no workflow event) and other successful Assets stay durable. Historical tasks created before this feature keep their recorded outcome through the legacy compatibility adapter; nothing is rewritten.

**Rationale:** FR-001/US1.4 require current-Asset and one-member bulk targets to behave equivalently, and FR-024/FR-026 forbid presenting a skipped Asset as successful inference. Today's writer `continue`s past a frozen Asset and the task still ends SUCCEEDED, which hides the skip.

**Consequence (deliberate contract change):** a frozen single Asset that used to finish "successfully with nothing written" now finishes FAILED with an explicit per-Asset SKIPPED reason. The existing test `late AI output preserves review-frozen Asset status, revision and workflow history` asserts only data safety (status, revision, annotation count, workflow events) and must pass unchanged. FR-031 is read as protecting tested single-Asset behavior, not the hidden-skip status projection; any other existing assertion that assumed SUCCEEDED is listed and changed explicitly in T032/T035, never silently.

**Alternatives considered:** keeping SUCCEEDED for a single-Asset skip (breaks equivalence and FR-024); adding a partial-success lifecycle state (prohibited by FR-025).

### D-U1: source identity and eligibility
**Decision:** `sourceIdentityDigest` = SHA-256 over a canonical tuple of `Asset.sourceFingerprint` (non-nullable), `currentVersionId`, `sourceRevision`, `sizeBytes`, `checksum`/`cacheChecksum` when present, and the selected object locator (original versus cache). Eligibility requires `sourceFingerprint`, `sizeBytes` and a storage locator; a checksum is not required.

**Rationale:** `Asset.checksum` is nullable, so requiring it would create a new ineligibility class the spec never states. `ensure-media-processing-job.ts` already imposes exactly this eligibility (`!sourceFingerprint || sizeBytes === null || no storage locator` → source missing) and already builds job input from these fields, so no asset class becomes ineligible beyond what media processing already rejects.

**Open verification (in T016, not assumed):** confirm how `sourceFingerprint` behaves when an UPLOAD-mode object is replaced (`upload-verification.ts`). If it does not change with the bytes, the digest must rely on checksum/locator and an Asset whose bytes cannot be distinguished is rejected with a safe reason.

### D-E1: environment hold
Phase 025 is uncommitted in the shared working tree and 026 touches shared files. Production-code tasks stay on hold until the user commits, stashes or isolates 025. The assistant performs no git history operations.

### Supplemental repository evidence (2026-09-24 audits)
Local reads that the earlier blocked delegate could not provide: the AiTask/Job/submit/poll/writer path is already N-asset-shaped (`AiTask.input.assetIds` array; one POST with `files[]`; a 2-asset real-database pipeline test); the writer already skips a frozen Asset per prediction; the AIOZ normalizer fails the whole task on any output-count mismatch (conflicts with per-Asset outcomes, addressed in T034); AI job retry returns 409 today (T044); Phase 022's resolver does partial-skip, live re-resolution and has no `ORDER BY` (T011). These are code facts, not deployed-provider evidence.


## Decision register — IMAGE detection v1 gate reconciliation (2026-09-24)

Source: the controlled provider run (`verification/provider-contract.md`, `source-access.md`, `correlation.md`, `recovery-contract.md`). Hard gates are limited to invariants that could cause incorrect Asset writes, duplicate external work, credential leakage or undefined provider-state handling.

### D-V1: v1 scope
IMAGE detection only. VIDEO/AUDIO are deferred until separate evidence; they are rejected with `AI_CAPABILITY_UNVERIFIED` and the UI states why. This supersedes the plan's "VIDEO conditional on verified support" for v1 closure (VIDEO stays a future extension, not a v1 gate).

### D-HG1: correlation stays a hard blocker
Exact `image_path` echo and matching order were observed at N=3 but the deployed OpenAPI types `output` as free-form objects, so neither echo nor order is contractual. **Decision:** no code may attribute predictions to Assets until a contractual or otherwise deterministic guarantee exists (documented contract, written vendor statement, or a stable input identifier in every group). Not waived; ordering is never inferred. Observed evidence is recorded but never substituted for the guarantee.

### D-FS: `failed_system`
Observed as an intermediate status (three `failed_system`→`inprocess` cycles before `failed`), absent from the adapter's closed enum. **Decision:** explicit allowlist — `create|pending` PENDING, `inprocess` IN_PROGRESS, `success` completed, `failed` terminal failure, `failed_system` non-terminal `PROVIDER_DEGRADED`, anything else fail closed. `PROVIDER_DEGRADED` keeps polling inside the existing budget, is recorded durably, never becomes success and never triggers resubmission; nothing assumes it is terminal or recoverable. Budget exhaustion ends as `AI_PROVIDER_FAILED_SYSTEM`. **Rationale:** treating it as terminal would discard possibly recoverable work; treating it as recoverable is unproven; bounded polling plus fail-closed satisfies both. **Open (closure evidence):** whether it can recover, and whether `error` is populated while it is active.

### D-NI: non-idempotent submission
An identical repeated POST created a second task; the service has no idempotency key, no lookup and no list route. **Decision:** at most one create call per submission reservation; a new reservation is allowed only after a definite rejection (an HTTP 4xx/422 response was received, so no task exists). Timeout, connection reset, unparseable response or crash after the reservation is AMBIGUOUS and terminal (`AI_SUBMISSION_AMBIGUOUS`): never re-POSTed, never retry-successor eligible; only a new deliberate operation may follow, with wording that external work may already exist.

### D-SAN: provider-error sanitization
Provider error text contained the complete signed URL. **Decision:** one sanitizer maps provider errors, 422 `detail` and response bodies to allowlisted codes before any persistence, log, API or UI output; error text is never parsed (not even to identify a failing input).

### D-LAYER: whole-batch provider failure versus per-Asset outcomes
An unreachable input failed the entire provider task with `output:null`. **Decision:** two layers. Provider layer: terminal failure fails the whole batch and every accepted target is finalized FAILED with the same sanitized code. Platform layer: after a successful provider result each Asset independently ends SUCCEEDED, SKIPPED (policy, e.g. frozen) or FAILED (write/validation), with per-Asset atomicity. Pre-dispatch source verification (existence/accessibility) reduces poisoned batches; a source that fails it rejects the whole dispatch (no smaller batch).

### D-LIM: limits
Two distinct numbers. **Platform selection ceiling:** 200 (`BULK_SYNC_MAX_ASSETS`), an input-shape/UI ceiling, not a provider claim. **Provider-verified v1 limit:** `AI_BATCH_VERIFIED_MAX_ASSETS`, initially **3** (the largest size actually exercised), raised only by recorded real runs (3 → 7 → next) that also re-check correlation. Effective limit = `min(200, verified)`. Production closure needs either a documented verified maximum or an explicit statement that the limit remains the verified value.

### D-STALE: stale local model registration
The local `AiModel` for YOLO26s_COCO uses provider id `0307ee22-…`, absent from the deployed catalog (422 on create); the deployed image/detection model is `68d7f474-…`. **Decision:** a read-only drift report before runtime proof; a model absent from the deployed catalog is not selectable; any sync that writes data needs the user's approval.

### D-CLOSE: closure evidence (not start gates)
Expired-link behavior, download time at the maximum batch, N>3, `failed_system` recoverability, reordered/unknown/partial group behavior, VIDEO/AUDIO, deployment build identity. Implementation must treat download/provider failure safely and never blind-retry creation.

**D-STALE finding (2026-09-24, `verification/model-catalog.md`):** the v1 model `68d7f474-…` is registered and active; one stale row (`0307ee22-…`) is absent from the deployed catalog. UI discovery already follows the deployed catalog, but `createAiTask` validates only the local row, so create must also verify deployed-catalog membership before creating a Job (T016/T019).
