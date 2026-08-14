# Feature Specification: AI Integration through BullMQ

**Feature Branch**: `020-ai-integration`

**Created**: 2026-08-12

**Status**: Draft

**Input**: User description: "AI Integration through BullMQ — Annotation Platform turns AI output into real Annotation records, using the locked Job/BullMQ architecture from Phase 0. The Job is the internal processing lifecycle; the AI Pre-Annotation Task is the business-level AI unit of work, tied one-to-one to its Job. The AI provider is always resolved through the AI Task's selected AI Model — never through the unrelated repository-source provider setting. AI predictions become new draft Annotations for human review; they never overwrite or delete manually created Annotations. Polling for AI results uses bounded retries with exponential backoff and a hard timeout, checks for user cancellation before contacting the AI provider, and guarantees only one worker processes a given task's progress at a time."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Request AI Pre-Annotation for a Dataset or Asset (Priority: P1)

A labeler or dataset manager selects one or more assets in a dataset, picks an available AI model, and requests AI-assisted pre-annotation. The system accepts the request immediately and, once the AI provider finishes processing, new draft annotations appear on the selected assets — clearly marked as AI-generated and ready for human review — without touching any annotation a person created by hand.

**Why this priority**: This is the entire value proposition of the feature: turning AI output into usable, reviewable annotations without endangering existing human work. Without this, there is no feature.

**Independent Test**: Submit a pre-annotation request for one asset with an active AI model, wait for the task to complete, and verify new draft annotations appear on that asset while any pre-existing manual annotations on it remain unchanged.

**Acceptance Scenarios**:

1. **Given** a dataset the actor is authorized to annotate and an active AI model, **When** the actor requests AI pre-annotation for one or more assets in that dataset, **Then** the system accepts the request immediately, returns a trackable task reference, and does not require the actor to wait for AI processing to finish.
2. **Given** an accepted AI pre-annotation task whose AI processing has completed successfully, **When** the system persists the results, **Then** each valid prediction becomes a new annotation on the correct asset, marked as AI-sourced and in a draft/needs-review state.
3. **Given** an asset that already has one or more manually created annotations, **When** an AI pre-annotation task completes for that asset, **Then** every manually created annotation on that asset remains exactly as it was — none are modified or removed.
4. **Given** a request naming assets that do not belong to the specified dataset, or naming a dataset the actor is not authorized to annotate, **When** the request is submitted, **Then** the system rejects it before any task, job, or external AI call is created.
5. **Given** a request naming an AI model that is currently disabled, **When** the request is submitted, **Then** the system rejects it and no task is created.

---

### User Story 2 - Track AI Task Status and See Failures Clearly (Priority: P2)

A user who submitted (or has access to) an AI pre-annotation task can check its current status at any time — queued, running, succeeded, failed, or canceled — instead of guessing whether it is still working. If the AI provider never responds or returns an error, the task ends in a clearly explained failed state rather than hanging forever.

**Why this priority**: Asynchronous AI processing is only trustworthy if users can see what's happening and are guaranteed an outcome. Without visible status and bounded waiting, users cannot rely on the feature for real work.

**Independent Test**: Submit a task, poll its status until it reaches a terminal state, and confirm the terminal state (succeeded or failed) and, on failure, a human-readable reason are both retrievable.

**Acceptance Scenarios**:

1. **Given** an AI pre-annotation task that has been accepted, **When** an authorized user checks its status before AI processing finishes, **Then** the system reports an in-progress state (queued or running).
2. **Given** an AI task whose external AI provider never returns a result, **When** the elapsed wait time or number of status checks reaches the configured maximum, **Then** the system stops checking, marks the task as failed with a timeout reason, and its associated processing job is also marked as not running (never left perpetually in progress).
3. **Given** an AI task whose provider reports an error, **When** the system next checks status, **Then** the task is marked failed with the provider's error captured for the user to see.
4. **Given** an AI task in progress, **When** the system checks for a result and none is ready yet, **Then** the next check happens after a wait that increases with each successive attempt up to a defined maximum wait, rather than checking continuously.

---

### User Story 3 - Choose From Available AI Models (Priority: P3)

Before requesting AI pre-annotation, a user can view the list of AI models currently available for use, including what kind of media (image, video, etc.) and what kind of task (e.g., object detection, transcription) each one supports, so they pick one appropriate for their dataset.

