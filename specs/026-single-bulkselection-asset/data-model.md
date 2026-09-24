# Data Model (provisional design)

Blocked on research E1–E3; no schema migration or application change is made by this document.

## Existing entities and relationships

Dataset owns Assets, labels, Jobs and AiTasks. Job is authoritative; AiTask.jobId is unique and subordinate. Job.retryOfJobId is unique, permitting one successor per predecessor. AiTask.externalTaskId is unique. Annotation and VideoObjectTrack retain existing canonical geometry, provenance and revision behavior. No new bulk execution table is introduced.

## Versioned Job.input

Proposed schema `AiBatchJobInputV1` contains schemaVersion=1, targetMode (CURRENT_ASSET or BULK_SELECTION), datasetId, ordered targets, modelId and validated model key/version/type/modality snapshot, selected classes, confidence_threshold, iou_threshold, effectiveLimit and optional recovery context. Each target contains assetId, zero-based inputIndex and sourceIdentityDigest. IDs and indices are distinct, array length is 1..effectiveLimit, all targets share one modality, and thresholds are finite numbers in [0,1]. Classes follow the existing unique bounded list and provider class validation. Source digest covers canonical source/cache selection, version/checksum/fingerprint and relevant dimensions; it contains no raw locator. If reliable identity cannot be established, reject that input.

Job.createdById supplies requester identity; avoid another mutable requester field. Snapshot membership is fixed even when original filters later change. Do not persist full browser Asset records, credentials, signed URLs or a fresh filter as retry authority. Job.modality and totalItems reflect accepted targets. AiTask.input is only the existing provider-facing projection derived from Job.input; detect mismatch rather than choosing whichever differs.

## Job.state and summary

Use a namespaced versioned aiBatch checkpoint with generation, externalTaskOwnerId, submission phase and ordered per-Asset checkpoints. Pending entries may be PENDING; final outcomes are SUCCEEDED, FAILED, SKIPPED, CANCELED. Each final entry includes assetId, inputIndex, safe reasonCode where applicable, predictionCount, committed Annotation/track counts and optional originating successful Job reference. A successful zero-result envelope has predictionCount=0 explicitly; absence of a group is never success.

Each transaction conditionally advances checkpoint generation under the active Job lease/status and cancellation predicate. Checkpoint, prediction writes and parent revision update commit together. This serializes whole-JSON read/modify/write safely. Failed transactions leave no success marker or partial annotations; a separate fenced transaction records a sanitized failure. Cancellation racing with the fence either follows a completed Asset transaction or wins and prevents it.

Job.summary exposes only allowlisted counts/outcomes. totalItems=N; processedItems counts final entries; successItems/failedItems/skippedItems match corresponding categories. canceledItems lives in summary because no dedicated column exists. At terminal status: N = succeeded + failed + skipped + canceled. AiTask.summary is a subordinate projection; preserve existing provider reservation namespace. Avoid persisting raw provider output containing paths. Large normalized results, if retained for recovery, use the existing private resultStorageKey capability with safe metadata; binary artifacts remain in MinIO.

## Submission manifest

Existing AiTask.summary.aiozSubmission retains reservation and entries containing assetId, media type, urlDigest; extend/version it to retain ordered inputIndex and sourceIdentityDigest as needed. The exact submitted signed URL is transient memory only. Duplicate digests are rejected unless a verified provider-supported unique input identity is available. The provider task owner retains externalTaskId permanently; a successor references that owner and does not duplicate the unique value.

## Lifecycle

| Condition | Job | AiTask | Outcomes |
| --- | --- | --- | --- |
| Durable acceptance | QUEUED | QUEUED | Pending N |
| Claimed/submitted/polling/persisting | RUNNING (existing RETRYING rules retained) | RUNNING | Pending plus committed final entries |
| All N successful, including explicit empty results | COMPLETED | SUCCEEDED | N successes |
| Any failure or policy skip in uncanceled terminal operation | FAILED | FAILED | Success/failure/skip partition of N |
| Cancellation requested | CANCELING until existing boundary completes | Existing cancellation projection | Preserve committed successes |
| Cancellation terminal | CANCELED | CANCELED | Previously final entries plus remaining canceled |

A submission/envelope failure must finalize every unresolved target with a safe reason; never leave a terminal Job with unaccounted pending entries. Dispatch-time invalidity rejects the whole external submission rather than shrinking it. Writer-time independent policy failures can coexist with successful Assets.

## Retry context

Allowlist only versioned immutable target/configuration data, predecessor/root Job ID, original external-task owner ID and successful checkpoint references. Validate lineage and Dataset match server-side. Recover original outputs without rewriting predecessor history. Successor outcome projection includes inherited successes; those receive no new annotations or Asset revision increments. Definite no-submission failures may submit the same accepted target after revalidation. Ambiguous submissions are blocked. Known failed external computation without reusable outputs requires a distinct intentional new run, not a blind recovery POST.

## Compatibility

Historical Job.input={} / AiTask-only inputs remain readable. A narrowly validated legacy execution adapter preserves existing accepted single-Asset runs; do not fabricate source history or per-Asset success for old failures. New retries require sufficient validated recovery evidence; unsupported historical records return a safe conflict. New versioned work must never fall back to legacy authority on schema mismatch.

## Source identity (decision D-U1)

`sourceIdentityDigest` = SHA-256 over the canonical tuple: `Asset.sourceFingerprint`, `currentVersionId`, `sourceRevision`, `sizeBytes`, `checksum`/`cacheChecksum` when present, and the selected object locator. Required for eligibility: `sourceFingerprint`, `sizeBytes`, storage locator (the same rule as `ensure-media-processing-job.ts`); a checksum is optional. The digest contains no raw locator or URL. T016 verifies how `sourceFingerprint` changes on UPLOAD-mode replacement and tightens the tuple if it does not.

## Skipped-Asset outcome (decision D-I2)

A target finalized `SKIPPED` (for example reason `WORKFLOW_FROZEN`) makes the aggregate Job/AiTask `FAILED` for every operation, including a single-Asset one. The skipped Asset is never mutated; other successes stay durable. Historical tasks are read through the legacy adapter and never rewritten.

## Glossary (finding A2 — use these terms only)

| Term | Meaning | Avoid |
| --- | --- | --- |
| accepted target | The ordered, immutable list of Assets persisted at acceptance | "snapshot" (informal), "resolved list" |
| skipped | An accepted Asset intentionally not written for a policy reason (frozen, source changed); reason code required | "policy skip" |
| failed | An accepted Asset that could not be attributed or written for a technical reason | — |
| recovery owner | The original AiTask that holds the unique `externalTaskId` a successor refers to | "retry owner", "external-task owner" |
| effective limit | The published maximum distinct Assets per operation (at most 200, lowered by verified provider limits) | "batch limit", "ceiling" |
| operation | The common Job plus its subordinate AiTask | "bulk job" |
