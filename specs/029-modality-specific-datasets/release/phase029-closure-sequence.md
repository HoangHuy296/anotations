# Phase 029 closure sequence (objective set by the release owner, 2026-10-06)

**Status: prepared, nothing executed.** The blocker is operational authorization, not code. Gate A (G-MIG) cannot start until the real release owner/operator supplies the five per-run fields; none is invented here. The frozen release is never modified to carry the response-field change: M24/M25 roll out from the frozen artifact first, the approved web change set follows after postflight.

Written for: the release owner and operator.

## 1. Target end state
| Layer | Expected final state |
| --- | --- |
| Database (after G-MIG) | exact reviewed M24 then M25 applied in order; history clean at **25** migrations; M24/M25 checksums equal the frozen bytes (`13f0e977…`, `a8ffbc84…`); live schema = the expected post-M25 manifest of **1842** entries with the pinned digest; Prisma schema and generated client compatible with the live DB; no historical migration rewritten; no unrelated historical data modified |
| `/workspace/{datasetId}` | `Dataset.modality` in the authoritative state/response; engine, toolbox/tabs and IMAGE AI target derive from it; selected Asset, query modality and stale client state cannot override it; unresolved historical Dataset selects no engine; foreign/forged Asset cannot override |
| `/datasets/imports` | fresh and replay creation responses expose persisted `data.dataset.modality`; downloaded bytes classified server-side; mismatch rejected, never published; replay/idempotency/accounting intact |
| `/datasets/local-folder` | preparation response exposes `data.dataset: { id, modality }`; stored bytes classified server-side; filename/extension/declared MIME/client hints never establish modality; invalid or mismatched content fails closed; replay/preparation intact |
| Synchronous media | partial/truncated PNG → `422 INVALID_MEDIA`, nothing published |
| VIDEO / Ogg | stays fail-closed (T022/A2); no weak classification to force closure |
**G-MIG + G-DEPLOY alone do not deliver the response fields or the 422**; they put the frozen schema/runtime on shared dev. The change set in step 4 does.

## 2. Closure sequence
1. **G-MIG / Gate A** — frozen commit `1ba21bb0545c6417261bd5ed8cd222f327f0b4ec`, tree `715638966323d91fd29a709d6ed8e8e0f416a230`, from `/home/aioz-huy/anotations` (resolved path verified, mismatch fails closed): fresh baseline + HS-01…HS-10 → capacity → backup/restore proof → controlled stop → M24 → verify → M25 → verify live history/schema/client compatibility. Every HOLD/ABORT rule stays; failure after M24 starts = services stopped, FIX-FORWARD, never automatic reversal or old-image start.
2. **G-DEPLOY** — start only the frozen images (web `sha256:107602f2…`, worker `sha256:e26aefb6…`, by id, never `:latest` or a rebuild); realtime unchanged with its compatibility check; the full frozen postflight/health/regression package. Migration success without a passing deployment/postflight does not close G-DEPLOY.
3. **T029 gate** — window-time T029 observation with real storage stat; **STOP**; return the exact manifest hash and candidate IDs. T031 is a separate human gate (no approved-ID manifest, no apply, the 28-candidate count is not authority).
4. **Post-rollout three-flow change set** — only after steps 1–2 postflight PASS: new branch from the *actual released source* (never the A2 branch); RED tests first (RED must fail for the intended missing behavior, preserved), then implement exactly the approved items: response modality (repository, local-folder), Dataset-authoritative IMAGE AI target, partial-PNG 422, stale-test repair. Contract and RED→GREEN rules: `post-rollout-web-change-set.md`.
5. **Three-flow acceptance** — receipt-owned Stage-1 HTTP runtime (real PostgreSQL, Redis, MinIO) is the required final proof (no alternative pre-approved); unit/mock tests are supporting only. Return the matrix: flow → authoritative modality source → response shape → server-side validation boundary → negative cases → replay/idempotency → evidence receipt.
6. **Phase 029 closure audit** — classify every remaining task (below); nothing is closed because the rollout succeeded.

## 3. Entry conditions for step 1 (all must be concretely supplied by the owner)
```
authorizedBy:          <real human operator>          # also the stop/restart operator
windowDuration:        <exact bounded duration>
expiresAt:             <absolute time, within the 4 h authorization limit>
privateCredentials:    <available through the approved private path at window time>
sharedDevChangeFreeze: <explicitly confirmed, from <time> to window close>
```
Bound automatically by the package: release commit, release tree, web/worker image ids above, canonical path. The shared-dev web service already changed once during preparation (container restarted 12:32 UTC, `web:latest` moved), so the freeze must precede the authoritative baseline and any unexpected container/image replacement afterwards is HOLD.

## 4. Preliminary task audit (final audit is step 6)
| Task | Classification now | What closes or decides it |
| --- | --- | --- |
| T009 (G-MIG) | BLOCKED on Gate A | step 1 evidence on shared dev (disposable proof already exists) |
| T037 (G-DEPLOY) | BLOCKED on Gate A | step 2 |
| T036 (regression) | BLOCKED | post-cutover regression + step 5 |
| T038 (rollback/evidence report) | BLOCKED | after steps 1–5; G5 stays a separate gate |
| T025, T026 (workspace validation/tests) | BLOCKED — partial evidence | step 5 plus the G-DEPLOY browser/a11y smoke (flush-before-navigation, lifecycle destinations, reopened-viewer guard) |
| T022 (ambiguous synchronous formats / VIDEO) | DEFERRED BY APPROVED SCOPE (A2/M26 follow-on) | A2 contract is frozen; implementation pending, not part of rollout closure |
| T027 (EMPTY-resolution evidence: manager-denied, audit, concurrent insert) | REQUIRES SEPARATE DECISION | owner decides whether to prove it before closure |
| T028 (anchored panel UI) | REQUIRES SEPARATE DECISION | its own approved change |
| T030 (523 unverified source assets / 22 missing subtypes) | REQUIRES SEPARATE DECISION | historical remediation, Cohort C |
| T032 (MIXED) | REQUIRES SEPARATE DECISION | future approval; stays null/blocked |
| T034 (two-connection races) | REQUIRES SEPARATE DECISION | tied to G3; not claimed by any rollout evidence |
| T035 (composite FK/NOT NULL) | DEFERRED BY APPROVED SCOPE | only after all history is resolved |
| T031 (apply to approved Cohort A) | REQUIRES SEPARATE DECISION | separate human gate after T029 review. Note: `tasks.md` shows two `T031` lines marked done — they record the *tooling* verification; the shared-dev **apply** has not run and must not be read as closed. |
| T001–T008, T010–T021, T023, T024, T029, T033 | CLOSED (per `tasks.md` evidence) | — |
G3/G5 status is unchanged and independent of this sequence.

## 5. Not allowed to shortcut
No modification of the frozen release commit or images to add the response fields; no weakening of DB invariants or server-side validation to obtain a green flow test; no T031, T030, T032, EMPTY or MIXED resolution inside the window; no A2/M26 until its own authorization.
