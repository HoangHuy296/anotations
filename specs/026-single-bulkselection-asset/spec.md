# Feature Specification: Single-Asset and Bulk-Selection AI Preannotation

**Feature Branch**: Not created; specification is independent of the existing `025-text-workspace-engine` branch.

**Feature Directory**: `specs/026-single-bulkselection-asset`

**Created**: 2026-09-24

**Status**: Draft — specification validated; ready for planning, not implementation approval.

**Input**: User request: “prepare for the 026-single-bulkselection-asset”, with [Dataset Bulk AI Inference feature description](input.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run AI on the current Asset (Priority: P1)

As an authorized annotator, I can use the existing AI Detection panel on the current Asset, choose a compatible model, classes and thresholds, and return later to its durable result. Single-Asset execution follows the same targeting, validation and execution rules as bulk execution.

**Why this priority**: Existing users must retain working AI Detection while the target-selection capability expands.

**Independent Test**: With no bulk selection active, run AI on one editable supported Asset. Verify one accepted operation, predictions on only that Asset, and the same durable outcome after refresh.

**Acceptance Scenarios**:

1. **Given** an editable Asset and no active bulk selection, **When** the annotator runs AI Detection, **Then** the panel identifies that Asset, the operation targets exactly it, and the chosen model, classes and thresholds are retained with the operation.
2. **Given** an unsupported modality or incompatible/inactive model, **When** execution is requested, **Then** the request is rejected with a useful safe reason before AI execution and no predictions are written.
3. **Given** an accepted operation, **When** the annotator reloads or leaves and returns, **Then** progress and persisted predictions remain available through the existing authorized views.
4. **Given** equivalent one-Asset current and bulk targets, **When** each is independently exercised in a fresh test, **Then** validation, prediction persistence, permissions and workflow behavior are equivalent.

---

### User Story 2 - Run one AI batch on the selected Assets (Priority: P1)

As an authorized annotator, I can use the existing Dataset selection controls to run one AI batch over explicitly selected Assets or all Assets matching a filter, without opening each Asset separately.

**Why this priority**: This delivers the central benefit: one configured action for the complete intended selection, including Assets outside the visible page.

**Independent Test**: Select seven same-modality Assets across multiple pages, run once, and verify that all seven belong to one durable batch and one external AI task. Repeat with a filtered selection spanning multiple pages.

**Acceptance Scenarios**:

1. **Given** seven eligible IMAGE Assets explicitly selected across pages, **When** the user opens the existing AI panel, **Then** it shows the verified selection count and modality and clearly offers execution for seven Assets using the existing model/class/threshold controls.
2. **Given** a filtered selection matching more than one page, **When** execution is accepted, **Then** every matching eligible Asset within the batch limit is included, not just visible rows.
3. **Given** selected Assets hidden by subsequent filters in explicit mode, **When** AI runs, **Then** those selected Assets remain included; in filtered mode, the current filter defines membership according to Phase 022 behavior.
4. **Given** IMAGE and VIDEO, or IMAGE and AUDIO, in the resolved selection, **When** execution is requested, **Then** the entire request is rejected before external task creation; no modality partition or current-Asset fallback occurs.
5. **Given** two VIDEO Assets, **When** a configured model/task with verified VIDEO batch support is selected, **Then** they can run as one batch; otherwise execution is unavailable with a reason.
6. **Given** an empty, oversized or partially unauthorized explicit target, **When** execution is requested, **Then** no smaller substitute batch is run. Unknown and unauthorized targets follow the existing concealment policy.
7. **Given** a bulk selection from another Dataset or a stale selected count, **When** the AI panel resolves its target, **Then** it cannot silently submit that stale context; the displayed target is corrected or execution is rejected before acceptance.

---

### User Story 3 - Recover and inspect one durable batch operation (Priority: P1)

As an operator or authorized requester, I can follow a batch through submission, processing and completion, understand failures, and recover work without losing its original target or duplicating successful outputs.

**Why this priority**: Bulk processing must remain understandable and safe when browsers disconnect, execution is interrupted, or the external service fails.

**Independent Test**: Submit several Assets, refresh the browser and interrupt execution at controlled stages. Verify durable targeting, progress, per-Asset outcomes and retry behavior through the existing operation views.

**Acceptance Scenarios**:

1. **Given** an accepted batch of N distinct Assets, **When** it is dispatched normally, **Then** one durable platform Job represents the operation and exactly one external AI task receives N inputs, rather than N independent tasks.
2. **Given** acceptance followed by delivery interruption, **When** normal recovery runs, **Then** the accepted operation can be found and resumed without reconstructing its authority from browser state.
3. **Given** a recorded external task identity, **When** execution is redelivered or resumed, **Then** that task is reused and completed outputs are not duplicated.
4. **Given** an ambiguous submission timeout, **When** external acceptance cannot be proved or disproved, **Then** the operation records the uncertainty and follows verified recovery semantics instead of blindly creating another external task.
5. **Given** submission, polling or result failure, **When** the user revisits the operation, **Then** the durable failure and sanitized reason remain available.
6. **Given** an authorized retry after partial success, **When** recovery completes, **Then** successful predictions are not duplicated or discarded, and failure history remains traceable to the original operation.
7. **Given** cancellation, **When** the existing cancellation boundary takes effect, **Then** no further predictions are committed by that operation; already committed results remain explicitly reported and remote computation is canceled only where supported.
8. **Given** private source files, **When** the external service downloads batch inputs, **Then** access succeeds without browser cookies or a public bucket; expired or unreachable access produces a durable failure with no signed-link or credential disclosure.
9. **Given** altered client file locations or revoked Dataset access, **When** submission or result access is attempted, **Then** the application rejects the unauthorized operation without fetching the supplied location or revealing concealed resources.

---

### User Story 4 - Receive correctly attributed, workflow-safe predictions (Priority: P1)

As an annotator or reviewer, I can trust that every prediction belongs to the intended Asset, that reviewed work is protected, and that partial outcomes show exactly which Assets succeeded or failed.

**Why this priority**: A batch is unsafe if correct-looking predictions can land on the wrong Asset or bypass review protection.

**Independent Test**: Run same-filename Assets with distinguishable content; exercise reordered, missing and malformed results and freeze one Asset before results arrive. Verify identity, per-Asset outcomes and review concurrency.

**Acceptance Scenarios**:

1. **Given** two different Assets with the same original filename, **When** results arrive in a different order from submission, **Then** predictions reach the correct Assets using verified correlation; where reordered results cannot be safely identified, they are rejected rather than guessed.
2. **Given** missing, duplicate, unexpected or ambiguous result identity, **When** results are processed, **Then** unverified results are not written, the discrepancy is durable, and a missing result is not reported as successful zero detections.
3. **Given** an explicitly confirmed zero-detection result for an Asset, **When** it is processed, **Then** that Asset is reported successful with zero predictions and no fabricated annotation.
4. **Given** an Asset editable at submission but review-frozen before persistence, **When** its predictions arrive, **Then** that Asset is not mutated and its reason is recorded; other independently verified, still-eligible results can succeed.
5. **Given** a successful prediction write and a reviewer holding an older Asset revision, **When** the reviewer attempts a stale decision, **Then** the existing workflow conflict rule rejects it.
6. **Given** one failed Asset and several successful Assets, **When** the batch becomes terminal, **Then** the user sees the correct per-Asset breakdown; neither overall failure nor overall completion hides the individual outcomes.
7. **Given** a committed prediction and duplicate execution delivery, **When** the same result is handled again, **Then** no duplicate prediction or spurious repeat content revision is introduced.
8. **Given** existing manual annotations and a result containing one malformed prediction, **When** an Asset's write fails validation, **Then** existing work remains unchanged and no unreported partial prediction set is committed on that Asset.
9. **Given** an accepted Asset whose source or authorization changes before a write, **When** delayed results arrive, **Then** the write is revalidated, rejected if no longer safe, and reported explicitly without mutating the wrong source.

### Edge Cases

- One selected Asset in bulk mode is a valid batch and follows the same rules as the current-Asset target.
- Repeated IDs resolve to one Asset and one input; duplicate IDs do not multiply inference or writes.
- A filter resolves to zero Assets, exceeds the effective batch limit, or changes between preview and acceptance.
- Membership changes after acceptance: newly matching Assets are not added to an already accepted operation.
- An explicitly selected Asset is deleted, archived, moved, or becomes inaccessible; the initial request is not silently reduced.
- An Asset becomes frozen, deleted, inaccessible, or changes source after acceptance; execution and persistence revalidate the relevant authority.
- A model is disabled or loses modality/task compatibility while a request waits to run.
- A model advertises multiple modalities but the selected Assets still must share exactly one supported modality.
- Selected classes become unavailable, or thresholds are malformed; reject without silently substituting configuration.
- Two Assets share a filename or underlying object; stable Asset correlation must remain unambiguous or submission is rejected.
- Private file access expires or is unreachable from the external service despite being reachable from the application host.
- The external service acknowledges submission but the worker loses the response before recording the task identity.
- Results contain an unknown input, multiple result groups for one input, a missing input, no detections, or malformed geometry.
- Cancellation races with result persistence; the existing atomic write/cancellation boundary governs which outputs may commit.
- Mixed success, failures and policy-skipped Assets must reconcile to the accepted target count without concealing any outcome.
- Authorized retry follows existing successor semantics and never blindly repeats a known successful external task or prediction write.

## Clarifications

### Session 2026-09-24 (analysis reconciliation)

- Q: Does a review-frozen or policy-skipped Asset make a single-Asset run unsuccessful? → A: Yes. FR-026 applies to every accepted operation: any skipped or failed target ends the aggregate unsuccessful, and successful targets remain visible. Data-safety behavior (no write to the frozen Asset) is unchanged; historical tasks keep their recorded outcome.
- Q: Which Assets are eligible with respect to source identity? → A: Any Asset with a stable source fingerprint, known size and a storage location — the same requirement media processing already applies. A checksum is not required for eligibility.

## Requirements *(mandatory)*

### Functional Requirements

#### Target selection and shared experience

- **FR-001**: The existing AI action MUST support the current Asset or the active Phase 022 bulk selection through one shared user flow and execution capability.
- **FR-002**: With no active bulk selection, execution MUST target only the current Asset. An invalid active selection MUST NOT silently fall back to that Asset.
- **FR-003**: Explicit and filtered selection MUST preserve existing cross-page, hidden-selection, filter-change and Dataset-scope behavior; display sorting and pagination MUST NOT determine membership.
- **FR-004**: The system MUST resolve targets authoritatively within the Dataset, remove duplicate membership, and establish a stable ordered target snapshot before accepting execution. Client counts, filenames, file locations or full Asset records MUST NOT be treated as target authority.
- **FR-005**: Accepted target membership and ordering MUST remain fixed for that operation. Later filter changes or newly matching Assets MUST NOT expand it; changes to already accepted Assets MUST be handled through revalidation and explicit outcomes.
- **FR-006**: The existing AI panel MUST show verified target mode, count, modality and invalidity reason, and identify the target count on its run action. It MUST reuse model discovery, class selection, confidence threshold, overlap threshold and existing feedback patterns rather than add a separate bulk configuration panel.
- **FR-007**: Empty targets, out-of-Dataset or unauthorized explicit members, initially ineligible Assets, and selections exceeding the effective limit MUST be rejected as a whole. The system MUST NOT truncate a selection or silently skip invalid members before accepting a smaller batch.
- **FR-008**: Every accepted selection MUST contain exactly one supported modality and use an active, compatible model/task. Mixed modalities MUST be rejected atomically, never partitioned into separate tasks. Multi-modality model support does not relax this rule.
- **FR-009**: One published effective batch limit MUST apply to both current/explicit and filtered targets. The initial default is at most 200 distinct Assets, further reduced by verified model/service limits; any different safe limit requires documented evidence before implementation. The UI MUST state the applicable limit when it prevents execution.

#### Durable execution and private access

- **FR-010**: A normally dispatched accepted batch MUST create one common durable platform Job and exactly one external AI task containing one input per accepted Asset. Single-Asset and bulk targeting MUST converge before execution; per-Asset fan-out and a second AI pipeline are prohibited.
- **FR-011**: The operation MUST retain its validated model/task configuration, target identity and order, requester, progress, retry history and safe outcomes so browser refresh and execution recovery do not lose authority.
- **FR-012**: Delivery MUST occur only after durable acceptance. Repeated delivery or recovery MUST reuse recorded external task identity and recorded outputs whenever available, without duplicating predictions.
- **FR-013**: External task submission, status/result retrieval, supported cancellation and correlation behavior MUST be verified against the actual service contract before implementation. Illustrative request fields and assumed result order MUST NOT substitute for evidence.
- **FR-014**: Before external submission, every accepted input MUST have a durable, unique correlation to exactly one Asset. Original filenames MUST NOT be identity. Returned stable identifiers are preferred; returned file locations or position MAY be used only when the service explicitly guarantees their correlation semantics.
- **FR-015**: Ambiguous, unknown, missing or conflicting result identities MUST fail safely, with no guessed attribution. Independently attributable outcomes MAY proceed only when the verified contract permits their separation. A zero-prediction success MUST be distinguishable from a missing result.
- **FR-016**: Source access MUST be resolved privately from canonical Asset storage and, when required, granted using temporary object-scoped access reachable by the AI Service for its documented download window. It MUST NOT depend on browser sessions, public buckets, permanent public links or client-supplied source URLs.
- **FR-017**: The operation MUST retain enough non-secret input mapping to recover and verify attribution. Credentials and signed query strings MUST NOT enter logs, browser-facing operation details or persistent correlation metadata; temporary file-access links are generated as needed rather than treated as durable identity.
- **FR-018**: Execution MUST revalidate accepted target availability, permissions and model/task compatibility before dispatch. If an accepted input cannot safely be submitted, the system MUST record the failure rather than submit an undisclosed smaller batch.

#### Prediction persistence and workflow integrity

- **FR-019**: Results MUST use the existing canonical AI prediction and annotation write capability, retaining existing AI-origin metadata, geometry authority, label references and revision semantics. Browser-only predictions MUST NOT become persistence authority.
- **FR-020**: Each Asset MUST be checked against its current access, source identity and workflow constraints at mutation time. Submission-time editability MUST NOT authorize a later write into a review-frozen, removed or otherwise ineligible Asset.
- **FR-021**: Successful content changes MUST invalidate older parent Asset revisions under the existing Phase 023 AI-write rule. Existing annotation optimistic locks MUST be preserved; failed or replayed writes MUST NOT produce new content revisions merely because delivery repeated.
- **FR-022**: Per-Asset persistence MUST have an explicit atomic outcome consistent with the canonical write path: failure MUST NOT leave an unreported partial prediction set on that Asset. The batch need not roll back previously successful Assets because another Asset fails.
- **FR-023**: Existing manual annotations and accepted work MUST be protected according to the current AI-write policy. This feature MUST NOT silently replace them or change Asset status/review semantics.

#### Outcomes, recovery and authorization

- **FR-024**: Every accepted Asset MUST have exactly one final reported outcome: succeeded (including explicit zero predictions), failed, skipped with a policy reason, or canceled. Counts MUST reconcile to the accepted target, and failed/skipped Assets MUST NOT be presented as successful inference.
- **FR-025**: Submission, polling, correlation and write failures MUST be durable and diagnosable through sanitized reasons. The existing Job state machine MUST be retained; partial success is expressed using per-Asset results and an aggregate summary, not an invented lifecycle state.
- **FR-026**: A fully successful batch is complete. A terminal uncanceled batch with failed or policy-skipped targets is unsuccessful overall while preserving and displaying its successful targets; canceled operations follow existing cancellation semantics. Planning MUST map these outcomes to current lifecycle values and existing read views.
- **FR-027**: Authorized retries MUST retain lineage and allowlisted recovery context under the common Job retry contract. Previously successful outputs MUST not be duplicated or lost. Uncertain external submission MUST be reconciled, or reported as requiring recovery, rather than retried blindly.
- **FR-028**: Cancellation MUST follow the existing operation rules, prevent further commits after cancellation takes effect, and retain already committed per-Asset outcomes. Remote cancellation is best-effort only when the provider supports it.
- **FR-029**: The system MUST enforce current Dataset access, selection authority, annotation permissions and model/task compatibility independently of disabled UI controls. Unknown and unauthorized resources MUST follow the existing concealment policy, including job/result access after permission revocation.
- **FR-030**: The browser MUST interact only with the authorized application for this workflow and MUST never receive external AI credentials or choose arbitrary locations for the worker to fetch. Public errors and outcomes MUST not disclose private storage or provider configuration.
- **FR-031**: Existing single-Asset tests MUST remain passing. Release verification MUST demonstrate multi-Asset execution through the real durable processing dependencies, one external batch submission, correct result attribution, and workflow-safe persistence; a green health check alone is insufficient.

### Key Entities *(include if feature involves data)*

- **Dataset**: Existing organizational and authorization scope for selected Assets, labels and AI operations.
- **Asset / Asset Selection**: Existing current-Asset, explicit-selection or filter-selection intent. The accepted operation retains an authoritative, distinct, ordered target snapshot.
- **AI Model and Task Configuration**: Existing model identity, supported modality/task, selected classes and thresholds, captured for the accepted operation.
- **Common Job and Existing AI Task**: The platform's durable operation and its existing AI integration record, linked to one external batch task; no separate bulk-only lifecycle authority.
- **Input Correlation**: Non-secret association between accepted input identity/order and exactly one Asset, sufficient to verify results and recover interrupted work. This is conceptual information, not a prescribed new persistence model.
- **Prediction / Annotation**: Existing canonical AI-origin records scoped to the correlated Asset, using current geometry, labels and optimistic revisions.
- **Per-Asset Outcome**: An Asset's success, failure, policy skip or cancellation, prediction count and safe reason, contributing to a reconciled batch summary.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In all acceptance fixtures, a current-Asset request affects exactly one intended Asset and retains the existing model/class/threshold behavior; all existing single-Asset regression tests pass.
- **SC-002**: For valid batches of 2 and 7 Assets and the published maximum, one run produces exactly one durable operation and one external AI task for N distinct inputs, with zero per-Asset task fan-out.
- **SC-003**: A filtered selection spanning at least three pages includes 100% of matching targets within the limit and zero unselected targets; explicit hidden selections retain 100% of their intended members.
- **SC-004**: All empty, mixed-modality, incompatible, unauthorized and over-limit acceptance cases are rejected before external execution, with zero prediction writes and an actionable safe explanation.
- **SC-005**: In duplicate-filename, reordered-result and malformed-correlation fixtures, zero predictions are attributed to the wrong Asset; unresolvable results receive explicit failure outcomes.
- **SC-006**: Every terminal batch reconciles 100% of its accepted Assets to final per-Asset outcomes, including confirmed zero-detection successes; refresh preserves the same counts and persisted predictions.
- **SC-007**: Delayed results produce zero writes to Assets that became review-frozen. Every successful content-changing AI write makes an older review decision fail under the existing conflict rule.
- **SC-008**: Controlled redelivery and recovery tests create zero duplicate committed predictions and zero additional external tasks when the original external task identity is already known.
- **SC-009**: In a usability check with five representative annotators, at least four can configure and submit a valid seven-Asset batch within two minutes, excluding inference time, and correctly identify its target count and failed Assets without assistance.
- **SC-010**: Under the documented acceptance-test load with dependencies available, at least 95% of valid runs up to the published batch limit show a durable operation reference within five seconds of submission, without waiting for inference completion.

## Assumptions

- The user-requested directory identifier is authoritative; no new git branch is required. Preparing this draft does not approve or implement Phase 026, or declare earlier unfinished work complete.
- This feature depends on existing AI integration (020), durable execution/recovery (007–009 and 021), Asset selection (022), and review/workflow integrity (023). Their authority and security rules remain binding.
- The project constitution file currently contains unfilled template placeholders. It supplies no additional adopted rules; `AGENTS.md` and the accepted architecture documents govern this specification.
- Version 1 enables only modality/model/task combinations whose existing integration and real batch contract are verified. IMAGE detection is the baseline; VIDEO is conditional on verified configured support. No new AUDIO/TEXT inference engine is implied.
- Initial eligibility is all-or-nothing. A filtered query contains only the members resolved by the server at acceptance; later membership changes do not alter that accepted snapshot. Independent per-Asset outcomes apply after acceptance, especially for delayed-result races.
- The default upper bound of 200 reuses the existing bounded selection resolver's default, not a claim that the provider supports 200 files. The effective limit is the lower verified service/model/platform limit, displayed consistently in the UI and enforced for all target forms.
- Aggregate unsuccessful/canceled outcomes must retain successful per-Asset results visibly. This draft does not add a partial-success lifecycle state or change existing retry, cancellation or revision semantics.
- An explicit newer user request is distinct from redelivery of the same accepted operation; recovery of an uncertain prior submission must never silently turn into a new request.
- Selection resolution, service contract evidence, source access topology and exact lifecycle mapping remain mandatory planning audits described in [planning constraints](planning-constraints.md), not unresolved product-scope questions or claims of runtime verification.
- The five-second acceptance-feedback target is a product acceptance baseline, not an inference completion guarantee. Planning must define the reproducible test load and record dependency conditions.
- Out of scope: mixed-modality partitioning; redesigning the AI Service, Phase 022 selection or global Job Center; a second AI pipeline; public storage; changed Asset status or annotation revision semantics; bypassed workflow freezes; realtime collaboration; unapproved packages.
