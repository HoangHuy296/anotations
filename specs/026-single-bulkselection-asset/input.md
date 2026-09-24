Feature Specification --- Dataset Bulk AI Inference

Feature: Bulk AI Preannotation / Bulk AI Detection
Status: Draft for implementation
Primary goal: Extend the existing single-asset AI Detection flow so
one platform request can target either the current Asset or a Phase 022
bulk selection, while the worker sends exactly one batch task to the AI
Service when all selected Assets share one supported modality.

1. Problem

Annotation Platform already loads AI models from the AI Service and
supports AI Detection for a current Asset. The AI Service batch task
contract accepts files[], so a dataset bulk selection must not be
implemented as N independent calls.

The platform must reuse the existing durable architecture:

Browser → Annotation Platform API → PostgreSQL Job → BullMQ {jobId} →
Worker → AI Service.

PostgreSQL remains authoritative. Redis/BullMQ remains transport only.
The browser must not call the AI Service directly.

2. User stories

US1 --- Run AI on the current Asset

As an annotator, I can run the existing AI action on the current Asset.
The implementation uses the same target-resolution and execution
pipeline as bulk AI.

US2 --- Run AI on selected Assets

As an authorized user, I can select multiple Assets using the existing
Phase 022 selection model and run one AI task when all resolved Assets
have the same supported modality.

US3 --- Durable batch execution

As an operator, I can see a durable platform Job for the batch. The
worker resolves authoritative Assets, creates AI-accessible file URLs,
submits one AI Service task, polls it through the existing AI
integration, and persists results.

US4 --- Correct per-Asset prediction persistence

As an annotator/reviewer, predictions returned for a batch are mapped to
the correct Asset and written through the canonical annotation mutation
layer without bypassing workflow/revision rules.

3. Canonical platform request

Conceptual client target:

type AiDetectionTarget =
  | {
      mode: "CURRENT_ASSET"
      assetId: string
    }
  | {
      mode: "BULK_SELECTION"
      selection: AssetSelection
    }

The exact DTO names and Phase 022 selection shape MUST reuse the
repository's existing contracts.

The backend resolves either form to an authoritative ordered Asset[].
The client must not submit arbitrary resolved Assets as authority.

4. AI Service batch contract

The integration must adapt the existing AI Service task-create contract,
conceptually:

{
  "type": "image",
  "task_name": "detection",
  "files": [
    "https://storage.example/asset-a",
    "https://storage.example/asset-b"
  ],
  "model_id": ["model-id"],
  "classes": ["person", "bicycle", "car"],
  "confidence_threshold": 0.5,
  "iou_threshold": 0.5
}

Before implementation, audit the actual request, response,
status/result, cancellation, and correlation contracts. Do not assume
result ordering or field names without evidence.

5. Selection rules

Bulk execution is allowed only when the authoritative resolved
selection:

is non-empty;

belongs to the target Dataset;

contains Assets the actor is authorized to use;

contains exactly one modality;

uses a model/task compatible with that modality;

is within existing platform limits, or a newly documented safe limit
if one is required.

Mixed modality is rejected atomically. Version 1 MUST NOT silently
partition mixed selections into multiple AI tasks.

Examples:

IMAGE + IMAGE → allowed for compatible image task.

VIDEO + VIDEO → allowed only if the configured AI task/model
supports VIDEO.

IMAGE + VIDEO → reject.

IMAGE + AUDIO → reject.

EXPLICIT and FILTERED selection MUST reuse Phase 022 server-side
resolution. A filtered selection must not be reduced to the current
visible page by the browser.

6. Unified execution path

Single and bulk targets converge before execution:

CURRENT_ASSET ─┐
               ├─> resolve target -> ordered Asset[]
BULK_SELECTION ┘
                         |
                         v
                  validate modality/model
                         |
                         v
                 create durable platform Job
                         |
                         v
                    BullMQ {jobId}
                         |
                         v
                       Worker
                         |
                         v
              one AI Service batch task

Do not maintain separate single-asset and bulk AI implementations.

7. Storage and file access

