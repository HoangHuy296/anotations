# Quickstart: TEXT Workspace Engine validation

This guide validates the acceptance journeys in [spec.md](spec.md) once Phase 025 is implemented. It does not include implementation code; see [data-model.md](data-model.md) and [contracts/](contracts/) for shapes, and `tasks.md` (Phase 2) for build steps.

## Prerequisites

- A running instance of the platform's real dependencies: PostgreSQL (with the additive Phase 025 migration applied), Redis, MinIO, and the private worker, started per `docs/architecture.md`. No mocked substitutes for these per AGENTS.md.
- `apps/web` and `apps/worker` built and running (`pnpm dev` / `pnpm dev:worker`, or the equivalent deployment build).
- At least one Dataset with:
  - A member with `owner`/`manager` capability to assign Responsibilities.
  - A member with annotation-create permission (annotator) and a distinct member with review permission (reviewer).
  - An eligible entity label (for spans), a classification/sentiment label, and a relation type configured through the TEXT policy endpoint.
- At least one TEXT Asset backed by a real MinIO object (not only legacy inline `TextAsset.content`), covering the approved Unicode fixture set from [research.md](research.md) D1/G1 (ASCII, `A😀B`, combining marks, precomposed accented text, multi-code-point emoji, CJK, mixed scripts, bidirectional text, repeated substrings), imported through the existing import/upload path.
- Two authenticated browser sessions (or equivalent authorized API clients) for the annotator and reviewer roles, to exercise collaboration/concurrency scenarios.

## Scenario 1 — Read and navigate the source (User Story 1, SC-001, SC-002)

1. As the annotator, open the TEXT asset through the Asset Browser.
2. Confirm the workspace renders the shared shell (Asset Browser, navigation, header, toolbox, properties region) with the original source text, not an image tool or placeholder.
3. Select text, scroll, change font size/window width, and search a repeated phrase.
4. **Expected**: the source is unchanged after all interactions; search highlights are visually distinct from any saved span; missing language/segmentation metadata is shown as "unavailable," not guessed.
5. Repeat against a missing/unsupported/oversized source object.
6. **Expected**: a safe unavailable/unsupported readiness state is shown; no partial content is presented as a complete annotatable document.

## Scenario 2 — Create and edit spans (User Story 2, SC-002, SC-003)

1. On an editable TEXT asset containing `OpenAI builds AI.`, select `OpenAI` and create an unlabeled span, then a labeled entity span.
2. **Expected**: the saved span has `startOffset=0, endOffset=6` in UTF-16 code units and an eligible dataset label.
3. Expand/shrink the boundary, then separately edit only its label/custom property.
4. **Expected**: a boundary edit changes only range and revision/audit fields; a label/property edit changes only label/property fields and never the range.
5. Repeat span creation across the full Unicode fixture table in research.md D1 (`A😀B`, combining marks, CJK, BOM/CRLF fixture), reload, and re-export.
6. **Expected**: every fixture resolves to the identical original substring after save, reload, and export (SC-002). Attempt an out-of-bounds/fractional/reversed boundary and confirm it is rejected with no partial write.

## Scenario 3 — Document classification (User Story 3)

1. With a SINGLE-cardinality classification group configured, classify the document, then replace the classification.
2. **Expected**: no synthetic full-document span is created; replacement is atomic and leaves at most one label in the group.
3. Enable MULTI-label policy explicitly, add two distinct categories, then remove one independently.
4. **Expected**: both coexist until removal; removal doesn't affect the other; reload preserves state.
5. Confirm the toolbox offers no sentiment controls when no sentiment taxonomy is configured, and behaves like ordinary classification once one is configured.

## Scenario 4 — Relations (User Story 4)

1. With two existing compatible spans and a configured relation type, create a relation between them.
2. **Expected**: the relation references the two annotation identities and a configured type; it does not copy their ranges.
3. Change one span's boundary.
4. **Expected**: the relation keeps its identity and shows the updated endpoint range.
5. Attempt a self-relation, a duplicate directed pair/type, and a relation to an annotation on a different asset.
6. **Expected**: each is rejected with no dangling relationship created.
7. Attempt to delete a span that has an attached relation.
8. **Expected**: deletion is refused until the relation is explicitly removed first.

## Scenario 5 — Save safety and review lifecycle (User Story 5, SC-004, SC-008)

1. As the annotator, make pending span/classification/relation edits, then Submit.
2. **Expected**: all saves complete and the workflow transition uses the resulting current asset revision (NEEDS_REVIEW).
3. Simulate a failed/conflicting save (e.g., two sessions editing the same span from the same starting revision) and attempt Submit or navigation away.
4. **Expected**: the workspace blocks silent continuation and offers retry/reload/discard; at most one of the two conflicting edits succeeds.
5. As the reviewer, holding an earlier asset revision, attempt to Approve/Reject after a concurrent annotation change committed.
6. **Expected**: the stale decision is refused via the existing review-staleness boundary.
7. Reject the asset, then as an authorized actor start rework, edit, and resubmit.
8. **Expected**: Workflow History retains the rejection feedback and all transitions; no TEXT-specific workflow state appears.
9. Perform an ordinary edit, then Undo/Redo.
10. **Expected**: only the local annotation edit is affected; workflow, assignments, another user's committed edits, and Discussion are never undone.

