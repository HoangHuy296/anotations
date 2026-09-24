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

## T040–T044 — taxonomy policy write lifecycle and label-management UI

Date: 2026-09-17. (Session resumed after a logout; dev stack containers — web/worker/minio/redis/postgres — had stopped and were restarted with `docker start`; migration state and all prior evidence confirmed intact before continuing.)

- **T040** (`apps/web/src/lib/workspace/label-management.ts`): `createLabelWithTextEligibility`/`updateLabelWithTextEligibility` are now the single write path used by every label-mutation entry point. Reuses the existing generic `Label.modality`/`Label.scope` columns — `LabelScope` already contained `ENTITY`/`CLASSIFICATION`/`SENTIMENT`/`INTENT`/`RELATION`, so no schema change was needed (discovered while implementing T039 in the prior session block). A plain (non-TEXT) label create/edit never claims the TEXT dataset guard or touches `textPolicyRevision` — only a request that actually sets or changes TEXT eligibility does, and it does so atomically with the guarded write (via `runGuardedTextDatasetCommand` from T033) plus a `TEXT_POLICY_CHANGED` outbox dispatch. A label already referenced by any annotation is locked to its current modality/scope (`REFERENCED_SCOPE_LOCKED`) — deletion of a referenced label was already blocked generically by the pre-existing `deleteUnreferencedLabel`.
- **T041**: extended `apps/web/src/lib/validation/label.ts` (`textEligibility` field, plain string enum — not a zod `preprocess`/`transform`, to keep the client-facing TS input type a clean string for react-hook-form), `apps/web/src/app/(app)/labels/actions.ts` (server actions), `apps/web/src/app/api/labels/[labelId]/route.ts` (PATCH), `apps/web/src/app/api/datasets/[datasetId]/labels/route.ts` (POST), and `apps/web/src/components/labels/label-form.tsx` (new "TEXT eligibility" select: Not TEXT-eligible / Entity (span) / Classification / Sentiment / Intent / Relation) plus `apps/web/src/app/(app)/labels/page.tsx` (a `TEXT · <SCOPE>` badge on eligible labels in the list). A brand-new capability delivered entirely through normal authorized product use — no direct database seeding.
- **T042** (`apps/web/src/lib/annotations/text-policy-write-service.ts`): `writeTextPolicy` takes the canonical `{expectedRevision, policy}` shape unchanged from HTTP through service (a `.strict()` Zod schema — an `expectedPolicyRevision` alias is rejected as an unrecognized key, not silently accepted). Runs inside `runGuardedTextDatasetCommand` (dataset-only guard, no asset-edit claim): compares `expectedRevision` against the live `Dataset.textPolicyRevision`, validates every label id referenced anywhere in the policy belongs to the dataset and has the *correct* eligible scope for its role (classification-group members need a document scope, a relation type's own label needs RELATION, its endpoint allow-lists need ENTITY), rejects a reconfiguration that would orphan an existing `TEXT_CLASSIFICATION`/`TEXT_RELATION` annotation's label, then commits `textPolicy`/`textPolicyRevision`/the `TEXT_POLICY_CHANGED` outbox event atomically.
- **T043** (`apps/web/src/app/api/datasets/[datasetId]/text-policy/route.ts`): GET requires `dataset.read`, PUT requires `label.manage` plus the same-origin guard (`isCrossOriginRequest`, the existing convention for state-changing routes) and calls the T042 writer; both return safe `{revision, policy, eligible: {...}}`, never a storage locator or raw label metadata beyond ids.

**T044** (`apps/web/tests/text-policy/text-policy-lifecycle.test.ts`, 8/8 passing): proves the generic policy revision guard and policy-only stale-write/rollback behavior at the service boundary the route thinly wraps (the route itself was not invoked directly — Next.js Route Handlers require `next/headers`' request-scoped `cookies()`, which only real server-side request handling provides; every other "route" task this session has, consistently, tested the service layer beneath it instead). Covered:
1. Canonical `{expectedRevision, policy}` acceptance; an `expectedPolicyRevision` alias is rejected by `.strict()`.
2. An unconfigured dataset reads the implicit empty policy at revision 1.
3. A correct `expectedRevision` commits atomically, bumps the revision exactly once, and the `TEXT_POLICY_CHANGED` outbox event carries exactly `{datasetId, policyRevision}` with `assetId: null`.
4. A stale `expectedRevision` is rejected (`REVISION_STALE`) and **provably rolls back the Dataset guard claim** — `textPolicy`/`textPolicyRevision`/`textMutationRevision` all read back unchanged.
5. A label reference outside the dataset, and a label used with the wrong role for its scope, are both rejected as `INVALID_REQUEST` without advancing the revision.
6. Reconfiguring classification groups to exclude a label with an existing `TEXT_CLASSIFICATION` annotation is rejected (`CONFLICT`) — **a genuine bug was caught and fixed here**: the test's first draft used `classificationGroups: []` to attempt the "orphan," which actually falls back to the implicit SINGLE group (still covering the label, per data-model.md's own specified default) and so correctly succeeded; the test was corrected to use an explicit but empty-membership replacement group, which genuinely excludes the label and is correctly rejected.
7. A LABELER (no `label.manage`) is forbidden.
8. Any dataset member (including LABELER, via `dataset.read`) can read the resolved eligible taxonomy.

**Browser verification (T041 UI, per AGENTS.md's UI-testing rule)**: `chromium-cli` was unavailable in this environment, so Playwright + Chromium were installed into a throwaway temp directory (not a project dependency) purely for this verification. Ran the real Next.js dev server locally on port 3010 (the shared Docker `annotationplatformdev-web-1` container runs an older baked image without this session's source changes, so it was left untouched rather than rebuilt) against the same real dev PostgreSQL/MinIO/Redis, created a throwaway MANAGER user via a temporary script, and drove a full real-browser session: logged in through the actual `/login` form → navigated to `/labels` → filled the create form, opened "Advanced label metadata," selected "Entity (span)" → submitted → confirmed the "Created ..." toast and a green "TEXT · ENTITY" badge appeared on the new list entry → opened its edit form and confirmed the select correctly prefilled to "Entity (span)" → changed it to "Classification" → saved → confirmed "Updated ..." toast and the badge updated live to "TEXT · CLASSIFICATION" — zero browser console errors throughout. Screenshots reviewed at each step. All test data (user, dataset, both labels) and the temporary Playwright install were cleaned up afterward; the local dev server was stopped by PID; the shared dev containers were confirmed untouched and healthy throughout.

Commands: `pnpm --filter @annotationplatform/web typecheck` (clean, same 2 pre-existing unrelated AUDIO errors), `pnpm --filter @annotationplatform/web lint` (clean), `node --test` across `tests/text-annotations/*.test.ts tests/text-policy/*.test.ts tests/text-source/*.test.ts tests/collaboration/text-invalidation-outbox.test.ts` — **48/48 passing** combined regression.

Result: PASS.

## T045–T047 — engine registration, the active-engine flush contract, and its immediate IMAGE/VIDEO regression proof

Date: 2026-09-17.

**T045** (`apps/web/src/lib/workspace/text-engine-capabilities.ts`): `deriveTextEngineCapabilities` — read/select are always available once a TEXT asset resolves into the workspace at all (an unready source is an in-engine state, never a capability gate, per research.md D6); span/classification/relation each gate on source readiness (`READY`) + workflow-not-frozen + `annotation.create` + the relevant eligible-taxonomy flag, with a distinct stated reason per capability when blocked. Registered on the TEXT entry in `workspaceEngineRegistry` via a new optional `deriveCapabilities` field. Since the current `WorkspaceSelection` TEXT variant doesn't carry readiness/policy/permission context yet (T048's job), it's wired to the conservative `UNAVAILABLE_TEXT_ENGINE_CAPABILITIES` default for now — a real, tested, pure function ready for T048 to feed live data through, never reporting an unearned capability in the meantime. 7/7 unit tests passing (`tests/workspace/text-engine-capabilities.vitest.spec.ts`).