**Why this priority**: Users need to know their options before they can make a meaningful request, but this alone delivers no annotation value — it only supports Story 1.

**Independent Test**: Request the list of available AI models and verify only currently enabled models are returned, each with its supported media type and task type.

**Acceptance Scenarios**:

1. **Given** AI models exist in the system in both active and disabled states, **When** a user requests the list of available AI models, **Then** only active models are returned along with the media type and task type each supports.

---

### User Story 4 - Cancel an In-Progress AI Task (Priority: P4)

A user who no longer wants an in-progress AI pre-annotation task to continue (e.g., it was started by mistake, or is taking too long) can request cancellation. Once cancellation is requested, the system stops contacting the external AI provider for that task and finalizes it as canceled rather than completing it.

**Why this priority**: Valuable for cost control and correcting mistakes, but the platform is functional without it — cancellation is a refinement of Stories 1 and 2, not a precondition for them.

**Independent Test**: Submit a task, request cancellation while it is still in progress, and verify no further external AI calls occur for that task afterward and it settles into a canceled state.

**Acceptance Scenarios**:

1. **Given** an AI pre-annotation task that is still in progress, **When** an authorized user requests its cancellation, **Then** the next time the system would check the AI provider for that task, it instead finalizes the task as canceled without contacting the provider.
2. **Given** a task that has already reached a final state (succeeded, failed, or previously canceled), **When** a cancellation is requested, **Then** the system does not change the already-final outcome.

---

### Edge Cases

- What happens when two status checks for the same AI task are triggered around the same time (e.g., after a worker restart)? Only one must be allowed to process and finalize the task at a time; the other must back off without duplicating annotations or external calls.
- What happens when the AI provider's completed result references an asset that was not part of the original submitted set? That prediction must be discarded rather than turned into an annotation.
- What happens when the AI provider's completed result references a label that doesn't exist in the target dataset? The system must handle it gracefully (e.g., resolve or skip that prediction) rather than failing the entire task or crashing.
- What happens when a dataset or asset targeted by an AI task is deleted while the task is still in progress? The task must still reach a terminal state without leaving the system in an inconsistent or perpetually-running condition.
- What happens when the same assets are submitted for AI pre-annotation more than once? Each request is tracked as its own independent task; prior AI-generated draft annotations are left in place for the reviewer to manage.
- What happens if the request is accepted but the system loses connectivity before any background processing starts? The accepted task must still be durably recorded, so it is picked up and processed once connectivity is restored rather than silently lost.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow an authorized user to request AI pre-annotation for one or more assets within a dataset by selecting a specific, currently active AI model.
- **FR-002**: System MUST reject an AI pre-annotation request when any selected asset does not belong to the specified dataset, or when the requesting user is not authorized to annotate that dataset, before creating any task or contacting any external service.
- **FR-003**: System MUST reject an AI pre-annotation request that specifies a disabled/inactive AI model.
- **FR-004**: Every accepted AI pre-annotation request MUST be tracked as exactly one AI task, tied to exactly one internal processing job — never zero, never more than one of either.
- **FR-005**: The AI task and its processing job MUST be durably recorded before the system notifies any background processor or external provider, so a failure immediately after acceptance never loses the request.
- **FR-006**: System MUST acknowledge an accepted AI pre-annotation request immediately, without waiting for the AI provider to produce a result.
- **FR-007**: System MUST let authorized users retrieve the current status of an AI task (e.g., queued, running, succeeded, failed, canceled) at any time after submission.
- **FR-008**: System MUST let authorized users retrieve the list of currently active AI models, including the media type and task type each supports.
- **FR-009**: While an AI task is waiting on the external provider, system MUST re-check progress on a recurring schedule whose wait between checks increases with each attempt, up to a defined maximum wait, rather than checking continuously or at a fixed rate.
- **FR-010**: System MUST stop checking and mark an AI task as failed, with a timeout reason, once a defined maximum number of checks or a defined maximum total wait time is reached — an AI task must never be checked indefinitely.
- **FR-011**: System MUST check whether a user has requested cancellation of an AI task before contacting the external AI provider on each recurring check, so no further outside calls are made once cancellation has been requested.
- **FR-012**: System MUST allow an authorized user to request cancellation of an in-progress AI task.
- **FR-013**: System MUST guarantee that only one process finalizes or advances a given AI task's progress at any moment, even if multiple checks for the same task are triggered concurrently.
- **FR-014**: Upon successful AI completion, system MUST convert each valid prediction into a new annotation associated with the correct asset, marked as AI-sourced and in a draft/needs-review state pending human review.
- **FR-015**: System MUST discard predictions that reference an asset outside the task's originally submitted set instead of turning them into annotations.
- **FR-016**: System MUST NEVER modify or delete an annotation that a human created manually, regardless of any AI task's activity or outcome.
- **FR-017**: When an AI task fails (provider error or timeout), system MUST record a clear, retrievable failure reason and MUST ensure the associated processing job also reaches a non-running terminal state — never left perpetually queued or running.
- **FR-018**: System MUST record which AI model (and version, when known) produced each AI-sourced annotation, so its origin can be traced later.
- **FR-019**: The AI provider used for a given AI task MUST be determined solely from the AI model selected for that task. It MUST NEVER be inferred from, or written to, the unrelated source-provider setting used for repository imports — the two are separate concepts and must never be conflated.

