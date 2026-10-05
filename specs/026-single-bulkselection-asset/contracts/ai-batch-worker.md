# Worker and Provider Contract (provisional)

## Evidence prerequisite

See research E1–E3. Repository docs record scalar model_id, files[], task_name=image/video, data.task_id and exact returned path echo. Those historical observations are the draft baseline; provider limits and deployed guarantees still need confirmation. Do not copy the illustrative array model_id from input.md, infer ordering, or invent provider APIs.

## Acceptance-to-submit

1. Receive only `{jobId}` and acquire the existing PostgreSQL lease. Parse versioned Job input; validate AiTask projection. Handle legacy tasks only through the explicit compatibility adapter.
2. Revalidate requester annotation permission, Dataset membership, every accepted Asset's nondeleted/nonarchived source and editable workflow state, and active model/task/modality support. If any fails, no smaller subset is submitted. Persist terminal outcomes for all accepted IDs.
3. Resolve original/cache MinIO object references server-side. Compare source identities to acceptance snapshot. Sign fresh scoped downloads for the verified window and topology. Retain only non-secret digest mapping and ordered identities.
4. Atomically reserve one submission before HTTP. A prior external task owner ID means reuse/poll; an unresolved reservation means ambiguous recovery, not another POST. Check cancellation before and after provider calls.
5. Submit exactly one files array for all N accepted targets; persist returned external ID and nextPollAt durably through the existing adapter path. Never fan out by Asset.

## Normalized result envelope

Extend existing AiProviderStatusResult so COMPLETED retains explicit per-input groups, not only a flattened predictions array. Each verified group carries assetId/input identity, source identity reference, outcome kind, and predictions in the current canonical normalized format. Empty predictions is success only for an explicit valid group. VIDEO must also preserve frame/track identity and existing normalization rules.

Validate envelope identity before persistence: expected unique manifest, unknown/duplicate identifiers, completeness and output grouping. Unknown or ambiguous identity fails closed before any writes. Missing inputs receive explicit failed outcomes; independently attributable groups may proceed only if E2 proves separation safe. Otherwise all unresolved inputs fail. Invalid geometry invalidates its entire identified Asset group, not just one detection. Never clamp or fabricate geometry. Preserve existing label mapping/manual-annotation policies and report filtered/unmapped predictions explicitly in counts/reasons instead of concealing loss.

Raw response paths and signed URLs stay transient. Recovery can re-poll a known external task; any stored normalized result must be URL-free and validated. Existing 8 MiB response cap, polling time/attempt budget and signing TTL must be reconciled with the verified effective limit; exceeding them produces a durable safe failure, not truncation.

## Per-Asset commit and aggregate finalization

For each verified group, use the existing image/video writer internals in one Prisma transaction. Atomically fence Job lease, checkpoint generation, running state and cancelRequestedAt; serialize permission validation with the repository's Dataset membership mutation boundary, and use guarded Asset revision updates to serialize workflow/source checks with writes. Prechecking access outside a transaction is insufficient. Retry serialization conflicts within the bounded worker policy.

If that Asset already has a successful checkpoint in this operation's recovery lineage, return the stored outcome with no writes. Otherwise validate all predictions before changing rows, retain existing manual/accepted annotation policy, write all outputs, increment parent revision only for actual content changes, and persist the checkpoint in the same transaction. Confirmed zero results create no fabricated annotation. The current writer appends AI/DRAFT rows; retain that policy and do not delete or replace existing manual, accepted or prior AI annotations. A true no-op does not advance the parent revision.

Source/review/access changes produce explicit failed or policy-skipped outcomes; no partial mutation on that Asset. Unexpected persistence failures roll back before a separate fenced failure checkpoint. Independently committed other Assets remain durable.

After all N outcomes are final, reconcile counts and atomically set Job/AiTask terminal projections. Any failed/skipped target => FAILED; all successful => COMPLETED/SUCCEEDED. Cancellation preserves finalized outcomes, sets remaining targets CANCELED and ends CANCELED. No new partial-success lifecycle state. A terminal record cannot retain pending targets.

## Retry owner and scanner

AiTask.externalTaskId remains unique on its original owner. A recovery successor references that owner via validated server-only metadata. Its polling schedule and Job lease belong to the successor; resolve manifest and external ID from the owner without updating terminal predecessor history. Extend scanner eligibility for this reference form so a null successor externalTaskId does not strand recovery. Duplicate queued predecessor deliveries remain no-ops. Unique retryOfJobId prevents competing successors; checkpoint lineage prevents replayed successful writes.

Known external outputs are reused. Definite no-submit failures can perform one new reservation for the accepted target. Ambiguous acceptance stays blocked without proof; do not clear a reservation or call POST to discover whether it succeeded. Remote cancellation is best-effort only if an actual contract supports it; no such endpoint is assumed.


## v1 reconciliation (2026-09-24; controlled provider run)

- **Scope:** IMAGE detection only; VIDEO/AUDIO targets are rejected before dispatch.
- **Correlation (hard gate HG-1):** the deployed contract does not guarantee result-to-input identity (free-form `output`). No write path may be implemented until a contractual or deterministic guarantee exists; observed exact `image_path` echo is evidence only. Never infer order.
- **Statuses:** explicit allowlist; `failed_system` is non-terminal `PROVIDER_DEGRADED` (bounded polling, no resubmission, no assumption of recovery or terminality); unknown statuses fail closed.
- **Submission:** the provider is non-idempotent and offers no lookup. One create call per reservation; only a definite rejection (HTTP 4xx/422 received) permits a new reservation; timeout/reset/crash after reservation is AMBIGUOUS, terminal and never retried.
- **Errors:** provider error/`detail` text can contain signed URLs; it is mapped to allowlisted codes and never persisted, logged or displayed.
- **Failure layering:** provider failure is whole-batch (an unreachable input fails every input); per-Asset outcomes come from platform write-time policy only.


## Implemented status (2026-09-24)

Built: versioned-input dispatch with projection/requester/source-identity revalidation and whole-operation rejection, ordered signing with the durable `{inputIndex, sourceIdentityDigest, urlDigest}` manifest, one create call per reservation (fault-injection tested), D-FS status allowlist, whole-batch failure/cancel finalization of every target, sanitized reasons. **Not built (HG-1):** correlation of results to Assets, per-Asset prediction transactions, success outcomes, replay/inherited successes, owner-referenced recovery of a known external task.