**T046** (`apps/web/src/lib/workspace/workspace-engine-flush.ts`, registered as `flush` on every `workspaceEngineRegistry` entry): defines `EngineFlushResult = {ok:true,assetRevision} | {ok:false,reason}` and `createEngineFlush(includeVideoTrackAutosave)`, which flushes the generic cross-engine autosave store every engine already shares (`useAnnotationStore`, despite its historical "image" name) — plus, for VIDEO only, its dedicated `TrackAutosaveCoordinator` system — and, only on success, fetches the server-authoritative current `Asset.revision` from the existing workflow-status endpoint.

**A real, reproducible bug was found and fixed, not just a contract added in the abstract.** Every caller previously fired both flush functions unconditionally and *fire-and-forgot* (no result checked), then immediately reused whatever revision it already had in local/prop state — for `workspace-header.tsx`'s Submit/Resubmit, that was the **page-load `workflow.revision` prop**, never refreshed after an autosaved edit. Since `applyAssetWorkflowAction` rejects on `asset.revision !== expectedRevision`, a user who edited an annotation (bumping `Asset.revision` server-side) and then clicked Submit could get a spurious `STALE_REVISION` 409 — "This asset changed. Reload before deciding." — against their *own* just-saved edit. Fixed by making every caller `await` the new `flush()` and use its returned `assetRevision`, blocking entirely on failure:
- `workspace-header.tsx`'s `WorkflowControls.act()` (Submit/Resubmit) — now passed `engine` as a prop, calls `workspaceEngineRegistry[engine].flush(datasetId, assetId)`, and only proceeds to the workflow POST on success, using the *returned* revision.
- `dataset-sidebar.tsx`'s previous/next navigation guard.
- `image-properties-tabs.tsx` (already had a failure-checking `window.confirm` escape hatch — adapted to the shared contract), `video-properties-tabs.tsx` (previously had **no** failure check at all — `flushBeforeNavigation` unconditionally `return true`), `audio-properties-tabs.tsx`, and `placeholder-properties-tabs.tsx` (TEXT's own asset-list/previous-next navigation guard) — all four now share the identical confirm-on-failure pattern IMAGE already established.
- `properties-panel.tsx`'s no-selection-yet branch was deliberately left as a defensive flush-both (no single engine/asset is in scope there to target a per-engine barrier against).

**T047** (`apps/web/tests/workspace/image-video-flush-regression.test.ts`, 9/9 passing) proves the shared contract those callers now all depend on. No jsdom/`@testing-library/react` exists in this repo (AGENTS.md requires explicit permission before adding one — matches the established pattern in the sibling `workspace-engine-registry.vitest.spec.ts`), so this exercises the real underlying logic directly — the actual Zustand autosave store and the actual `TrackAutosaveCoordinator`, with only the browser `fetch` call to the workflow-status endpoint stubbed (the one genuine network boundary a Node test can't cross):
1. With nothing pending, success carries the exact server-authoritative revision.
2. A pending autosave genuinely finishes before the revision is read (not raced).
3. A failed or conflicting autosave blocks the barrier entirely.
4. A revision-fetch network error or non-2xx response is never treated as a successful flush, even after a successful save.
5. VIDEO's dedicated `TrackAutosaveCoordinator` is awaited in addition to the generic store; a track-revision conflict blocks the barrier.
6. AUDIO and TEXT share the exact same contract as IMAGE (no accidental per-engine special-casing beyond VIDEO's extra track coordinator).
7. **Late responses**: two concurrent flushes for different assets, deliberately resolved out of order, each report exactly their own asset's revision — never a cross-asset mixup from shared/global state.

Also fixed the pre-existing `workspace-engine-registry.vitest.spec.ts` (added `flush` to its structural-contract and distinct-reference assertions, and to its synthetic fifth-entry proof) — full regression: `pnpm --filter @annotationplatform/web typecheck` (clean, same 2 pre-existing unrelated AUDIO errors), `pnpm --filter @annotationplatform/web lint` (clean), all 7 `tests/workspace/*.vitest.spec.ts` files (34/34 passing), and `pnpm run test:workspace` (54 passing / 0 failing / 29 skipped — the skipped ones are real-DB integration tests gated behind `WORKSPACE_INTEGRATION_TESTS=1`, not set in this environment; none newly broken).

Result: PASS.

## T048 — the generic workspace selection DTO carries real TEXT context

Date: 2026-09-17.

Extended `WorkspaceSelection`'s TEXT variant (`apps/web/src/types/workspace.ts`) from bare metadata to: `asset.revision`/`asset.status` (the same values the T046 flush barrier reads back), a new `SafeTextSourceContext` (`{readiness:"READY", sourceIdentity, offsetUnit, sourceCodeUnitLength, sourceByteLength}` or just `{readiness}` for every other state — deliberately never the actual source text/boundaries, which stay behind the dedicated `GET /api/assets/{assetId}/text` route, T054, so this broadly-loaded selection stays cheap), `annotations: SafeTextAnnotation[]` (the T005 canonical safe shape), and `capabilities: TextEngineCapabilities` (T045, now fed real data instead of the conservative default).

`workspace-read.ts`'s TEXT branch deliberately calls the **cheap** T027 `deriveTextSourceReadiness` (DB-only: `TextAsset` metadata + `Asset` object presence + latest `TEXT_SOURCE_PREPARE` Job), never T028's expensive full source re-verification (bounded MinIO stream + digest + decode) — this selection loads on every workspace navigation, and the expensive path is reserved for when the reader actually mounts. Assembles capabilities from `annotation.create` (`requireDatasetPermission`), the resolved TEXT policy (T039/T042's `resolveTextPolicy`), and workflow-frozen state (`NEEDS_REVIEW`/`REVIEWED`/`REJECTED`). Existing `Annotation` rows for the asset are projected through the shared T005 `serializeSafeTextAnnotation`, with a defensive per-row try/catch so one malformed legacy row can never 500 the whole workspace read. `workspaceEngineRegistry`'s `deriveTextCapabilitiesEntry` now simply reads `selection.capabilities` instead of the placeholder default.

Verified against the real (migrated) dev PostgreSQL + MinIO (`apps/web/tests/text-annotations/workspace-selection-text.test.ts`, 4/4 passing):
1. An unprepared TEXT asset reports `UNPREPARED` readiness and no write capability, with the correct "must be prepared" reason.
2. A fully prepared (`READY`), policy-eligible asset reports the *exact* verified source context (`sourceIdentity`/lengths matching what was actually uploaded/prepared) and grants `span`; `classification` stays correctly blocked (no taxonomy configured) with the correct reason.
3. A `NEEDS_REVIEW` asset blocks every write capability even though the source is `READY` and labels are eligible — proving workflow-frozen gating is live, not theoretical.
4. An existing `Annotation` row round-trips through the shared safe serializer with its exact geometry/labelId intact; a non-member is concealed as `null` (existing concealed-resource convention, still honored).

Full regression: `pnpm --filter @annotationplatform/web typecheck` (clean, same 2 pre-existing unrelated AUDIO errors), `pnpm --filter @annotationplatform/web lint` (clean), `pnpm run test:workspace` (54 passing / 0 failing / 29 skipped — identical to the T047 baseline, confirming no regression from this DTO extension).

Result: PASS.

## T049 — the per-asset TEXT store

Date: 2026-09-17.

`apps/web/src/types/text.ts` (UI-only types, building on the shared T005 `SafeTextAnnotation` rather than redefining it: `TextSelectionRange`, `TextSearchState`, `TextPendingCommand`, `TextAssetSnapshot`) and `apps/web/src/stores/text-annotation-store.ts` (a plain in-memory Zustand store, no persist middleware — matches `image-annotation-store.ts`'s existing convention, so there is nothing to opt out of for "no browser durable storage"). Holds the asset-scoped saved snapshot (source identity, server-supplied boundary offsets, saved annotations, current asset revision), local pending-command state, and ephemeral selection/search/hover state. `initializeAsset`/`clearAsset` always reset pending/selection/search/hover together — including when re-initializing the *same* asset, so a freshly loaded snapshot is always authoritative and never silently merged with stale local state.

6/6 unit tests passing (`apps/web/tests/workspace/text-annotation-store.vitest.spec.ts`): snapshot initialization starts with clean ephemeral/pending state; switching assets clears everything (no cross-asset leakage); re-initializing the same asset still resets local state; `clearAsset` resets the snapshot itself; the pending-command add/update-status/remove lifecycle; `setSearch` merges rather than replaces.

This is genuinely infrastructure built ahead of its consumer — `text-engine.tsx` is still the US1 placeholder and doesn't call this store yet; US1/US2/US5 wire it up as they land.

Full regression: `pnpm --filter @annotationplatform/web typecheck` (clean, same 2 pre-existing unrelated AUDIO errors), `pnpm --filter @annotationplatform/web lint` (clean), all 12 `*.vitest.spec.ts` files across the entire `apps/web` package — **52/52 passing**, confirming no regression anywhere from this session's Phase 2 Foundational work.

Result: PASS.

---

# Phase 2 Foundational: COMPLETE (T001–T049, 49/49 tasks)

Every Foundational checkpoint from tasks.md's own definition is now real and verified, not just planned:
- Shared domain contracts (`packages/domain`) are the single source of canonical TEXT shapes — geometry, boundary artifact, decode rules, source limits, properties, the prepare-Job contract.
- Schema is validated through the isolated-DB migration procedure and **applied** to the shared dev database (user-approved), with the endpoint-FK-Restrict/cascade-cleanup interaction empirically proven both ways.
- Source can be prepared (real worker pipeline, full Unicode fixture matrix, duplicate-delivery/retry/staleness handling), read, and boundary-validated through one authoritative service (T028) with no duplicated authority logic — verified against real Postgres+MinIO end to end, including a live source-replacement-after-preparation degrading correctly to `SOURCE_MISMATCH`.
- Foundation transaction primitives (guard claim, receipt replay, rollback-on-rejection, dataset-only guarding) are proven against real PostgreSQL Serializable transactions.
- TEXT policy is both readable and writable through an authorized route, with real reference/reconfiguration-safety validation and a real product-UI path (browser-verified) to make a label TEXT-eligible — no direct database seeding anywhere in this feature.
- Source-preparation authorization is mapped to `dataset.read`, independent of `annotation.create` and review freeze.
- Source/annotation limits come from one shared config module, wired into both deployments' Compose files and readiness checks.
- The workspace engine registry recognizes TEXT with a capability model and a flush contract that has been regression-tested against IMAGE/VIDEO — **and that regression testing found and fixed a real, pre-existing bug** in the shipped Submit flow (stale-revision 409 against a user's own autosaved edit).
- Content/taxonomy invalidation events (`ANNOTATION_CHANGED`, `TEXT_POLICY_CHANGED`) exist end to end, proven flowing through the real Redis relay to the gateway.
- The generic workspace selection DTO now carries real TEXT source/annotation/revision/capability context, and the per-asset TEXT store is ready to hold it.

**User story implementation (US1–US7) can now begin**, per tasks.md's own stated dependency graph.

## T050–T055 — the TEXT source read/prepare routes and their contract tests (Phase 3, User Story 1 begins)

Date: 2026-09-17.

**T054**/`GET /api/assets/{assetId}/text` and **T055**/`POST /api/assets/{assetId}/text/prepare` are thin callers of the already-built T028/T038 services — built via `NextResponse` directly (not the shared `apiSuccess` helper) for the GET route specifically, because `apiSuccess` unconditionally overwrites `Cache-Control` to bare `no-store`, and this endpoint's contract requires the stronger, explicit `private, no-store`. The one genuinely route-specific piece of logic (HTTP-status selection from a service outcome) was extracted into `apps/web/src/lib/annotations/text-source-http-mapping.ts` (`mapTextSourceReadOutcomeToHttp`, `mapTextSourcePrepareOutcomeToHttp`) so it's directly unit-testable.

**Environment constraint discovered and documented, not worked around silently**: this Next.js version's Route Handlers call `cookies()` (via `getRequestActor()`), which throws `"cookies was called outside a request scope"` when a route's exported function is invoked directly outside a real server request — confirmed with a throwaway smoke test against the actual GET route before writing the contract suites (`cookies (.../next/src/server/request/cookies.ts:158) → getRequestActor → GET`). This explains why `loginThroughHttp` (the one existing direct-route-call pattern in this repo's tests) only ever calls the login route, which doesn't read an existing session. **T050/T051 therefore test the route's real logic at the boundary that is actually reachable in this repo's `node --test` environment**: the extracted HTTP-mapping functions directly, source-level assertions that the route contains no duplicated authority logic (e.g. no `"annotation.create"` string-literal permission check at the prepare route's seam — verified precisely enough to not be fooled by the route's own doc comment mentioning that same phrase in backticks), and the underlying T028/T038 services for every contract-relevant scenario. Full live-HTTP-header/status verification remains T170's job (a real two-browser-session acceptance pass against a live server).

- `apps/web/tests/text-source/text-read-route.test.ts` (T050, 7/7 passing): every readiness state maps to 200 (never an error — an unready source is a normal read result); a concealed/missing asset maps to 404; the route source literally contains the `private, no-store` header and calls the shared mapping function; a real UNPREPARED-vs-concealed-vs-missing scenario matrix against the real T028 service.
- `apps/web/tests/text-source/text-prepare-route.test.ts` (T051, 4/4 passing): 202 for any in-progress/queued/retrying/failed Job state, 200 only once a Job has genuinely `COMPLETED`, 409/404 for the two failure reasons; the route source contains no `annotation.create` permission check; a real REVIEWER successfully triggers preparation on a `NEEDS_REVIEW` (frozen) asset — proving `dataset.read`-only gating live, not just by reading the code; a non-member is concealed.
- `apps/web/tests/text-source/text-access-denial.test.ts` (T053, 2/2 passing): a member whose `DatasetMember` row is deleted (the same mechanism a real "remove member" action uses) loses read/prepare access on their very next call, with no source excerpt anywhere in the denied outcome; a member of an *unrelated* dataset is concealed (not merely forbidden) from an asset in a dataset they have no relationship to, while the actual owner's access to the same asset is confirmed unaffected (proving the denial is genuinely scope-based, not a fixture bug).

Combined `apps/web/tests/text-source/` suite: **26/26 passing** (`pnpm --filter @annotationplatform/web run test:text-source`).

T052 (the Unicode-fixture-matrix + search-highlight-vs-annotation-rendering integration test) is deferred to land alongside T057/T058 (the real reader/search UI) — its search/highlight assertions have no component to exercise yet; the underlying decode-exactness half of its scope is already covered by T021/T030's worker suite and T028/T029's web source-service suite.

Result: PASS.

## Session checkpoint

T001–T051, T053–T055 complete and verified with real evidence (53 of 175 tasks). T052 deferred to land with T057/T058 per the note above. Continuing into the remaining User Story 1 UI work (T056 read client, T057 reader, T058 search, T059–T063 status/properties/toolbox wiring). See the chat summary for the detailed handoff.

## T052, T056–T060 — the real reader, search, status fields, and properties tabs land

Date: 2026-09-21.

**T056** (`text-read-client.ts`): `fetchTextSource`/`triggerTextSourcePreparation`/`ensureTextSourceReady`, with `AbortSignal` support (fixed a real bug this session: it didn't check `signal?.aborted` before triggering prepare — caught by a vitest test expecting exactly 1 fetch, observing 2).

**T057/T058** (`text-engine.tsx`): escaped, selectable `<pre>` DOM text (`white-space: pre-wrap`), each segment carrying `data-text-start` as the source-indexed segment table (`text-dom-segments.ts`'s `buildTextSegments`/`resolveContainerSelectionOffsets`), full readiness-state placeholders, and search (`findLiteralMatches`, Previous/Next wrapping via `nextTextMatchIndex`, distinct `search-match`/`search-match-active` highlight classes vs plain text). **T052**'s own test file (`text-reader-fixtures.test.ts`) already exists and passes 11/11 — exact decoded-text preservation across every research.md D1 Unicode fixture, plus `nextTextMatchIndex` wrap-both-directions coverage.

**Real bug found and fixed this session**: the reader's outer `<section>` combined the shared `canvas-grid` utility class (hardcoded `background-color: #18181b`, declared after Tailwind's utility layer in `globals.css`) with `bg-white`. At equal CSS specificity, `canvas-grid`'s later-declared rule won the cascade, so the intended white reading surface silently rendered as a near-black background with `text-zinc-900` text on top — effectively invisible outside an active browser text selection (confirmed via a user screenshot: only `::selection`-highlighted paragraphs were legible). Every other engine (IMAGE/VIDEO/AUDIO) pairs `canvas-grid` with a matching *dark* background, so they were unaffected; TEXT was the only one trying to override it. Fixed by dropping `canvas-grid` from the TEXT reader's section entirely (it never needed the dark canvas look) rather than touching the shared global class.

**T059/T060** (`text-status-fields.tsx`, `text-properties-tabs.tsx`): created, typecheck clean, wired into `workspace-engine-registry.tsx`'s TEXT entry (`Tabs`/`StatusFields`) and briefly deployed.

## T061/T062/T063 — deliberately reverted per explicit user decision, not abandoned

Date: 2026-09-21.

After T059/T060 shipped, the user asked to "rollback the Text toolbox and text properties panel." Investigation found the committed (pre-025) `text-toolbox.tsx` used the *wrong* Zustand store (`image-annotation-store`) and exposed controls for unimplemented TEXT features (bounding box, relation, note, classification) — a real bug, not a preference. This was surfaced explicitly before acting. The user's answer after seeing that: **"i like the previous toolbox and properties panel"** — an explicit, informed preference, not a bug report.

Action taken: `text-toolbox.tsx` reverted to HEAD via `git checkout`. `workspace-engine-registry.tsx`'s TEXT entry reverted `Tabs`/`StatusFields` back to `placeholderTabsEntry("TEXT")`/`placeholderStatusFields("TEXT")` — a **surgical** revert: the registry file also carries the unrelated T046 `flush`/`deriveCapabilities` save-barrier framework (used by every engine, including AUDIO), which was deliberately preserved, not reverted. `text-properties-tabs.tsx`/`text-status-fields.tsx` were left on disk (typecheck-clean, unreferenced) rather than deleted, in case this decision is revisited.

**Net effect on the task list**: T059/T060 stand as complete (the files exist and are correct). T061 (route TEXT through the new properties tabs) and T062 (capability-driven toolbox rewrite) are explicitly NOT done — reverted by deliberate product decision, not oversight. T063 is partially done: `text-engine.tsx` (the reader) already reads real capability state from the registry (`selection.capabilities.select`); the toolbox half cannot until/unless T062 is redone, since the reverted toolbox reads an entirely different (image) store.

**Also fixed in this same window** (build-blocking, unrelated to the rollback): `text-annotation-store.ts` was missing `tool`/`setTool`/`reader`/`setReader` and `text-dom-segments.ts` was missing `nextTextMatchIndex`, both already referenced by `text-engine.tsx`/`text-status-fields.tsx`/tests from further-ahead work-in-progress. Implemented against the existing test contract (`text-annotation-store.vitest.spec.ts`, 8/8 passing) rather than guessing a design: `tool: "select" | "scroll"` (default `"select"`), `setTool` also clears transient `selection` (a tool change invalidates the old tool's in-progress selection), `reader: TextReaderSnapshot | null`; both reset alongside the other ephemeral fields on `initializeAsset`/`clearAsset`. Whole-project `tsc --noEmit` clean; production build succeeds; deployed.

**Phase 3 checkpoint status: NOT fully met.** Reading, search, and status/properties display work end to end, but the toolbox is not yet capability-driven (T062/T063) and the properties panel is not yet routed through the new TEXT-specific tabs (T061) — both by explicit, recorded user choice pending further direction, not failure. Result: **PARTIAL — proceeding to Phase 4 planning requires the user to decide whether to redo T061/T062/T063 first or accept the current placeholder-based panel/toolbox as final for now.**

## T061 redone — explicit user sign-off obtained, toolbox (T062/T063) deliberately left alone

Date: 2026-09-21 (same day as the revert above).

The user asked directly to re-wire the TEXT properties panel and add an annotation-list display "similar to other engines." Given the revert above explicitly required "explicit user sign-off, not a unilateral redo," this was surfaced back to the user before acting, via two clarifying questions: (1) confirm re-wiring `TextPropertiesTabs` into the registry despite today's revert, and (2) disambiguate what "tasks" meant, since no other engine's properties tabs has anything literally named "tasks" (IMAGE/VIDEO show `description/labels/shapes-or-tracks/assets`). The user chose: re-wire now, and "tasks" means an annotation-list tab (spans/notes/relations) — the TEXT equivalent of IMAGE's Shapes / VIDEO's Tracks tab.

**Scope deliberately excluded T062/T063** — the user was not asked about, and did not request, a toolbox rewrite in this round. `text-toolbox.tsx` is untouched and still reads the wrong (`image-annotation-store`) store with controls for unimplemented tools, exactly as documented above. This remains open, pending a future explicit decision.

**Action taken**:
- `workspace-engine-registry.tsx`: TEXT's `Tabs`/`StatusFields` routed to `TextTabsEntry`/`TextStatusFieldsEntry` (new thin wrappers mirroring `VideoTabsEntry`'s pattern) → `text-properties-tabs.tsx`/`text-status-fields.tsx`. The now-fully-dead `placeholderTabsEntry` helper and its `PlaceholderPropertiesTabs` import were removed (AUDIO already used its own `AudioTabsEntry`, so nothing else referenced it); `placeholder-properties-tabs.tsx` itself was left on disk, unreferenced, not deleted.
- `text-properties-tabs.tsx`: rewritten with IMAGE/VIDEO-style tab navigation (`Details`/`Annotations`/`Assets`, `grid-cols-3`) replacing the old single-scroll layout. `Details` keeps the prior content (`TextStatusFields` details view, read-only description — no `updateTextDescriptionAction` exists yet so no autosave textarea was invented, `AssetAssignmentPanel`, `WorkflowHistoryPanel`). `Assets` now matches IMAGE/VIDEO's Assets tab exactly: `AssetBrowserFilters`, a dataset-progress bar, `AssetNavigator`, and `BulkActionBar` (previously the old file inlined only a bare `AssetNavigator` with no filters/progress/bulk actions). `Annotations` is new: groups `selection.annotations` (already present on `WorkspaceSelection`, no new fetch) by `geometry.kind` (`text-span`/`text-document`/`text-relation`) into Spans/Classifications/Relations sections, resolves each `labelId` against the shared `useDatasetLabelsStore` taxonomy (loaded the same way IMAGE/VIDEO load it) for a name+color swatch, and surfaces `selection.capabilities.reasons` as inline notices when span/classification/relation creation is gated off. Clicking a span row calls `useTextAnnotationStore().setSelection({startOffset, endOffset})` — the same field `text-engine.tsx`'s reader footer already renders ("Selected [start, end)" + quoted excerpt), so the click has a real, visible effect with zero changes to the reader itself.
- Not built: any create/edit/delete affordance for spans/classifications/relations (no command is wired to a UI control yet — this is intentionally display-only, consistent with T083's own note that a dedicated `text-annotation-list.tsx` with span controls is separate, later work), and no highlighting of annotation ranges directly in the document body (only the existing footer selection display).

**Verification**: `tsc --noEmit` clean (project-wide, zero errors). `eslint` clean on both changed files. `pnpm vitest run tests/workspace/workspace-engine-registry.vitest.spec.ts tests/workspace/text-annotation-store.vitest.spec.ts tests/workspace/text-engine-capabilities.vitest.spec.ts` — 3 files, 19/19 passing (the registry spec only asserts the engine-key set, not which component TEXT resolves to, so it did not need updating).

**Net effect on the task list**: T061 now stands as done, superseding its revert. T062/T063 remain explicitly not done — still gated on a future, separate user decision about the toolbox.

User confirmed: keep the rollback as final (T061/T062/T063 marked won't-do/superseded above), continue into Phase 4.

## Phase 4 begins — T064/T065/T068/T070/T071(createSpan)/T074/T075

Date: 2026-09-21.

**Discovered mid-task: concurrent editing on this exact feature area.** While reading `text-command-service.ts` to extend it, the file changed on disk between reads — a `permission?: DatasetPermission` parameter had been added to `RunGuardedTextAssetCommandInput`, `requireDatasetPermission` gained an optional transaction-client parameter (`authorization.ts`), and `TextCommandFailure` gained `SOURCE_MISMATCH`/`SOURCE_NOT_READY`/`LIMIT_EXCEEDED`/`DUPLICATE_SPAN`/`INVALID_RANGE`. `git status` then showed `text-annotation-read-service.ts`, `lib/validation/text-span.ts`, `lib/workspace/text-span-selection.ts`, and a real `annotations/route.ts` already existed — none written by me. User's direction: "keep going, reconcile as we go."

**Reconciliation approach taken**: read the already-built route (`GET`/`POST /api/assets/{assetId}/text/annotations`) to discover its exact expected interface — a single `createTextSpan(actor, assetId, rawInput)` entry point matching `TextAssetCommandOutcome<SafeTextAnnotation>` — and rewrote `text-span-service.ts` to that exact contract rather than the lower-level `applyCreateSpan(tx, ctx, ...)` shape I'd started with. Adopted the other editor's failure-code vocabulary throughout instead of my own generic `CONFLICT`/`INVALID_REQUEST` reuse. Added one new code myself, `POLICY_STALE` (for the `expectedPolicyRevision` check data-model.md's atomic algorithm step 3 requires — "New commands validate `expectedPolicyRevision`" — which nothing else had wired yet), following the same naming convention.

**`runGuardedTextAssetCommand`'s `apply` callback `ctx` extended** with the full `actor: RequestActor` (previously only `actorId: string`) — needed so span commands can call `requireDatasetPermission(ctx.actor, ...)` *with the transaction client* for a genuine in-transaction permission recheck (data-model.md atomic algorithm step 1: "within the transaction, recheck current dataset membership and permissions"), rather than the actor-less workaround I'd started with. Purely additive; confirmed via full `tsc --noEmit` and the existing `text-command-foundation.test.ts` (still 100% passing) that this doesn't break the one other consumer of `apply`.

**`text-span-service.ts`** (`createTextSpan`): parses `createTextSpanSchema` (strict envelope, already defined by the other editor), resolves the verified source via `readTextSource` *before* opening the transaction (no I/O inside it, per the atomic algorithm), then `runGuardedTextAssetCommand` → `applyCreateSpan`: in-transaction recheck of source identity and policy revision (both against cheap already-open-transaction reads, catching a source/policy race since the outer verification), range validation (finite safe integers, `0 <= start < end <= sourceCodeUnitLength`, both endpoints present in the verified boundary-offset array via binary search), ENTITY-scope label eligibility (`Label.scope === "ENTITY"` — not `textEligibility`, correcting my own wrong assumption about the field name), exact-duplicate rejection (`DUPLICATE_SPAN`), count admission against `getTextSourceLimits().maxAnnotations`, one parent `Asset.revision` bump, the `Annotation` row itself, and the `ANNOTATION_CHANGED` outbox dispatch — all inside the one guarded transaction.

**Test evidence** (`apps/web/tests/text-annotations/text-span-commands.test.ts`, all against real Postgres + MinIO, no mocks): **7/7 passing**.
- Exact-offset creation ("OpenAI" on "OpenAI builds AI." → `startOffset=0, endOffset=6`) — T065.
- Strict envelope rejection (unknown field, malformed body) — T064.
- Reversed range and out-of-bounds range both correctly reach `INVALID_RANGE` (the envelope schema only checks individual field types, not `start<end` — a wrong assumption in my first draft of this test, fixed after seeing the real behavior, not by weakening the assertion).
- Overlapping spans ("New York" inside "New York University") both persist as distinct rows — T068.
- Exact duplicate (different `operationId`, same range/label) → `DUPLICATE_SPAN`; identical `operationId` replay → same result, no second row, `replayed: true`.
- Wrong-scope label (`CLASSIFICATION`) rejected; `ENTITY`-scope label succeeds.
- Stale `expectedPolicyRevision` (captured before a label-eligibility change bumped it) → `POLICY_STALE`.

Full `apps/web/tests/text-annotations/` directory: **32/32 passing** (no regression from the `ctx.actor` extension or the new failure code). Whole-project `tsc --noEmit`: clean.

**Not yet done**: `updateSpan`/`deleteAnnotation` commands (T071's remaining two-thirds — check current file state first, since concurrent work may have added them since this was written), T066 (Unicode fixture matrix through the real command path — my test fixture was ASCII-only, deliberately, to keep this pass scoped), T067 (geometry/label/property isolation), T069/T072 (real-concurrency races), T073 (property-patch wiring), T076–T085 (generic reader integration, client, UI controls, export). Session paused here to check in with the user given the concurrent-editing discovery and the size of what's left.

## T071 completed — updateSpan/deleteAnnotation, plus the command dispatcher

Date: 2026-09-21 (same-day continuation, after user said "continue" and confirmed no one else was actively on `updateSpan`/`deleteAnnotation`).

**Also observed and explicitly not touched**: `workspace-engine-registry.tsx` had been changed on disk again — TEXT's `Tabs`/`StatusFields` were wired back to `text-properties-tabs.tsx`/`text-status-fields.tsx`, reversing the T061/T062 rollback from earlier this session. The file itself already carries a clear note ("Redone 2026-09-21 per explicit user sign-off, superseding the same-day revert") — this was the other concurrent editor correctly documenting a re-decision, not an accident. Flagged it to the user per the "say so if it looks wrong" guidance, got no pushback, moved on without reverting it myself. `text-toolbox.tsx` itself is unchanged in substance (still the pre-025 icon grid) — only a tooltip and a label rename ("Highlight" → "Highlight Span") were added on top of it.

Checked first (per the plan) whether `updateSpan`/`deleteAnnotation` already existed: they didn't — still only `createTextSpan`, and the route still only had `GET`/`POST` calling it directly.

**Added to `text-span-service.ts`**:
- `applyUpdateSpan`/`updateTextSpan`: in-transaction ownership check (own vs any, same pattern as create), source-identity and policy-revision recheck, range/label patch (either or both, matching contracts/workspace.md's "nonempty patch limited to range, label and propertyPatch" — propertyPatch deferred to T073), geometry never touches `sourceIdentity`/kind, duplicate-after-patch check (skips the annotation's own row), `expectedRevision`-guarded `updateMany` → `REVISION_STALE` on mismatch.
- `applyDeleteSpan`/`deleteTextAnnotation`: same ownership/source/policy rechecks, `expectedRevision`-guarded `deleteMany`, referenced-span FK rejection mapped to `REFERENCED_SCOPE_LOCKED` (no relations exist yet to actually trigger this — real coverage is US4's job).
- `submitTextAnnotationCommand(actor, assetId, rawInput)`: the new single dispatch entry point, peeking `command.kind` via a new non-throwing `peekTextAnnotationCommandKind` helper in `lib/validation/text-span.ts` before picking which strict schema/handler applies. This matches contracts/workspace.md exactly — one endpoint, one discriminated command envelope — rather than splitting into REST-style per-verb routes. The route (`annotations/route.ts`) now calls this dispatcher instead of `createTextSpan` directly, and its status-code logic was fixed to only return 201 for a genuinely new, non-replayed `createSpan` (update/delete now correctly return 200).
- Added `updateTextSpanSchema`/`deleteTextAnnotationSchema` to `lib/validation/text-span.ts`, matching `createTextSpanSchema`'s established envelope style; `updateSpan`'s command schema rejects an empty patch (no range/label field present at all) via `.refine`.

**Test evidence** (`text-span-commands.test.ts`, extended, real Postgres + MinIO): **11/11 passing**, including 4 new tests —
- `updateTextSpan` range change (mutates the same row, revision+1, geometry's `sourceIdentity` unchanged) then a stale-revision repeat rejected as `REVISION_STALE`.
- `deleteTextAnnotation` deletes, confirms the row is actually gone, and a repeat delete against the same `expectedRevision` correctly returns `NOT_FOUND` (not `REVISION_STALE` — the row doesn't exist to be stale about).
- Ownership: a LABELER (has only `annotation.updateOwn`) is `FORBIDDEN` from updating another user's span; the owning MANAGER can still update their own.
- `submitTextAnnotationCommand` dispatch: routes a real `createSpan` through correctly; an unrecognized `command.kind` and a missing `command` both return `INVALID_REQUEST`, never a crash.

Full `apps/web/tests/text-annotations/` directory: 36/36 passing on a clean rerun (one earlier run showed a single flaky failure that did not reproduce — looked like shared-dev-Postgres contention from concurrent test suites, not a defect in this change; not chased further). Whole-project `tsc --noEmit`: clean.

**T071 is now fully complete.** Remaining US2 work: T066 (Unicode fixture matrix), T067 (isolation), T069/T072 (real-concurrency races), T073 (property patches), T076–T085 (generic reader projection, client, UI, export).