### Key Entities

- **AI Pre-Annotation Task**: A tracked, business-level request to run AI-assisted labeling against one or more assets in a dataset. Has its own lifecycle (queued, running, succeeded, failed, canceled), references the AI Model used, the assets submitted, and — once complete — the predictions produced. Tied one-to-one with exactly one Processing Job.
- **Processing Job**: The platform's shared, generic unit of asynchronous work and lifecycle tracking (queueing, worker locking, progress, cancellation) already used across the platform for other background operations. Every AI Pre-Annotation Task has exactly one associated Processing Job, and every such Job exists to serve exactly one AI Pre-Annotation Task.
- **AI Model**: A configured, selectable AI capability that users choose when requesting pre-annotation. Belongs to an AI provider, supports a specific media type (or several) and task type, and can be active or disabled.
- **Annotation**: The platform's existing canonical labeled-shape record on an asset. AI pre-annotation only ever creates new annotations sourced from AI, left in a draft/needs-review state; it never edits or removes annotations sourced from manual human work.
- **Dataset / Asset**: Existing collections of media items that AI pre-annotation targets, scoped to what the requesting user is authorized to access.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users receive confirmation that an AI pre-annotation request was accepted within a couple of seconds, without waiting for AI processing to finish.
- **SC-002**: 100% of AI-generated annotations are created as new, clearly distinguishable draft suggestions; 0% of pre-existing manually created annotations are ever altered or removed by an AI task.
- **SC-003**: An AI task that never receives a usable result from the provider is automatically resolved into a failed state within a bounded, predictable time window rather than remaining pending indefinitely.
- **SC-004**: Users can retrieve the up-to-date status of any AI task they are authorized to view at any point in its lifecycle.
- **SC-005**: Once a user cancels an AI task, zero further external AI provider calls occur for that task.
- **SC-006**: Users can discover and choose among all currently enabled AI models suited to their dataset's media type before starting a task, with no disabled model ever appearing as a selectable option.
- **SC-007**: Concurrent or duplicate progress checks on the same AI task never result in duplicate annotations or duplicate external provider calls.

## Assumptions

- Any user who already holds permission to create manual annotations on a dataset is also authorized to request AI pre-annotation for that dataset; no separate AI-specific permission tier is introduced by this feature.
- The external AI provider is already reachable and its access is configured at the infrastructure level; provisioning or onboarding that external provider account is out of scope for this feature.
- Re-submitting AI pre-annotation for assets that already carry prior AI-generated draft annotations produces additional draft annotations rather than replacing or de-duplicating earlier ones; cleaning up unwanted drafts happens through the existing manual annotation review workflow.
- Specific numeric values for polling frequency, retry limits, backoff growth, and total timeout duration are operational tuning parameters to be set according to the external provider's expected response times; this specification only requires that such bounds exist and are enforced, not their exact values.
- This feature does not introduce dataset-level or organization-level quotas or rate limits on how many AI tasks may be submitted; usage governance beyond per-request authorization is a candidate for a future phase.
- Predictions from the AI provider that are malformed or reference something the system cannot resolve (e.g., an unrecognized asset or label) are skipped individually rather than failing the entire task.
