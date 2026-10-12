# Feasibility report — Dataset.modality as the workspace-engine source (imports / local-folder / workspace / AI detect)

**Status: analysis and plan only. No application behavior was changed for this report; the only additions are one read-only feasibility test and its catalog entry.** Evidence ran on disposable infrastructure (canonical 25-migration chain), never on shared dev, and counts as neither G3 nor G5 evidence.

Written for: the release owner deciding the post-rollout transition work.

Companion and plan of record: `../workspace-transition-feasibility.md` (the fuller, contract-level plan, which also covers Phase 026 HG-1, acceptance-transaction rechecks and the test matrix). **Reconciliation (2026-10-06):** both reach the same conclusion. Where they differ, the companion governs: (a) the local-folder response addition is `data.dataset: { id, modality }` beside `data.preparation` (not a field inside the preparation object), and `from-repository` gains `data.dataset.modality`; (b) IMAGE bulk AI is verified for N=1..3 (`AI_BATCH_VERIFIED_MAX_ASSETS`), N=4 refuses; the platform selection ceiling of 200 is not an inference limit; (c) bulk result persistence stays subject to HG-1. This report adds executed evidence (run ids in §7) and one catalog entry, `web:test:modality-workspace-feasibility`, that the companion's "no guard/catalog changes" note predates.

## 1. Question
After the Phase 029 rollout gates (shared-dev M24/M25 via the launcher, T029/T031 for approved Datasets, coordinated web + worker deployment), will `/datasets/imports`, `/datasets/local-folder` and `/workspace/{datasetId}` operate with `dataset.modality` in their responses, with the workspace engine chosen from it, and with bulk selection able to use the AI-detect tool? What is still missing, and how do we get there?

## 2. What already holds (verified, not assumed)
| Capability | Finding | Evidence |
| --- | --- | --- |
| Every new Dataset has exactly one modality; none can be created without one | DB rejects a Dataset without a modality; the metadata projection (`datasetMetadataSelect`) serializes `modality` for create/read/PATCH responses | feasibility test F1 (PASS) |
| Workspace engine selection | `readWorkspacePage`/`readWorkspaceSelection` choose the engine solely from `Dataset.modality`; four empty shells; own-modality selection works; a client-supplied modality or selected-asset hint cannot override; an Asset of another Dataset is never content; a mixed-modality Asset cannot be created (M24 trigger) | feasibility test F2 (PASS) |
| Bulk selection → AI-detect target | `resolveAiTarget` resolves explicit/filtered/current selections per Dataset; IMAGE batches resolve; one VIDEO resolves; VIDEO batches, AUDIO and TEXT return `AI_CAPABILITY_UNVERIFIED` (explicit, not silent); foreign Assets in a selection are refused whole | feasibility test F3 (PASS) and `ai-batch-targets` tests 1–5, 7, 8 (PASS) |
| Prisma client compatibility across web / worker / realtime | web, worker and realtime typecheck clean against the tracked client (M24/M25 fields); **realtime has no Prisma or modality code** (collaboration/presence only), so it is unaffected; old-client reads against the 25-migration schema are proven by `g2:compatibility` inside the chain plan | `tsc` ×3 clean; `release:phase029-chain` PASS `20261006T084001Z-6fc0de09` |
| Imports UI | modality selection card, class entry model, creation form state | vitest 70/70 via `web:test:imports-ui:vitest` run `20261006T115608Z-0b090e9a` |
| Worker enforcement | repository import refuses unresolved Datasets, rejects class ≠ Dataset modality item-by-item, reconciliation reuse validates parent | `worker:test:ingestion-replay-reuse` PASS (earlier) and `worker:test:classification-boundary` PASS |
Feasibility test run: `web:test:modality-workspace-feasibility` PASS 3/3, `focused-runs/20261006T115517Z-08c4ed01`, on the full 25-migration chain.

