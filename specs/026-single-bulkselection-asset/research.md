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