## Scenario 6 — Collaboration (User Story 6, SC-007)

1. As owner/manager, assign annotator and reviewer Responsibilities to the TEXT asset.
2. Open two sessions; add a Discussion comment; change workflow state.
3. **Expected**: existing Activity, Bell/notifications, and presence reflect the changes exactly as for IMAGE/VIDEO assets; annotation custom properties are never used as Discussion storage.
4. Inspect presence/invalidation network payloads (e.g., via browser devtools).
5. **Expected**: only VIEWING/EDITING awareness and authorized identity/scope data appear — no source text, selected text, offsets, drafts, endpoints, cursors, or search queries (SC-007).
6. Remove the annotator's dataset membership mid-session and attempt a further read/write.
7. **Expected**: current platform authorization is applied; stale UI state does not grant access.

## Scenario 7 — Keyboard and structural views (User Story 7, SC-005, SC-006)

1. Using keyboard only, complete: source selection, span create/label/boundary-adjust, classification CRUD, relation CRUD, and review inspection.
2. **Expected**: focus and action names are available throughout; typing/selecting text never triggers Submit/Approve shortcuts.
3. Generate/load the single benchmark/reference.json corpus and execute the benchmark protocol below.
4. **Expected**: initial open completes within 3 seconds in ≥95/100 trials; local selection/focus/search-next feedback completes within 200 ms in ≥95/100 interactions (SC-005). Use the pinned hardware/network/cache/timing contract below; a different environment is exploratory evidence, not SC-005 acceptance.
5. With overlapping/same-range annotations present, confirm each is individually selectable via the annotation list/text labels/focus affordances without relying on color alone (SC-006).

## Regression pass (SC-009)

Run the existing IMAGE/VIDEO and Phase 022/023/024 acceptance journeys for shared surfaces (Asset Browser, workspace header/navigation, properties panel, workflow, collaboration, exports) and confirm they still pass unmodified. Report executed passing checks, failures, and any unexecuted/skipped runtime checks explicitly — do not treat specification or planning review as a substitute for this runtime proof (see spec.md "Dependencies and mandatory planning gates").

## Independent closure records

Use tasks.md's dedicated verification tasks and separate outputs under `verification/`. Record `pnpm db:validate`, `pnpm exec prisma migrate status` (does not establish absence of schema drift), OpenAPI validate/bundle/Swagger UI generation, root `pnpm typecheck`, root lint, production `pnpm build`, each normal/review Compose `config --quiet` and isolated smoke boot, realtime tests, real concurrency, and production-style multi-user browser acceptance separately. A generic “quickstart passed” is insufficient. Required skipped checks are unverified.

Prisma config loads .env with override enabled; use an isolated checkout/container and verify the effective acceptance target without printing credentials. Never print interpolated Compose config. Do not mutate shared review data as fixture setup. Source preparation must be exercisable by dataset.read authorization during review; do not seed policy directly as the only product path. Configure eligible labels, classification groups and relation compatibility through the Owner/Manager panels and guarded policy API before the complete journey.

## Reproducible SC-005 benchmark contract

The canonical machine-readable fixture/configuration is [benchmark/reference.json](benchmark/reference.json), ID `text-workspace-sc005-v1`. Both the story performance task and final closure task consume the same file and `apps/web/tests/text-performance/generate-reference-corpus.ts`; neither may generate a different reference document. The generator is a future test implementation task. The JSON contract and source digest are prepared now; no runtime performance result is claimed.

### Exact environment and topology

Use two dedicated Ubuntu 24.04 LTS x86-64 hosts, each AMD Ryzen 5 3400G (4 physical cores/8 logical CPUs), 16 GiB RAM and local SSD. One runs the production Docker Compose stack, the other the browser natively. No development servers, HMR, browser extensions, concurrent build/test jobs or CPU throttling. Record kernel, Docker Engine/Compose versions, CPU governor and actual resource availability in the execution manifest. The first accepted run freezes those exact versions and existing service image digests; closure must reuse them. Provisioning changes require a new benchmark version and both stages rerun, not retroactive threshold adjustment.

Server containers: web 2 CPUs/2048 MiB; worker 1 CPU/1024 MiB; realtime 0.5 CPU/512 MiB; PostgreSQL 1 CPU/2048 MiB; Redis 0.5 CPU/512 MiB; MinIO 1 CPU/1024 MiB. Containers use a private Docker bridge; PostgreSQL/MinIO use local SSD volumes. Browser traffic traverses the server's HTTPS reverse proxy to web/realtime; no remote provider, CDN or WAN path. Apply/verify 50 ms total browser-to-proxy RTT, 20 Mbps each direction, 0% loss on this leg only. Network shaping configuration and observed RTT/throughput are recorded; neither private service traffic nor browser CPU is throttled.