## 3. Gaps found (the statement "responses include `dataset.modality`" is only partly true today)
| # | Gap | Where | Effect |
| --- | --- | --- | --- |
| G1 | `POST /api/datasets/from-repository` returns `dataset: { id, name }` only | `lib/repository-import/acceptance.ts:158` | UI/clients cannot read the fixed modality from the accept response |
| G2 | `POST /api/imports/local-folder` (and append) return a preparation `{ id, datasetId, jobId, expectedItemCount, deadlineAt, items }` with no modality | `lib/imports/prepare-local-folder-import.ts` `publicPreparation` | same; the contract (`creation-ingestion.md` §Creation) says creation projections return the safe modality |
| G3 | AI target resolution derives modality from the **selected Asset rows**, not from `Dataset.modality`; equivalent for resolved Datasets (the DB guarantees equality) but still able to produce `TARGET_MIXED_MODALITY` only for legacy MIXED history, and the AI dialog/bulk bar receive the open Asset's modality rather than the Dataset's | `lib/ai/ai-target-service.ts:78-107`, `ai-detect-dialog.tsx` | no failure for new Datasets; the spec's "Dataset-driven capabilities" is satisfied by equivalence, not by construction |
| G4 | Currently *verified* AI capability is IMAGE batches and a single VIDEO (everything else is gated, not declared unavailable by policy) | `ai-target-service.ts:81-84` | bulk AI-detect on VIDEO (≥2), AUDIO and TEXT Datasets is unavailable by design; the UI must say so from the Dataset's modality instead of discovering it per selection |
| G5 | Stale tests that predate the invariant: `ai-batch-targets` test 6 builds a mixed-modality Dataset (now `ASSET_MODALITY_MISMATCH` at the DB); `g5-modality-routing` needs the G5 history fixtures (not part of the generic plan) | `tests/ai/ai-batch-targets.test.ts`, `tests/workspace/g5-modality-routing.test.ts` | not product defects; they cannot serve as feasibility evidence and need rewriting (same class of issue as the upload suites) |
| G6 | Legacy unresolved/MIXED Datasets keep a "resolution needed" state (`modalityResolution`, `DATASET_MODALITY_UNRESOLVED`); their workspace is intentionally not an engine | `workspace-state` route, `unresolved-dataset-workspace.tsx` | correct, but the transition plan must not promise engine behavior for them before T029/T031 resolve them |
| G7 | The schema capability above requires the **database at 25 migrations and web/worker images built from the release commit** (this makes current behavior work; it does not add the response fields of G1/G2); before G-MIG/G-DEPLOY the tracked client selects columns that do not exist (observed: focused plans fail with `PreparedImport.creationRequestHash does not exist` on a 24-migration DB) | rollout package | the transition is strictly post-rollout |

### Response-shape clarification (three distinct layers — do not conflate)
1. **M24/M25 database/schema rollout (G-MIG).** Adds the persisted capability only: the four Dataset columns, the guards, `PreparedImport.creationRequestHash`. It makes the *current* release code run on the shared database; it adds no API field.
2. **Current release application behavior (G-DEPLOY images built from the release commit).** `POST /api/datasets`, `GET/PATCH /api/datasets/{id}` and `workspace-state` already return `modality`; the workspace chooses its engine from it. `POST /api/datasets/from-repository` returns `dataset: {id, name}` and the local-folder preparation returns no dataset projection, **in the release images too**.
3. **Separately approved, rollout-gated post-rollout web change set** (approved only *after* the rollout): adds `data.dataset.modality` / `data.dataset: {id, modality}` to the repository and local-folder responses, makes AI target resolution Dataset-authoritative, and repairs stale tests. The new response fields appear **only after that change set is implemented and deployed**, not as a consequence of G-MIG + G-DEPLOY. Until then clients must read the modality from `GET /api/datasets/{id}` or `workspace-state`.

## 4. Plan (no implementation here; each step is small, test-first, disposable-verified)
**Step 0 — rollout gates (unchanged, separate workstream).** Shared-dev maintenance window per `shared-dev-execution-package.md`: M24 → M25 → T029 observe → human approval → T031 apply of approved IDs → verified web + worker images from the release commit → postflight. Realtime image unchanged. Nothing below starts before this completes.

**Step 1 — response alignment (G1, G2).** Add `modality` to the accepted-import `dataset` DTO (`data.dataset.modality`) and a `data.dataset: { id, modality }` projection beside `data.preparation` for local-folder start and append, sourced from the Dataset row, never from the request echo. Update OpenAPI (`schemas/import-repository.yaml`, `openapi.yaml`), `docs:validate-openapi`, and add route-level assertions to the existing disposable plans (`web:test:local-folder-modality-idempotency`, the repository acceptance tests). Risk: low (additive field). Rollback: revert the DTO field.

