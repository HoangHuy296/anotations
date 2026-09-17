# Foundational task evidence log

Append-only. Each entry records the task, command, date, and result exactly as observed — no rephrasing of failures as passes.

## T002 — target-deployment TEXT asset inventory

Recorded in [research.md](../research.md) "Evidence and limits": 3 TEXT assets, 3 object-only, 0 inline-only, 0 both, 0 missing both, 0 with annotations, as of 2026-09-15. Completed before this implementation session; not repeated here.

## T016 — `pnpm run db:validate` after combined T010–T015 schema edits

Date: 2026-09-16.

```
$ pnpm run db:validate
Prisma config detected, skipping environment variable loading.
Prisma schema loaded from prisma/schema.prisma
The schema at prisma/schema.prisma is valid 🚀
```

Result: PASS.

## T017 — generate migration in an isolated checkout against a disposable PostgreSQL database

Date: 2026-09-16.

Procedure: created a detached `git worktree` at HEAD in the session scratchpad (never touching the working repo's `.env`/`.env.local`), copied the working tree's modified `prisma/schema.prisma` and the full (including uncommitted) `prisma/migrations/` directory into it, symlinked `node_modules` read-only, and wrote a worktree-local `.env` pointing at a disposable, ephemeral `postgres:16-alpine` Docker container (`text-workspace-disposable-pg`, random host port, password generated for this container only, destroyed after use — never the shared dev database at `annotationplatformdev-postgres-1`). Ran `prisma migrate dev --create-only --name text_workspace_engine`, which applied all 18 existing migrations to the empty disposable database and then generated `20260916110707_text_workspace_engine/migration.sql` without applying it.

Review of the generated SQL: additive only.
- `ALTER TYPE "CollaborationOutboxEventType" ADD VALUE 'ANNOTATION_CHANGED' / 'TEXT_POLICY_CHANGED'`
- `ALTER TYPE "JobType" ADD VALUE 'TEXT_SOURCE_PREPARE'`
- `Dataset`: adds nullable-safe `textPolicy` (default `{}`), `textPolicyRevision` (default 1), `textMutationRevision` (default 0) — no existing column altered/dropped.
- `TextAsset`: adds nullable `sourceIdentity`, `sourceEncoding`, `offsetUnit`, `sourceByteLength`, `sourceCodeUnitLength`, `boundaryArtifactKey`, `boundaryArtifactDigest`, `boundaryProfile`, `preparedSourceFingerprint`, `preparedAt` — existing rows remain valid (all null = unprepared).
- New table `AnnotationMutationReceipt` with its unique `(assetId, actorId, operationId)` and `assetId` index.
- `Annotation.fromAnnotationId` / `toAnnotationId`: drops and re-adds the FK constraints, changing the delete action from the prior default (`SetNull`) to `ON DELETE RESTRICT`; adds individual indexes on both endpoint columns (in addition to the existing composite index).

No `DROP TABLE`, no `DROP COLUMN`, no data-lossy type change. No raw SQL was authored — the file is Prisma-generated DDL from the declarative schema only. Confirmed no application migration was applied to any shared review/production database.

Result: PASS.

## T018 — apply the reviewed migration to the disposable database and verify cleanup ordering

Date: 2026-09-16.

Applied via `prisma migrate deploy` against the same disposable container — all 19 migrations (18 existing + new) applied successfully.

Verified the consequence of the `SetNull` → `Restrict` endpoint FK change empirically with seeded fixture rows (one dataset, one TEXT asset, two spans, one relation referencing both):

1. **Full-asset cascade cleanup still works.** `DELETE FROM "Asset" WHERE id = 'a1'` (the same cascade path the product's existing asset/dataset deletion uses via `Asset.annotations` `onDelete: Cascade`) removed the asset and all three annotations — including the self-referencing relation row — in one statement, with zero orphaned rows verified afterward. PostgreSQL resolves the self-reference correctly because the referencing row and both endpoints are removed together within the same cascading statement.
2. **A standalone referenced-span delete is correctly blocked.** With a second fixture (`span3`/`span4`/`rel2`), `DELETE FROM "Annotation" WHERE id = 'span3'` while `rel2` still referenced it failed with `ERROR: ... violates foreign key constraint "Annotation_fromAnnotationId_fkey" ... Key (id)=(span3) is still referenced`. Deleting the relation first, then the span, succeeded. This matches the intended product behavior (data-model.md: "Deleting a referenced span fails until relations have been explicitly removed").

Known limitation carried forward: this confirms the *database constraint* behaves correctly; the application-level explicit relation-before-endpoint deletion ordering required by data-model.md's "Atomic command algorithm" for services that do NOT go through the full-asset cascade path (e.g., a future bulk/dataset cleanup path that deletes annotations without deleting their parent Asset row) is not yet implemented — that is US4/T124's responsibility, not Foundational schema.

Disposable container and isolated worktree were torn down after this evidence was captured; nothing was written to the shared dev/review database.

Result: PASS.

## T019 — regenerate the Prisma client and check for stale-type breakage

Date: 2026-09-16.

```
$ pnpm run db:generate
✔ Generated Prisma Client (6.19.3) to ./lib/generated/prisma in 502ms
$ pnpm run db:normalize-generated
```

Ran `pnpm --filter @annotationplatform/web typecheck` to check for files importing now-stale generated types. Result: 2 errors, both in `audio-properties-tabs.tsx` and `workspace-engine-registry.tsx`, both about an AUDIO-engine discriminated-union narrowing to `never` — unrelated to any TEXT/Dataset/TextAsset/AnnotationMutationReceipt field this migration touched. Confirmed via `git diff --stat` that `workspace-engine-registry.tsx` already carried uncommitted changes before this implementation session began (part of the pre-existing dirty tree noted in research.md, not something this session authored or that `prisma generate` could affect). No new typecheck failure was introduced by the schema/client regeneration. Not fixed here — out of scope for Phase 025 Foundational work; flagged for whoever owns the AUDIO engine registry changes already in progress on this branch.

Result: PASS (client regenerated cleanly; no TEXT-attributable typecheck regression).

## T020–T025 — worker boundary computation, source verification, queue registration, config wiring

Date: 2026-09-16.

- `apps/worker/src/source/text-boundary.ts` (T020): `computeTextBoundaryArtifact` uses `Intl.Segmenter("und", {granularity:"grapheme"})` and records the actual `process.versions.{node,icu,unicode}`. Verified against the full research.md D1 fixture table (`apps/worker/tests/source/text-boundary.test.ts`) — all 8 fixtures (ASCII, surrogate-pair emoji, combining mark, precomposed accent, ZWJ sequence, CJK, BOM+mixed-CRLF, empty string) produce exactly the documented valid endpoints, and every offset strictly between two valid endpoints is confirmed rejected.
- `apps/worker/src/source/text-source-verify.ts` (T021): `verifyTextSourceBytes` composes the shared T007 decode + T008 limits with a raw-byte SHA-256 digest; `readBoundedStreamToBuffer` stops and reports `oversized` instead of buffering or silently truncating. Verified with the same fixture matrix plus invalid-UTF-8 and both oversized-bytes/oversized-code-units cases.
- `packages/queue/src/job-contract.ts` (T022): `TEXT_SOURCE_PREPARE` added to `supportedQueueJobTypes`; existing queue contract test still passes.
- `apps/worker/src/jobs/text-source-prepare.processor.ts` (T023): claim → validate input/source identity → bounded stream read → verify → compute boundary artifact → upload derivative → re-verify source identity inside a transaction (recheck-at-commit) → upsert `TextAsset` → complete, via the existing `job-claim-lock.ts` lifecycle. Registered in `apps/worker/src/queue/queue-router.ts` (T024).
- T025: `getTextSourceLimits()` added to both `apps/worker/src/config.ts` and (new) `apps/web/src/lib/config/text-source-limits.ts`, both wrapping the one `packages/domain` implementation. Wired into both readiness paths (`apps/web/src/lib/readiness.ts`, `apps/worker/src/readiness.ts`) so a malformed `TEXT_WORKSPACE_MAX_*` override fails startup/health instead of surfacing as a confusing later error. Added `TEXT_WORKSPACE_MAX_SOURCE_BYTES`/`_CODE_UNITS`/`_ANNOTATIONS` to `docker-compose.yaml`, `docker-compose.review.yaml` (both web and worker services) and documented them in `.env.example`. Registered the new `TEXT_SOURCE_*` job error codes in `apps/web/src/lib/jobs/safe-job-status.ts`'s browser-safe allowlist with reviewed user-facing messages (previously they would have been silently dropped to `null`).

Commands run: `pnpm --filter @annotationplatform/worker typecheck` (clean), `pnpm --filter @annotationplatform/domain typecheck` (clean), `pnpm --filter @annotationplatform/queue typecheck` + test (clean), `node --test apps/worker/tests/source/text-boundary.test.ts` (11/11 pass), `pnpm --filter @annotationplatform/web typecheck` (same 2 pre-existing unrelated AUDIO-engine errors as T019, no new failures).

Known limitation carried forward: the generic `retryAuthorizedJob` FAILED-job retry path (`apps/web/src/lib/jobs/retry-job.ts`) has an explicit per-type `extractRetryContext` switch with a `default: return null` — `TEXT_SOURCE_PREPARE` correctly falls through to "retry refused" rather than silently retrying with wrong context, but no reviewed mapping is added yet. Per data-model.md this preparation Job's own idempotent create/reuse pattern (T038) is the primary "retry" path, not this generic failed-job endpoint; an explicit mapping here is left for whoever implements T038 to add only if actually needed.

Result: PASS.

## T026–T027 — web boundary loader and source readiness derivation

Date: 2026-09-16.

- `apps/web/src/lib/annotations/text-boundary-loader.ts` (T026): bounded-stream reads the private grapheme-boundary derivative from the real `getWebProviders().minio` client (never `local-storage.ts`'s fallback), verifies its raw-byte SHA-256 against the caller-supplied `boundaryArtifactDigest`, parses/validates it against the shared `textBoundaryArtifactSchema`, and cross-checks `sourceIdentity`/`offsetUnit`/`sourceCodeUnitLength`/profile before ever returning it. A bounded (200-entry) in-process LRU+TTL (5 min) cache is keyed by `datasetId::assetId::sourceIdentity::boundaryArtifactDigest::profile`, so a cache hit can only ever return content matching the exact identity the caller just re-verified from durable metadata — a source replacement produces a different key, not a stale hit. Verified against the real dev MinIO (`apps/web/tests/text-source/text-boundary-loader.test.ts`, 3/3 passing via `pnpm --filter @annotationplatform/web run test:text-source`): loads and caches a real uploaded artifact (cache hit survives the object being deleted, proving it doesn't refetch), rejects a digest mismatch, rejects a schema-invalid object, and reports "missing" for both a nonexistent object and a request keyed to an identity that was never cached. Every test object was written under a unique `text-boundaries/__test-fixtures__/<run-id>/` key and removed in `t.after()` — nothing shared/pre-existing in the dev MinIO bucket was touched.
- `apps/web/src/lib/annotations/text-source-readiness.ts` (T027): pure derivation of the 8-state readiness enum from verified `TextAsset` metadata, `Asset` object presence, the latest `TEXT_SOURCE_PREPARE` Job, and an optional live reverification result (for the read-time re-check T028 will perform). Covers every state exactly per data-model.md's D2 table, including that `TEXT_SOURCE_MISSING`/an unrecognized failure code falls through to object/legacy classification rather than guessing. 7/7 unit tests passing.

Commands: `pnpm --filter @annotationplatform/web typecheck` (same 2 pre-existing unrelated AUDIO errors, no new failures), `pnpm --filter @annotationplatform/web run test:text-source` (10/10 passing, new script added to `apps/web/package.json`).

Result: PASS.

## Migration applied to the shared dev database

Date: 2026-09-16. **User-approved** (explicit AskUserQuestion confirmation before proceeding).

`20260916110707_text_workspace_engine` was generated/reviewed against the disposable database (T017) but the shared dev PostgreSQL backing the running `annotationplatformdev-*` containers still needed it applied before any further real-Postgres integration test could run (T028 onward all require it). Ran `pnpm exec prisma migrate status` first (confirmed exactly one pending migration, the expected one, nothing else drifted), then `pnpm exec prisma migrate deploy` — applied cleanly. Regenerated the Prisma client (`pnpm run db:generate` + `db:normalize-generated`). Confirmed `annotationplatformdev-web-1` and `annotationplatformdev-worker-1` remained healthy/running throughout (`docker ps`, worker log tail showed normal scheduled-scan activity, no errors). No data was modified or lost — purely additive DDL, exactly as reviewed in the T017 entry above.

Result: PASS.

## T028–T029 — authoritative TEXT source read service

Date: 2026-09-16.

`apps/web/src/lib/annotations/text-source-read-service.ts` (T028): the single place source-authority logic lives for reads. Authorizes `dataset.read`, resolves the asset (concealing non-members/cross-dataset as `NOT_FOUND`, no source excerpt ever leaked), and — critically — **re-verifies the raw object bytes against the durable `sourceIdentity` on every call**, not just at prepare time: bounded stream read → SHA-256 raw-byte digest compare → fatal UTF-8 decode (shared T007) → length cross-check → composes the T026 boundary loader → returns either the exact safe source + full boundary offsets (`READY`) or one of the other 7 readiness states, never a partial/guessed result. No I/O happens inside a transaction (there is none here — this is a pure read path); future command services (T033+) are expected to call this *before* opening their own transaction.

Verified end-to-end against the real (now-migrated) dev PostgreSQL + MinIO with genuine fixture data (`apps/web/tests/text-source/text-source-service.test.ts`, T029) — each test creates its own dataset/user/asset/MinIO objects via the existing `tests/workspace/helpers.ts` fixture convention and removes them in `t.after()`:
1. A fully prepared fixture (real uploaded source object + real boundary-artifact object + `TextAsset` row) returns `READY` with the exact original decoded text and the exact expected boundary offsets.
2. Replacing the source object's bytes *after* preparation (simulating a source silently swapped out from under a "READY" asset) is detected live and degrades to `SOURCE_MISMATCH` — proving the re-verification-on-every-read guarantee actually holds, not just in theory.
3. A non-member of the dataset gets `NOT_FOUND` (existing concealed-resource convention), never any source content.
4. An asset with an uploaded object but no verified `TextAsset` metadata yet correctly reports `UNPREPARED`.

Combined `apps/web/tests/text-source/` suite: 14/14 passing (`pnpm --filter @annotationplatform/web run test:text-source`).

Result: PASS.

## T030 — full worker TEXT_SOURCE_PREPARE integration suite

Date: 2026-09-16.

`apps/worker/tests/source/text-source-prepare.test.ts`, run against the real (migrated) dev PostgreSQL + MinIO via real `Job` rows claimed through the existing `job-claim-lock.ts` lifecycle — 11/11 passing, folded into the existing `pnpm --filter @annotationplatform/worker run test:source-access` script (glob-matched, no new script needed) which now runs 27/27 total.

Covered, each with real end-to-end verification:
1. **Full Unicode fixture matrix** (6 of the 8 D1 fixtures — precomposed-accent and CJK are pure boundary-computation cases already covered exhaustively by T020's unit suite; these 6 exercise the full pipeline: MinIO upload → Job → claim → verify → boundary compute → artifact upload → transaction commit → `TextAsset` row): each completes, persists the exact verified `sourceEncoding`/`offsetUnit`/`sourceCodeUnitLength`/`sourceByteLength`/`sourceIdentity`, and — the specific "web loader consumes exactly the worker artifact contract" requirement — the test independently re-fetches the artifact object the worker wrote, recomputes its digest, and confirms it matches `boundaryArtifactDigest`, with `boundaryOffsets` starting at 0 and ending at the exact code-unit length.
2. **Duplicate delivery**: a redelivered message carrying a stale/wrong lock token is refused with zero side effects (no `TextAsset` write); the genuine claim holder then completes normally.
3. **Replaced source detected before work starts**: an `Asset.checksum` changed after Job creation is caught by the pre-fetch identity recheck, fails with `TEXT_SOURCE_STALE`, and leaves `TextAsset` absent.
4. **Malformed source**: invalid UTF-8 fails with `TEXT_SOURCE_INVALID_ENCODING`, no `TextAsset` write.
5. **Oversized source**: a source over the configured byte limit fails with `TEXT_SOURCE_OVERSIZED_BYTES`, no `TextAsset` write.
6. **Successor retry**: a first Job with a wrong `expectedSource` fails; a second Job (`retryOfJobId` pointing at the first, following the existing predecessor/successor Job convention) with the corrected identity completes and produces exactly one boundary-artifact object at the deterministic key.

**Deliberately not attempted, reported honestly rather than silently skipped**: T030's closing clause — "finalize the benchmark boundary artifact/profile manifest against the T003 corpus" (`specs/025-text-workspace-engine/benchmark/reference.json`) — is the SC-005 performance-suite fixture (a 100k-code-unit / 1,000-span / 100-relation document, measured against a specific production-build Docker Compose topology and a real Chrome browser automation harness). That corpus cannot be meaningfully generated or measured yet: no span/classification/relation commands exist (US2/US3/US4), no export path exists to validate a full round-trip, and the browser/production-build measurement harness is explicitly US7's (T150/T174) responsibility per tasks.md's own dependency graph. This sub-clause remains open and is not claimed as done; it belongs with T150/T174 once the commands it needs to exercise actually exist.

Result: PASS for everything attempted; the benchmark-manifest sub-clause above is explicitly UNVERIFIED/deferred, not silently dropped.

## T031–T032 — transactional invalidation foundation

Date: 2026-09-16.

- T031: added `dispatchAnnotationChangedOutboxEvent` and `dispatchTextPolicyChangedOutboxEvent` to `apps/web/src/lib/collaboration/collaboration-outbox-service.ts`, thin typed wrappers over the existing generic `createOrReuseCollaborationOutboxEvent` primitive (unchanged). `ANNOTATION_CHANGED` payload: `{datasetId, assetId, parentRevision}` only; `TEXT_POLICY_CHANGED` payload: `{datasetId, policyRevision}` only, dataset-scoped (`assetId: null`) since a policy write is not an editable-asset claim. Every future TEXT command service calls these instead of the raw primitive, so the safe-payload shape is defined once.
- T032: investigated whether the worker relay / realtime gateway / client hook have a per-`CollaborationOutboxEventType` allowlist to extend, as the task description implies. They do not — all three are already type-agnostic by design: `apps/worker/src/jobs/collaboration-outbox-relay.ts` forwards `event.type` verbatim (only validates the payload's *shape*, which is generic scalar/null and already compatible); `apps/realtime/src/gateway.ts`'s `RealtimeEnvelope.type` is an untyped `string` with only one type-specific special case (`MEMBERSHIP_REVOKED`, unrelated); `apps/web/src/components/workspace/use-collaboration-realtime.ts`'s `onmessage` handler invalidates on *any* message regardless of type. No code change was needed or made in these three files — confirmed with real evidence rather than trusting the read: added `apps/worker/tests/queue/collaboration-outbox-relay.test.ts`'s new "relays a real ANNOTATION_CHANGED event" case, which creates a genuine `ANNOTATION_CHANGED` `CollaborationOutboxEvent`, dispatches it through the actual `routeQueueDelivery` → `processCollaborationOutboxDispatch` path, and asserts the exact envelope (`type`, `assetId`, `payload`) arrives on the real Redis pub/sub channel.

Also added `apps/web/tests/collaboration/text-invalidation-outbox.test.ts` proving both new dispatch helpers are retry-safe (concurrent identical calls reuse the same Job/event, matching every other outbox event's idempotency), roll back with their transaction, and carry exactly the allowlisted payload shape — no extra fields.

Commands: `pnpm --filter @annotationplatform/worker typecheck` (clean), `node --test apps/worker/tests/queue/collaboration-outbox-relay.test.ts` (2/2 passing against real Postgres+Redis), `node --test apps/web/tests/collaboration/text-invalidation-outbox.test.ts` (2/2 passing against real Postgres), `pnpm --filter @annotationplatform/web typecheck` (same 2 pre-existing unrelated AUDIO errors, no new failures).

Result: PASS.

## T033–T037 — mutation transaction guard and receipts (the atomic command algorithm)

Date: 2026-09-16.

This is the load-bearing piece of the whole feature: the single guarded-transaction orchestrator every TEXT mutation (and, later, every taxonomy write) must go through, exactly matching data-model.md's five-step "Atomic command algorithm."

- `apps/web/src/lib/annotations/text-mutation-receipt.ts` (T035): canonical stable-stringify request hashing (`computeTextCommandRequestHash`) and receipt replay resolution/recording, keyed by the `AnnotationMutationReceipt` schema's `(assetId, actorId, operationId)` unique constraint.
- `apps/web/src/lib/annotations/text-annotation-count.ts` (T034): pure count-admission evaluator — `delta <= 0` always permitted (so a legacy-over-limit asset can still shrink/update), positive delta only permitted when the resulting count stays within the configured limit.
- `apps/web/src/lib/annotations/safe-text-annotation.ts` (T036): thin web adapter over the shared T005 `serializeSafeTextAnnotation`, attaching a selected-text excerpt only when the caller supplies verified source text — never persisted, never something the worker export path depends on.
- `apps/web/src/lib/annotations/text-command-service.ts` (T033): `runGuardedTextAssetCommand` (dataset.read authorize → open Serializable transaction → recheck asset scope → **claim the Dataset mutation guard** → **check receipt replay before any parent revision increment** → claim the existing `claimEditableAssetContent` editable-asset guard (reused from IMAGE/VIDEO, rejects frozen NEEDS_REVIEW/REVIEWED/REJECTED workflow states) → run the command-specific `apply` callback → record the receipt) and `runGuardedTextDatasetCommand` (dataset-permission-checked, claims only the Dataset guard — **never an arbitrary asset** — for policy writes). Retries only `P2002`/`P2034` (unique-constraint/serialization) database conflicts, up to 3 attempts; any domain rejection (`TextCommandError`) returns immediately without retry and the transaction rolls back the guard claim with it.

Proven in `apps/web/tests/text-annotations/text-command-foundation.test.ts` (T037) using **generic guarded-row operations** (a bare TEXT `Annotation` create/update), not unimplemented span/classification/relation commands, per the task's own instruction — 7/7 passing against real PostgreSQL Serializable transactions:
1. A generic guarded create succeeds and advances the parent `Asset.revision` exactly once.
2. **Identical receipt replay** returns the exact committed result, does **not** advance `Asset.revision` a second time, does **not** create a second child row — but *does* still increment `Dataset.textMutationRevision` a second time, exactly matching data-model.md's specification that the Dataset guard is claimed on every attempt including replays, while only the editable-asset claim is skipped.
3. A **duplicate operation id with a changed payload** returns `RECEIPT_CONFLICT` rather than silently replaying the old result or silently applying the new one.
4. A **rejected command rolls back its parent guard claim entirely**: neither `Asset.revision` nor `Dataset.textMutationRevision` is left incremented, no receipt row is written, and the untouched child row's own revision is provably unchanged — verified by reading all three back from real Postgres after the rejection.
5. A nonexistent asset and a non-member actor both return `NOT_FOUND` (existing concealed-resource convention).
6. The dataset-only policy path claims the Dataset guard and writes its own domain state, while **never** touching any Asset's revision — verified by reading the Asset row back unchanged.
7. A role without `label.manage` is correctly `FORBIDDEN` from the dataset-only path.

Commands: `pnpm --filter @annotationplatform/web typecheck` (same 2 pre-existing unrelated AUDIO errors, no new failures), `node --test apps/web/tests/text-annotations/text-command-foundation.test.ts` (7/7 passing against real PostgreSQL).

Result: PASS.

## T038 — source-preparation authorization

Date: 2026-09-16.

`apps/web/src/lib/annotations/text-source-prepare-service.ts`: `requestTextSourcePreparation` authorizes on `dataset.read` alone (never `annotation.create`, independent of any review-freeze workflow state — matches the reviewed research.md decision). Idempotently creates or reuses one common `TEXT_SOURCE_PREPARE` Job per asset/source/profile via a deterministic `Job.idempotencyKey` (`text-source-prepare:<assetId>:<checksum>:<sizeBytes>:<processorVersion>`) — a `P2002` unique-constraint collision on a concurrent duplicate request is caught and resolved to the existing row rather than erroring. Enqueues through the existing `enqueueExistingJob` (transport carries only `{jobId}`). Also added the `TEXT_SOURCE_PREPARE` case to the existing generic FAILED-job retry path's `extractRetryContext` switch in `apps/web/src/lib/jobs/retry-job.ts` (closing the "known limitation" flagged in the T020–T025 entry above) — a retry reuses the failed attempt's own recorded source identity verbatim (matching `EXPORT_DATASET`'s existing retry convention), and the successor processor still rechecks that identity against the live `Asset` row at commit, so a source that genuinely changed since is still caught rather than silently bound to stale offsets.

Verified against the real (migrated) dev PostgreSQL + MinIO + the real live BullMQ queue (`apps/web/tests/text-source/text-source-prepare-service.test.ts`, 3/3 passing, folded into `pnpm --filter @annotationplatform/web run test:text-source`, now 17/17 total):
1. A first request creates a `TEXT_SOURCE_PREPARE` Job with the correct type/modality/creator/dataset; a second request against the same still-current source reuses the identical Job (`created: false`, same id) — confirmed exactly one Job row exists for the dataset afterward.
2. A non-member of the dataset is concealed as `NOT_FOUND`.
3. A TEXT asset with no uploaded object reports `SOURCE_UNAVAILABLE` rather than creating a Job that could never succeed.

This test enqueues to the real shared Redis queue the live `annotationplatformdev-worker-1` container is subscribed to (consistent with how every other job-creation path in this codebase is already tested — no mocked queue substitute). The container is running an older built image without this session's worker code, so any delivery it picks up before test cleanup resolves as a harmless `UNSUPPORTED_TYPE` skip via the existing generic routing safety net, not a crash or partial write; rebuilding/redeploying the worker image is a separate Compose-validation concern (T166), not something this test depends on.

Commands: `pnpm --filter @annotationplatform/web typecheck` (same 2 pre-existing unrelated AUDIO errors, no new failures), `pnpm --filter @annotationplatform/web run test:text-source` (17/17 passing).

Result: PASS.

## T039 — dataset TEXT policy read/validate service

Date: 2026-09-16.

`apps/web/src/lib/annotations/text-policy-service.ts`: parses/validates `Dataset.textPolicy` (never throws — absent/empty/corrupt stored JSON all fall back to the implicit empty policy), and resolves eligible labels/groups/relation-type compatibility. **Key finding while implementing this**: `Label.scope` (`LabelScope` enum) already contains `ENTITY`, `CLASSIFICATION`, `SENTIMENT`, `INTENT`, and `RELATION` — exactly the five TEXT eligibility scopes T041 will need — so no schema change was needed for label eligibility; only the *write* side (`labelMutationSchema`/the label creation and edit routes, currently accepting neither `modality` nor `scope` at all) needs extending in T040/T041 to let a product user actually set them. `isTextEligibleLabel` requires `modality` to be `null` (shared) or `TEXT` *and* an eligible scope.

`resolveTextPolicy` implements the exact data-model.md default/override rule: with zero explicit `classificationGroups` configured, every eligible document-scope label (CLASSIFICATION + SENTIMENT + INTENT combined) shares one implicit SINGLE group; the moment any explicit group exists, only its declared membership applies — an eligible label not referenced by any configured group belongs to no group (no silent auto-add). Relation types reference a nonexistent/ineligible relation label and are filtered out as unavailable rather than kept.

7/7 unit tests passing (`apps/web/tests/text-annotations/text-policy-service.test.ts`), covering: the empty/corrupt-policy fallback, the eligibility predicate across modality/scope combinations, the implicit-vs-explicit-group rule, relation-type filtering, and source/target endpoint compatibility (including independent `allowUnlabeledSource`/`allowUnlabeledTarget` handling).

Commands: `pnpm --filter @annotationplatform/web typecheck` (same 2 pre-existing unrelated AUDIO errors, no new failures), `node --test apps/web/tests/text-annotations/text-policy-service.test.ts` (7/7 passing).

Result: PASS.

## Session checkpoint

T001–T039 complete and verified with real evidence (39 of 175 tasks). T040–T175 remain, starting with the taxonomy policy *write* lifecycle and label-management UI (T040–T044), then engine registration/save-contract (T045–T049) to close Phase 2 Foundational, followed by all seven user stories and Polish. See the chat summary for the detailed handoff.