Browser: headed Google Chrome **151.0.7922.137**, clean profile, 1440×900 CSS-pixel viewport, deviceScaleFactor 1. This version and the CPU model were observed locally during design; the two-host 16 GiB acceptance setup has not been provisioned or benchmarked by this documentation change. Source preparation uses pinned Node 22.23.1 / ICU 78.2 / Unicode 17.0. Resolve current repository deployment images to immutable digests during fixture setup; web/worker must use the same approved source profile. Build with root `pnpm build`, run production servers, and record git/lockfile/image/config hashes. Do not install another test package without existing required authorization; the runner may use existing browser tooling/CDP.

### Deterministic corpus and annotation distribution

Expand the JSON prefix U+FEFF, append its repeatUnit `A😀B e\u0301 中文 👩‍💻\r\n` as many whole units as fit, then pad with ASCII x to **exactly 100000 UTF-16 code units**. Encode UTF-8 without normalization, preserving the BOM and CRLF. Byte length and raw-byte SHA-256 must match the JSON contract. Obtain grapheme boundaries from the approved preparation artifact, not a browser-dependent recomputation.

Create one fixture dataset-owned ENTITY label and one configured RELATION label accepting that entity at both endpoints. For span index i=0..999, start at boundary index `20*floor(i/2)` and end at `startIndex+(i even ? 3 : 9)`: exactly 500 nested pairs with distinct identities and no exact same-range duplicate. Source is stored once. Use symbolic fixture IDs mapped to generated database IDs, never seeded product identifiers.

Initialize unsigned xorshift32 state to **250025**. Each next value applies, in order, `x ^= x << 13`, `x ^= x >>> 17`, `x ^= x << 5`, truncating to unsigned 32 bits after each step. Fisher–Yates shuffle `[0..999]` for k=999 down to 1 using `j=nextUint32() % (k+1)`. Relation j=0..99 connects shuffled span `2*j` to `2*j+1`, giving 100 directed, non-self, unique pairs. No document classifications in the latency corpus; classification correctness has separate fixtures. Freeze source/config/boundary digests and symbolic annotation manifest once; both performance stages reuse this corpus.

### Warm-up, caches, and 100-trial procedure

Prepare the source and persist all annotations before timing. Record preparation time separately; it is not included in the prepared-reader threshold. Keep dependent services running throughout. Ten excluded opens warm the first cohort, then measure **50 application-cold opens**: each uses a fresh authenticated browser context and restarted web process, so the TEXT store and boundary-map cache begin empty. This is application-cold, not disk-cold: OS/DB/MinIO caches are not purged and their condition is stated in the report. Authentication is completed outside timing.

Run ten more excluded warm-up opens, then **50 warm opens** using the same authenticated context and web process. Navigate to the asset list and clear per-asset TEXT client state before each open; retain the verified server boundary cache. Protected source/annotation HTTP responses remain `private, no-store` in both cohorts. Fetch all annotation pages; never benchmark a truncated first page as complete. No concurrency workload runs during latency trials; command contention is measured separately in correctness/concurrency evidence.

Opening start marker `text-benchmark:open-start` is emitted immediately before the existing asset-navigation action. End marker `text-benchmark:open-ready` occurs after source validation, all 1000 spans/100 relations loaded at one asset revision, highlights/list navigation and input handlers ready, and two animation frames have painted. Measure with browser `performance.now()` on one time origin. Fail on a 10-second timeout rather than dropping the sample.

After the last warm open, perform ten excluded interaction warm-ups, then exactly **100 loaded interactions** in repeating selection/focus/search-next order (34/33/33). Selection targets span `(37*n)%1000`; focus targets span `(53*n)%1000`; literal search uses `中文` and advances to match `(97*n)%matchCount`, preserving source offsets. Index n is that interaction kind's zero-based ordinal. Start marker is immediately before dispatch of the intended keyboard/pointer action; end marker is the second animation frame after the correct selection/focus/match is visibly reflected. No autosave or annotation writes are triggered by these interactions.

Persist every raw duration, cohort/action, expected/observed correctness, timeout and error. Sort 100 samples for each metric; nearest-rank p95 is the **95th value** (1-indexed, `ceil(0.95*N)`), with no interpolation. Treat errors/timeouts as infinite duration for counts/percentiles; retain a status/null-duration representation in JSON rather than invalid JSON Infinity. Report cold/warm cohort statistics separately but apply the specified opening threshold to all 100 opens combined. At least 95 opens must be <=3000 ms and at least 95 interactions <=200 ms. Never exclude failures or replace them with extra successful trials.

### Independent closure verdicts

Correctness verdict requires every expected source/range/snapshot/action result correct; performance verdict requires both threshold counts and the declared environment/config identity. Report these separately: correct-but-slow is a performance failure, fast-but-wrong is a correctness failure. Either blocks closure under SC-005/the associated correctness criteria. An environment/fixture mismatch makes the run invalid and cannot produce a passing acceptance verdict. The final closure task reuses the frozen manifest and repeats the protocol; archive both raw runs and verdicts.