**Step 2 — Dataset-authoritative AI target (G3, G4).** Pass the Dataset's modality into target resolution as the authority and keep the row check as a consistency assertion (`ASSET_MODALITY_MISMATCH` never reachable for resolved Datasets). Expose a capability projection from the Dataset (`{ aiDetect: "BATCH" | "SINGLE" | "UNAVAILABLE", maxBatch }`) in the workspace read model so the bulk action bar and `AiDetectDialog` render availability from the Dataset instead of discovering it per selection. Keep VIDEO batch/AUDIO/TEXT as `AI_CAPABILITY_UNVERIFIED` until real provider evidence exists (no behavior invented). Tests: extend `modality-engine-feasibility` with the capability projection; rewrite `ai-batch-targets` test 6 with one Dataset per modality.

**Step 3 — stale-test repair (G5).** Rewrite `ai-batch-targets` #6 and decouple a fixture-independent half of `g5-modality-routing` (the feasibility test already is that half). Do not touch the G5 evidence files. Add `web:test:modality-workspace-feasibility` to the standing regression set.

**Step 4 — UI wiring and smoke.** Engine-specific empty shells already render from `Dataset.modality`; add the capability-driven AI controls (Step 2) and run the browser/a11y smoke on disposable fixtures as part of G-DEPLOY (existing plan; this report does not run it).

**Step 5 — legacy Datasets.** Leave unresolved/MIXED Datasets in the resolution-needed state; engine behavior for them appears only after T029/T031 resolve them and the owner-controlled EMPTY-resolution path is used. No automatic split/move/relabel.

**Ordering and dependencies:** Step 1 and Step 2 are independent of each other and of the A2/M26 workstream; both change only web code and OpenAPI (no schema, no migration). They must land on a branch separate from the rollout release commit (decision D1) or after the rollout closes; the rollout images are built from its own release commit.

## 5. Risks and how the plan contains them
- **Old web image against a migrated database:** covered by `g2:compatibility` (reads) and by the fact that M24/M25 are additive; the recovery tags and verified images in the execution package remain the rollback.
- **Over-promising AI parity:** the capability projection makes unavailable modalities explicit; no modality gains AI support through this transition.
- **Test debt:** two stale suites (G5 above) would fail if used as gates; they are flagged, not weakened.
- **Mixed responsibilities with the rollout:** the guard is branching (D1) plus the fact that none of the steps touches M24/M25, the launcher pins or the execution package.

## 6. Release-owner decisions (2026-10-06)
0. **Post-rollout web change set: APPROVED, ROLLOUT-GATED** — scope frozen to four items and the three-flow tests-first gate in `post-rollout-web-change-set.md`; not started.
1. **Image freeze: APPROVED** (mc and MinIO digests frozen; see `s0-storage-authority.md`).
2. **First post-rollout web change set (response DTO `modality`, Dataset-authoritative AI target, stale-test repair): APPROVED, but only after the rollout completes.**
3. **AI capability policy: NOT frozen.** The wording "IMAGE batch, VIDEO single, everything else unavailable" is a description of what is **currently proven** (`resolveAiTarget` tests, run `20261006T115517Z-08c4ed01`), not a final product policy. The capability projection of Step 2 must therefore be built so that each modality/mode cell is `PROVEN | GATED | UNAVAILABLE` backed by evidence, and widening any cell (VIDEO batch, AUDIO, TEXT) is a separate decision that needs provider evidence; nothing in Step 2 may hard-code "everything else unavailable" as the product stance. Until the owner defines the policy, the projection reports exactly the current verified behavior and labels the rest `GATED` (not yet verified), never `UNAVAILABLE` by design.
4. Legacy-Dataset stance (Step 5) stands: no engine for unresolved/MIXED until resolved.

Status wording to use: Phase 029 establishes the schema and workspace-engine foundation for `Dataset.modality`; the transition is feasible and partially proven; API modality propagation (repository and local-folder responses) and Dataset-authoritative AI target resolution remain post-rollout changes; IMAGE bulk AI-detect is proven, broader AI capability remains explicitly gated.

## 7. What was run for this report
`web:test:modality-workspace-feasibility` (PASS 3/3, `20261006T115517Z-08c4ed01`); `web:test:imports-ui:vitest` (PASS, 70 vitest tests, `20261006T115608Z-0b090e9a`); typecheck web/worker/realtime (clean); earlier-run references: `release:phase029-chain` `20261006T084001Z-6fc0de09`, `verify:ingestion-replay-summary` `20261006T083744Z-e3645480`. An attempted run of `ai-batch-targets` + `g5-modality-routing` (`20261006T115328Z-b10d7240`) failed for the stale/fixture reasons in G5 and is reported, not used.