The worker resolves each Asset's canonical storage object. If the AI
Service requires URLs, generate server-side short-lived URLs that the AI
Service can actually reach.

Requirements:

no browser session/cookie dependency;

no public bucket requirement;

no permanent public URL;

TTL sufficient for AI Service download;

do not log signed query strings or credentials;

do not trust a client-provided file URL as storage authority.

Audit the current MinIO/presigned-URL utilities and network topology
before adding new code.

8. Correlation invariant

Every external input MUST be durably correlated to exactly one Asset
before submission.

Conceptually:

type AiBatchInput = {
  index: number
  assetId: string
  storageKey: string
  externalFileUrl: string
}

Do not use original filename as identity.

The implementation MUST audit how AI Service results identify inputs:

stable returned file/input identifier --- preferred if available;

exact returned URL/key --- only if contract guarantees it;

positional mapping --- only if AI Service explicitly guarantees
output order.

Persist enough non-secret mapping data with the platform Job/result
metadata to recover and verify correlation. Do not persist expiring
signed URLs unless the current Job model requires it; prefer stable
internal identity plus an explicit external input identifier/index.

9. Annotation persistence

AI results MUST pass through the existing canonical AI
prediction/annotation write path.

For every affected Asset:

re-check current workflow state at mutation time;

do not write into review-frozen Assets;

preserve existing Annotation revision semantics;

increment parent Asset revision according to the existing Phase 023
AI-write invariant;

do not create frontend-only predictions as persistence authority;

keep AI-origin metadata according to the existing annotation domain
contract.

A job created while an Asset was editable does not gain permission to
mutate it later if the Asset becomes frozen before results arrive.

10. Failure semantics

The implementation MUST audit the existing Job state machine before
adding states.

Required behavior:

task submission failure is durable and retry/recovery compatible;

polling/result failure is durable;

per-Asset result/write failure is recorded explicitly;

successful Assets are not silently reported as failed;

failed Assets are not silently reported as successful;

do not add COMPLETED_WITH_ERRORS unless it fits the existing Job
model.

If the current Job model lacks a partial-success state, represent the
per-Asset outcome in existing Job result/metadata while preserving the
current state machine.

11. UI

When no bulk selection is active, AI Detection continues to target the
current Asset.

When a compatible bulk selection is active, the AI panel displays the
authoritative selection context, e.g. 7 IMAGE assets selected, and the
run action clearly states the count.

Reuse:

existing AI model list;

model classes;

confidence threshold;

IoU threshold;

existing error/loading primitives;

Phase 022 selection store.

Do not create a second AI configuration panel solely for bulk.

Mixed or otherwise invalid selection must disable/reject execution with
a useful reason. Server validation remains authoritative.

12. Security and authorization

Server must verify Dataset access, Asset selection, model/task
compatibility, workflow constraints, and storage resolution.
Unknown/unauthorized resources follow existing concealment policy.

The browser must never receive AI Service credentials. The browser must
not be allowed to provide arbitrary storage URLs for worker fetching.

13. Non-goals

This feature does NOT:

partition mixed modalities into multiple AI tasks;

redesign AI Service;

redesign Phase 022 selection;

create a second AI job pipeline;

make MinIO public;

change Asset.status semantics;

change Annotation.revision semantics;

bypass Phase 023 workflow freeze;

add realtime collaboration;

redesign the global Job Center;

add new packages without approval.

14. Acceptance criteria

Current Asset AI Detection still works.

Selecting N same-modality Assets can create one platform AI Job.

Worker sends one AI Service create-task request containing N files.

Mixed-modality selection is rejected before external task creation.

FILTERED selection is resolved server-side and is not limited to the
visible page.

Every AI result is correlated to the correct Asset without filename
identity.

Predictions persist through the canonical annotation path.

Review-frozen Assets are not mutated when delayed results arrive.

Parent Asset revisions follow existing AI-write semantics.

Refresh retains Job state and persisted predictions.

Submission/poll/result failures are durable and diagnosable.

Existing single-asset AI tests remain green.

Real PostgreSQL/Redis/MinIO/worker proof demonstrates one external
batch task for multiple Assets.