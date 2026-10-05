# Feature Specification: COCO Dataset Export + Asset.relativePath Foundation

**Feature Branch**: Not created; specification is independent of `025-text-workspace-engine` and `026-single-bulkselection-asset`.

**Feature Directory**: `specs/027-coco-dataset-export`

**Created**: 2026-09-28

**Status**: Draft — spec approved to be written, planning only. **Implementation and every migration remain blocked** on the open items in ยง9.

**Input**: User request to (a) make `Asset.filename` collisions fail instead of silently succeeding, similar to Gitea, and (b) support a COCO-formatted output compatible with the AIOZ AI Service's `GET /api/v1/tasks/result/{task_id}/format?type=image&formatter=coco`. Refined over several rounds of clarification (see conversation) into: a `relativePath`-based per-dataset name invariant, and a canonical, DB-sourced Dataset COCO export, decoupled from the provider endpoint.

## 0. Scope boundary (read this first)

Two capabilities exist in this product and must never be confused:

| | `GET /api/v1/tasks/result/{task_id}/format?formatter=coco` | Dataset Export → COCO (this spec) |
|---|---|---|
| Scope | One `AiTask`'s inference result | The entire Dataset's current annotation state |
| Data source | The external AIOZ provider | Canonical PostgreSQL: `Asset`, `Label`, `Annotation` |
| Includes edits? | No — the provider's own historical output | Yes — always the current row, even if a user edited an AI prediction |
| Includes manual annotations? | No | Yes, identically to AI/imported, one serializer |
| Status | Out of scope of this spec; a possible future "download formatted AI task result" feature | This spec |

Dataset Export never calls the provider's `/format` endpoint, never proxies or merges its output, and never uses it as a data source. The provider's documented shape is used only as a **reference/compatibility contract** for the wire format we independently produce.

## 1. User Scenarios & Testing *(mandatory)*

### User Story 1 — Export a Dataset's canonical annotations as COCO (Priority: P1)
As a dataset owner, I can request a COCO export of my Dataset and download one `{images, annotations, categories}` JSON document reflecting the Dataset's current annotation state, regardless of whether each annotation came from manual work, AI detection, or import.

**Acceptance Scenarios**:
1. **Given** a Dataset with manual and AI-sourced bounding-box annotations, **When** I request a COCO export, **Then** the downloaded file contains both, through the same code path, with no field indicating which serializer path was used.
2. **Given** an AI-generated annotation a user has since edited (new geometry, new label, incremented revision), **When** I export, **Then** the exported box reflects the edited geometry/label, not the AI model's original output.
3. **Given** an annotation with `status = REJECTED`, **When** I export, **Then** it is absent from `annotations[]` and counted under a `rejected` skip reason.
4. **Given** two `AiTask`s that both wrote predictions into the same Dataset, **When** I export once, **Then** both appear in one array, deduplicated naturally by `Annotation.id` — no per-task grouping, no merge logic keyed on `aiTaskId`.
5. **Given** an IMAGE asset with zero eligible annotations, **When** I export, **Then** it still appears in `images[]` (a Dataset member is represented whether or not it currently has a box).
6. **Given** a non-bbox annotation (polygon, etc.), an unlabeled annotation, an annotation whose label is a non-`OBJECT`/non-image-scoped Label, an asset missing `width`/`height`, or an annotation with geometry that fails the canonical bounding-box schema, **When** I export, **Then** each is skipped with its own named reason in the Job summary, never silently dropped and never clamped/repaired.
7. **Given** the same Dataset state, **When** I export twice, **Then** `images[].id`, `categories[].id`, and `annotations[].id` are identical both times, independent of any change in worker processing order.

### User Story 2 — Filenames don't silently collide within a Dataset (Priority: P2, gated)
As a user uploading or importing files, a new file whose computed dataset-relative identity already belongs to a live Asset is rejected with a clear conflict, not silently accepted under a different internal name and not silently overwriting the existing one.

**Acceptance Scenarios**:
1. **Given** a Dataset with a live Asset at relative path `x/1.png`, **When** a new upload or import item would also resolve to `x/1.png` in that Dataset, **Then** the write is rejected with `IMPORT_ITEM_CONFLICT` and no Asset row is created.
2. **Given** two concurrent requests attempting to create the same new `(datasetId, relativePath)` for the first time, **When** both are submitted at the same moment, **Then** exactly one Asset is created and the other request receives `IMPORT_ITEM_CONFLICT` — never two Assets, never a request that hangs indefinitely or times out as its only signal.
3. **Given** the 66 pre-existing live Assets identified by audit as already sharing a `(datasetId, relativePath)` identity, **When** this feature ships, **Then** every one of those rows is unaffected — same `id`, same `filename`, same `relativePath`, same content, no deletion, no rename, no suffix, no flag that changes its visible identity.

## 2. Export eligibility (exact rule, unchanged from prior review rounds)

An `Annotation` is exported when **all** hold:
1. `Asset.modality = IMAGE`, `deletedAt IS NULL`, `archivedAt IS NULL`.
2. `Asset.width` and `Asset.height` are both non-null.
3. `Annotation.type = BOUNDING_BOX`.
4. `Annotation.geometry` validates against the existing canonical bounding-box schema (`imageAnnotationGeometrySchema`'s `BOUNDING_BOX` branch, [annotation-api.ts:9-16](../../apps/web/src/lib/validation/annotation-api.ts)) — reused, not reimplemented. Failure → skip reason `invalid_geometry`.
5. `Annotation.status != REJECTED`. All other statuses are included (in practice today: `DRAFT`, `ACCEPTED`; `IN_PROGRESS`/`COMPLETED`/`SUBMITTED`/`REVIEWED` are declared but currently unreachable — see ยง7).
6. `Annotation.labelId` is set **and** resolves to a `Label` with `scope = OBJECT` and `modality ∈ {IMAGE, null}`. A `labelId` that resolves outside that set → skip reason `label_not_in_image_category_set`.
7. No filtering by `Annotation.source` — `MANUAL`, `AI`, `IMPORTED`, `SYSTEM` are all eligible identically, one serializer, no `aiTaskId` branching.

Named skip reasons, all counted in `Job.summary`, none silent: `wrong_modality`, `missing_dimensions`, `unsupported_geometry_type`, `invalid_geometry`, `unlabeled`, `label_not_in_image_category_set`, `rejected`.

`images[]` = every eligible-by-rule-1&2 IMAGE asset, whether or not it ends up with any eligible annotation.
`categories[]` = every `Label` in the Dataset with `scope = OBJECT` and `modality ∈ {IMAGE, null}` — the full defined taxonomy, not only labels currently in use.

## 3. Deterministic IDs and geometry mapping

- **`images[].id`**: eligible assets sorted by `(relativePath, id)` ascending, numbered 1..N. `file_name = relativePath`.
- **`categories[].id`**: eligible labels sorted by `(normalizedName, id)`, numbered starting at **1**.
- **`annotations[].id`**: eligible annotations sorted by `(image_id, createdAt, id)`, numbered 1..N. `image_id`/`category_id` are resolved from the two maps above, never from provider or processing order.
- Two exports of unchanged data are value-identical (`assert.deepStrictEqual`); the serializer's fixed key-insertion order and pure-DB-input arithmetic also make them byte-identical in practice, but **value-identical with stable ordering/IDs is the acceptance criterion**, not raw byte comparison.
- **Geometry**: stored bbox is normalized `[0,1]`. `pixelW = w·W`, `pixelH = h·H` (`W`,`H` = `Asset.width/height`). `bbox = [x·W, y·H, pixelW, pixelH]`. `area = pixelW · pixelH`. `iscrowd = 0`.
- **`score`**: included only when `source = AI` **and** `properties.confidence` is a finite number in `[0,1]`; omitted (key absent) otherwise, including for an AI annotation a user has since edited. No "edited-AI confidence" semantics are invented.

## 4. `Asset.relativePath` — canonical normalization contract

One function, used identically by folder import, repository import, plain upload, the backfill, and conflict detection — never reimplemented per import path. **Normalizes path syntax only. Case is preserved; identity is case-sensitive.**

1. Unicode-normalize to NFKC.
2. Replace `\` with `/`.
3. Strip leading/trailing `/` (no absolute path).
4. Split on `/`; reject if any segment is empty (rejects `//` rather than silently collapsing it — an explicit error beats guessing intent) or is `.`/`..` (no traversal). This matches existing `normalizeRepositoryPath` behavior, extended to every source instead of only repository import.
5. Reject empty result.
6. **No case-folding.** `Cat.jpg` and `cat.jpg` are distinct identities. A repository or folder legitimately containing both must export both, with `file_name` accurately reflecting each one's real logical path — folding them would manufacture a collision that doesn't exist in the source, and would make COCO `file_name` stop matching the source path. **Correction from an earlier draft of this section**, which proposed case-insensitivity; rejected on review.
7. Length bound 1024 (matches existing `rootPath` bound).

**Existing inconsistency, flagged for correction, not propagated:** `prepare-local-folder-import.ts:53` today calls `.toLowerCase()` on every new folder-import path, an existing bug relative to this contract. Step C (ยง10) removes that call and routes folder import through the one shared function instead. **Historical rows already written with a lowercased `PreparedImportItem.normalizedPath` keep that value as-is** — the original casing is not recoverable from an already-lowercased string, and inventing a casing that was never recorded would be worse than preserving the lossy value. This does not change any audit conclusion in ยง8: those counts reflect the actual stored values either way, and the case-sensitivity of the *comparison* going forward doesn't retroactively alter what's already in the column.

`relativePath` computed per source:
- Folder import: `PreparedImportItem.normalizedPath`, run through the canonical function above.
- Repository import: `Asset.sourcePath` with `Dataset.sourceRootPath` prefix stripped (when `sourceRootPath` is non-empty and `sourcePath` starts with it), then the canonical function. Audit-confirmed: 0 mismatches across 73 live repo-imported assets, `sourceRootPath` was empty for all of them today, so this branch is exercised structurally but not yet by any live data — future non-empty-rootPath imports become the first real exercise of it.
- Plain upload: `filename`, through the canonical function.

## 5. Historical-duplicate policy (binding)

**Decision, made explicitly, not inferred:** the 66 live Assets across 30 groups that already share a computed `(datasetId, relativePath)` identity (all `PREPARED_IMPORT_ITEM`-sourced, all from a folder re-imported into the same Dataset more than once — see audit in ยง8) are **preserved exactly as-is**. No delete, soft-delete, rename, suffix, or classification flag is applied to any of the 66 rows "to make the constraint pass." Their apparent origin as development/test fixtures is **not** treated as authorization for cleanup — that would require a separate, explicitly-scoped request per [test-data-safety-discipline].

This means: **the partial unique index cannot be the enforcement mechanism**, because creating it over the live rows as they exist today fails outright. ยง6 is the resulting design.

## 6. Transitional enforcement design (new-write invariant, historical rows untouched)

**Requirement split:**
- Historical duplicates (the 66 rows) may remain, forever, unmodified.
- Every **new** write (upload, folder-import completion, repository-import upsert) must be rejected with `IMPORT_ITEM_CONFLICT` if it would create a live Asset at a `(datasetId, relativePath)` already held by **any** other live Asset — including a historical duplicate's path, not only a path first used going forward. (Otherwise a "duplicate of a duplicate" would keep silently growing exactly the situation ยง5 says to freeze.)
- Enforcement must be DB-level and race-safe under concurrent writers, not an application check-then-insert (a plain `findFirst` then `create` has a TOCTOU window: two requests can both pass the check before either commits).

**Recommended design — Postgres constraint trigger + advisory lock, not a plain unique index:**

```sql
-- Illustrative, NOT for execution yet (see ยง10 for what actually runs and when).
CREATE OR REPLACE FUNCTION asset_relative_path_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."relativePath" IS NULL OR NEW."deletedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Serializes all concurrent writers targeting the same (datasetId, relativePath)
  -- key so the existence check below cannot race. Released automatically at
  -- transaction end (commit or rollback); safe to nest inside Prisma's
  -- implicit per-statement or explicit $transaction blocks.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."datasetId" || ':' || NEW."relativePath", 0));

  IF EXISTS (
    SELECT 1 FROM "Asset"
    WHERE "datasetId" = NEW."datasetId"
      AND "relativePath" = NEW."relativePath"
      AND "deletedAt" IS NULL
      AND id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'IMPORT_ITEM_CONFLICT: % already used in dataset %', NEW."relativePath", NEW."datasetId"
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER asset_relative_path_guard_trigger
  AFTER INSERT OR UPDATE OF "relativePath", "deletedAt" ON "Asset"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION asset_relative_path_guard();
```

Why this over a plain partial unique index: a partial index necessarily either (a) covers the 66 historical rows too, and fails to create today, or (b) excludes them by some marker, which requires mutating those 66 rows (ยง5 forbids this) and — if it excludes them via a time-based cutover instead of a per-row marker — fails to catch a *new* write colliding against a *historical* key, since the historical row is invisible to the index. The trigger has neither problem: it checks against every live row regardless of how old it is, and it never requires writing to the 66 rows.

**Verified twice by spike, superseding an earlier wrong guess in this section's first draft.** The first pass measured only `$executeRawUnsafe`; a second, follow-up spike (ยง11a) measured the actual `tx.asset.create()`/`.update()` typed-call path against a fully disposable Prisma model + disposable generated client (never the real `Asset` table). **The two call styles give different shapes, and a naive "any `23505` → conflict" rule is wrong**, exactly per your instruction not to globally translate every `23505`:

| Call style | Trigger SQLSTATE | Prisma result |
|---|---|---|
| `$executeRawUnsafe` | `unique_violation` (23505) | `PrismaClientKnownRequestError`, `code: "P2010"`, `meta.code: "23505"` |
| Typed `.create()`/`.update()` | a **custom** SQLSTATE (e.g. `AN001`) | `PrismaClientUnknownRequestError`, `code: undefined`, `meta: undefined` — **no structured signal at all**; the only evidence is the literal message text buried in an internal, undocumented Rust debug dump (`ConnectorError(ConnectorError { ... })`), not a stable API |
| Typed `.create()`/`.update()` | `unique_violation` (23505), with or without a `CONSTRAINT = '...'` label on the RAISE | `PrismaClientKnownRequestError`, `code: "P2002"`, **`meta: { modelName: "<Model>", target: null }`** |

**The final design uses the third row** — the trigger raises the standard `unique_violation` SQLSTATE (a custom code makes typed calls *worse*, not better, by dropping all structure). The `CONSTRAINT = '...'` label was tested and confirmed to have **no effect** on the typed-call shape — Prisma can't resolve `target` from a label that isn't a real, introspectable Postgres constraint, so it's kept anyway for `psql`/log readability but is not part of the application contract.

**The narrow, trigger-specific marker, proven against real distinguishing cases:** `error.code === "P2002" && error.meta?.modelName === "Asset" && error.meta?.target == null`. This is safe specifically because Prisma **always** populates `target` with the real field-name array whenever the violated constraint is one it knows from `schema.prisma` — proven twice: a single-column `@unique` gives `target: ["tag"]`, and a composite `@@unique([a,b])` (representative of `Asset`'s existing `[storageProvider,storageBucket,storageKey]`-style composite uniques) gives `target: ["a","b"]`. `target: null` only ever occurred for the trigger's synthetic, schema-unknown conflict, across every RAISE variant tested. **A real, distinct P2002 from one of `Asset`'s existing declared unique constraints is therefore never misclassified** — confirmed as an explicit test (`unrelated_23505_not_misclassified`), not inferred.

### 6a. Corrected invariant: exact persisted predicates, and no NOT-DELETED Asset may have `relativePath = NULL`, including on revival

An earlier draft of this document, and the previous checkpoint's own report, used "live" and "archived" loosely, as if they were interchangeable or both schema-real. **They are not — the words are retired below in favor of the actual persisted predicates**, verified by a repository-wide search of every write to these fields, not assumed:

| Term this document now uses | Exact predicate | Verified status |
|---|---|---|
| **DELETED** | `Asset.deletedAt IS NOT NULL` | **Real and written.** Exactly two functions in the entire codebase ever set it, both only ever to `new Date()` (`apps/web/src/lib/assets/asset-bulk-service.ts`, `apps/worker/src/jobs/bulk-delete-assets.ts`). Never cleared back to `NULL` anywhere — confirmed no revival/undelete feature exists (ยง10a's writer inventory). |
| **"archived"** | `Asset.archivedAt IS NOT NULL`, and separately `Asset.status = AssetStatus.ARCHIVED` | **Two distinct schema signals, both dead.** Neither is ever written anywhere in `apps/web/src` or `apps/worker/src` today. `archivedAt` is read defensively in two files (`video-temporal-label-service.ts`, `video-authorization.ts`) as if guarding a future write that doesn't exist yet; `AssetStatus.ARCHIVED` appears only in a UI label list (`image-status.ts`), never assigned. For every real row today, both evaluate to "not archived." |
| **NOT-DELETED** (this document's new term, replacing the old loose "live") | `Asset.deletedAt IS NULL` | This is the **one predicate the ยง6 identity-uniqueness trigger and the CHECK constraint below both use** — deliberately independent of the two dead "archived" signals, since neither reflects any real distinction today, and even if `archivedAt` were populated in the future, an archived-but-not-deleted Asset conceptually still occupies its dataset identity (un-archiving it later must not silently collide with something else that reused its name in the meantime) — so folding archival into this predicate would be wrong, not merely unnecessary. |
| **COCO-eligible / exportable** (ยง2, unrelated to this mechanism) | `deletedAt IS NULL AND archivedAt IS NULL AND modality = IMAGE AND width/height IS NOT NULL` | A **separate, stricter, application-only** predicate used solely by the COCO serializer's asset selection. It happens to coincide with NOT-DELETED today only because `archivedAt` is currently always null — it is not the same predicate conceptually, and this document does not conflate them. |

**The corrected invariant, stated against these exact predicates:** an earlier draft permitted a permanent exception — an unnormalizable historical Asset could be revived as a NOT-DELETED Asset with `relativePath = NULL`, tolerated indefinitely. **That exception is withdrawn.**

- A row that is **DELETED** (`deletedAt IS NOT NULL`) may keep `relativePath = NULL` indefinitely — ยง5's preserve-untouched policy already covers this, and it includes every historical duplicate and any unreconstructable row that stays soft-deleted.
- **Any transition into the NOT-DELETED state** (an INSERT that is NOT-DELETED from the start, or an UPDATE that clears `deletedAt` back to `NULL` — i.e., a future revival) **must carry a valid, non-null, already-normalized `relativePath` or be rejected outright.** Never invented by the system.
- **Enforced twice, deliberately redundant:**
  1. **Application layer, primary**: `packages/domain/src/asset-revival.ts`'s `assertRevivalHasCanonicalRelativePath(assetId, candidateRelativePath)` — called before any future revival code path issues its database write. Throws `AssetRevivalRequiresRelativePathError`, a clean, explicit, application-level error, never a fabricated path. Unit-tested (5 tests).
  2. **Database layer, backstop, exact SQL:**
     ```sql
     ALTER TABLE "Asset" ADD CONSTRAINT asset_live_requires_relative_path
       CHECK ("deletedAt" IS NOT NULL OR "relativePath" IS NOT NULL);
     ```
     (Named `..._live_...` for brevity/readability only — its actual condition is the NOT-DELETED predicate above, not any archived-related one.) Deliberately a plain `CHECK`, not more trigger logic — `ALTER TABLE ... ADD CONSTRAINT` validates every existing row at add time, so installing it doubles as an atomic, DB-enforced proof that BACKFILL actually reached zero NOT-DELETED NULLs (ยง10b), not merely a report claiming so.
- **Explicit ENFORCE abort condition, and the exact query**: before installing the constraint above,
  ```sql
  SELECT id FROM "Asset" WHERE "deletedAt" IS NULL AND "relativePath" IS NULL;
  ```
  **must return zero rows.** If it returns even one, **do not install the constraint, do not install it with `NOT VALID` (which would skip validating existing rows — an explicitly forbidden bypass, not a permitted variant), and do not weaken the condition to let it pass.** Report each returned `id` as unreconstructable and stop for a human policy decision (assign a real value, or soft-delete that specific row) — exactly ยง10c's BACKFILL-verify abort condition, restated here against the precise predicate.
- **Error-shape reality, spike-verified, disclosed rather than glossed over:** a typed Prisma call violating this `CHECK` constraint surfaces as `PrismaClientUnknownRequestError`, `code: undefined`, `meta: undefined` — the same unstructured shape found earlier for a schema-unknown custom SQLSTATE. This is **acceptable, not a gap**, because the constraint is a backstop for a bug/bypass, not a routine user-facing condition — the primary, ergonomic path is the application check above, which never lets the database see a bad write in the first place. `isLikelyLiveRequiresRelativePathViolation()` exists only for best-effort logging if the backstop is ever actually hit, never for deciding a user-facing response.
- **No conflict with the identity trigger**: `CHECK` constraints are validated as part of applying the row itself, before an `AFTER` trigger like `asset_relative_path_guard_trigger` would run — a row that fails the `CHECK` never reaches the identity-uniqueness logic at all. Both mechanisms use the exact same NOT-DELETED predicate for their own separate concerns (requiredness vs. uniqueness) and never interact otherwise.

### 6b. Historical collision fingerprint (replaces a bare "30 groups / 66 assets" count check)

A count alone cannot detect a swap (one asset silently removed from a group while another was added, leaving the count unchanged but membership different) — corrected per instruction to a deterministic fingerprint over the exact group membership, not a count.

**Procedure** (`scripts/027-collision-fingerprint.ts`, real, runnable, run twice already to confirm determinism):
1. Group every **NOT-DELETED** (`deletedAt IS NULL` — ยง6a's exact predicate, not the retired word "live") Asset by `(datasetId, relativePath-or-candidate)`; keep only groups with more than one member.
2. Within each group, sort `assetId`s; hash the path itself (`sha256`, truncated to 16 hex chars) — **raw path values are never printed or persisted anywhere in this procedure's output**, only the hash, per instruction ("sensitive path values hashed/redacted").
3. Sort the groups themselves by `(datasetId, pathHash)`.
4. Serialize the whole canonical structure and take one `sha256` over it — a single fingerprint representing the exact membership of every historical collision group.
5. Two modes, same algorithm, directly comparable across the migration boundary: `--pre` (derives each candidate via the exact same `resolveHistoricalCandidateRelativePath` the backfill uses — runnable today, no schema dependency) and `--post` (reads the real `relativePath` column — only runnable after BACKFILL).

**Current audit evidence, NOT a permanent baseline — captured today (2026-09-28), read-only, confirmed reproducible by running it twice:**
```
Collision groups: 30, colliding assets: 66
FINGERPRINT: e32caa5f7bfed3d8be8c3e585e3dac147856dccc1c1fb5d3c5d4e6478f22a52e
```
**Corrected per instruction: this value is not hard-coded into the cutover procedure.** This DB has proven active concurrent writers (ยง10's own amendment: 597→609→597 across sessions), so by the time EXPAND-1 is actually approved and executed, this exact figure will likely have moved on — real, legitimate churn, not a problem. **The authoritative baseline for any given cutover is whatever `--pre` produces at the start of that cutover's own quiescence window** (ยง10's QUIESCE step 1, added below), captured once writers are already paused so nothing can change under it, and it is *that* run's value — not `e32caa5f...` — that POST-BACKFILL and POST-ENFORCE must match byte-for-byte. `e32caa5f...` remains in this document only as evidence the tool works and produces a stable, reproducible value, not as a value anything will ever be compared against for real.

## 7. `AnnotationStatus` technical debt (documented, not touched)
`IN_PROGRESS`, `COMPLETED`, `SUBMITTED`, `REVIEWED` are declared in the enum and referenced by `updateAnnotationInputSchema`'s `editableStatus`, but that schema has no importer anywhere in the codebase today — dead code. Only `DRAFT` (every create path) and `ACCEPTED`/`REJECTED` (via `reviewAnnotationAction`) are ever actually persisted. Cleanup is out of scope of this phase; COCO eligibility rule 5 (ยง2) is written to be forward-compatible with all seven values regardless.

## 8. Read-only audit results (informational; already executed, nothing written)

Two audits ran as `BEGIN; SET TRANSACTION READ ONLY; ...; ROLLBACK;`, every statement a bare `SELECT`.

**Path-reconstruction audit** (597 live assets): `PREPARED_IMPORT_ITEM` 502, `REPOSITORY_SOURCE_PATH_ROOT` 73, `PLAIN_UPLOAD_FILENAME` 22; 0 mismatches; 0 orphan-suspects (no plain-upload asset lives in a dataset that also has folder-import history); 30 collision groups / 66 colliding live assets, all `PREPARED_IMPORT_ITEM`-sourced, all cross-batch (same folder re-imported into the same dataset ≥2 times).

**`PreparedImportItem.assetId` cardinality audit**: 0 `assetId` values referenced by more than one completed item; 514 completed items = 514 distinct `assetId`s; confirmed backed by a real Postgres unique index (`PreparedImportItem_assetId_key`). The scalar backfill subquery in ยง10 Step A is cardinality-safe — verified, not assumed.

## 9. Blockers — implementation and every migration remain gated on these

1. ~~Trigger/Prisma error-mapping spike (raw-query path)~~ — done.
2. ~~Typed-call error-mapping spike~~ — **done, 2026-09-28**, against a fully disposable Prisma model/client (ยง11c). Result changed the design: the trigger raises standard `unique_violation`, not a custom SQLSTATE, and the application marker is `P2002` + `meta.target === null`, not anything `P2010`-shaped.
3. ~~NFKC/normalization-parity risk~~ — **resolved by design, not by testing SQL harder**: Step A's backfill and the runtime write paths now both call the *same* TypeScript function (ยง10); the trigger only compares two already-normalized column values, so there is no second implementation of NFKC to drift out of sync. Confirmed by spike that raw SQL `=` on un-normalized bytes does *not* unify NFKC-equivalent strings, which is exactly why normalization must happen once, upstream, in TypeScript (ยง11c).
4. ~~UI~~ — **done**: export dialog ships with a JSON/COCO format picker (ยง13).
5. ~~Architecture~~ — accepted at the 2026-09-28 checkpoint; no further redesign identified as needed.
6. **Remaining, before real migration execution**: (a) EXPAND-2's deployment reaching 100% of writer instances is an operational confirmation, not something this document can verify; (b) your explicit approval to execute EXPAND-1 (ยง10) against the real database; (c) the post-migration `relativePath` COCO switch (ยง13, one line, already fixture-proven) and the full real-stack (Postgres+Redis+MinIO) E2E are correctly sequenced *after* migration, not before — not yet runnable, not a gap in today's implementation.

## 10. Migration stages — expand / backfill / enforce (**schema/index changes not applied**, **none placed in `prisma/migrations/`**)

Code for this rollout is implemented (ยง13). The real database migration (adding the column, running the backfill for real, creating the trigger) is a separate, later approval gate, per instruction — everything in this section describes what will happen at that gate, not something already done to the shared DB.

**Amendment (round 2):** round 1 already split EXPAND from BACKFILL/ENFORCE to close the "old writer instance creates a NULL row forever unenforced" race. A second, narrower race remains: even with EXPAND fully rolled out, a **new** write landing in the gap between BACKFILL's apply and the trigger's `CREATE TRIGGER` could create a duplicate that neither the backfill (already ran) nor the trigger (doesn't exist yet) catches. Since this DB has proven active concurrent writers (ยง8/ยง11c: 597→609→597 across sessions) and shrinking that gap is not the same as closing it, the fix is a **short, explicit writer-quiescence window** covering exactly the BACKFILL-final-pass → ENFORCE sequence — not the whole EXPAND phase, which stays fully live. Annotation-only operations (editing geometry, labels, review actions) never create an `Asset` and are **not** paused.

### 10a. Complete production Asset create/revive writer inventory (repository-wide, requested explicitly)

Searched the entire repository (`apps/web/src`, `apps/worker/src`, `scripts/`, `prisma/`) for every `asset.create`/`createMany`/`upsert`, every raw `INSERT INTO "Asset"`, and every write touching `Asset.deletedAt`.

| # | Function | File | Reachable from | Guard status |
|---|---|---|---|---|
| 1 | `publishUploadedAsset` | `apps/web/src/lib/asset-upload.ts` | `POST /api/assets/complete-upload` **and** `completeLocalFolderItem` (`POST /api/imports/[preparedImportId]/items/[itemId]/complete`) — the same function serves both real entry points | **Wired, real, tested.** `assertAssetWritesNotQuiesced()` is the first statement on the create path (skipped only for the pure-read replay branch). |
| 2 | `upsertMirroredRepositoryAsset` | `apps/worker/src/jobs/repository-asset-upsert.ts` | worker's `import-dataset.ts` job processor (MIRROR_TO_MINIO repository import) | **Wired, real, tested.** Guarded unconditionally (covers both its insert and update branches). |
| 3 | `persistDatasetImport` (`client.asset.upsert`) | `apps/web/src/lib/dataset-import.ts` | **nothing** — zero importers anywhere in the codebase, confirmed by repository-wide search | **Proven unreachable / dead code.** Not production-capable; not guarded; flagged here as tech debt, not fixed (out of scope of this phase). |

**Revival (`deletedAt` cleared back to `NULL`)**: searched every write to `Asset.deletedAt` in the repository. Found exactly two, both in `apps/web/src/lib/assets/asset-bulk-service.ts` and `apps/worker/src/jobs/bulk-delete-assets.ts`, and **both only ever set `deletedAt: new Date()`** (soft-delete). No `restore`/`undelete`/`revive`/`reinstate` code path exists anywhere (also checked by keyword search). **There is no Asset revival feature in this codebase today.** ยง6a's application-layer guard and the database `CHECK` constraint are therefore forward-looking groundwork for a feature that does not yet exist — not a gap in current coverage, since there is currently nothing to cover.

**Conclusion**: the exhaustive writer inventory has exactly two reachable, production-capable Asset-creating functions, and both are now guarded by the quiescence check, verified by real tests against real Redis (`packages/domain` unit tests + `apps/web/tests/asset-write-quiescence/guard.test.ts`, 4/4 passing) and by exercising the real call sites end-to-end (`apps/web`'s `test:local-folder-import` — 20/21, the one unrelated failure predates this session and is analyzed in the test-results section below; `apps/worker`'s `test:repository-import` — 13/13 after a real defect this inventory work surfaced and fixed, see below). The one unreachable function is reported, not silently ignored.

**Real defect found and fixed while proving this inventory, not just claimed clean:** the worker-side guard's first implementation used a persistent shared Redis connection (mirroring the web guard's own established pattern). That is correct for a long-running server process, but `apps/worker/tests/repository-import/asset-upsert.test.ts` calls `upsertMirroredRepositoryAsset` directly, in-process, with no spawned child server the way the web HTTP tests do — the persistent connection kept the test's own `node --test` process alive indefinitely after every assertion had already passed (reproduced directly: "ok 1" in 380ms, then the process never exited, `timeout` had to kill it). Fixed by making the worker-side guard open a fresh, short-lived connection per check, closed in a `finally` — confirmed by rerunning the same test to a clean exit (0 fail, process exits normally) and the full `test:repository-import` suite (13 pass, 14 skip, 0 fail).

**EXPAND-1** — schema only, no data write, trivially reversible. **Executed via `prisma migrate deploy`, not a bare `psql -f`** (ยง10d covers why and exactly what moves where):
```sql
-- staged at specs/proposals/asset-relative-path/prisma-migrations-staging/EXPAND1_add_asset_relative_path/migration.sql
ALTER TABLE "Asset" ADD COLUMN "relativePath" TEXT;
```
**Exact commands:**
```
# 1. Apply the schema.prisma diff (ยง10d) -- adds `relativePath String?` to the Asset model.
# 2. Move the staged migration into real history with a real timestamp:
mv specs/proposals/asset-relative-path/prisma-migrations-staging/EXPAND1_add_asset_relative_path \
   prisma/migrations/$(date +%Y%m%d%H%M%S)_add_asset_relative_path
# 3. Apply it, recorded in _prisma_migrations like any other migration:
npx prisma migrate deploy
```
**Immediate post-DDL verification** (run right after, before anything else):
```sql
SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_name = 'Asset' AND column_name = 'relativePath';
-- Expect exactly one row: relativePath | YES | text
SELECT count(*) FROM "Asset" WHERE "relativePath" IS NOT NULL;
-- Expect 0 -- the column is brand new, nothing has written to it yet.
```
Then run `npx tsx scripts/027-collision-fingerprint.ts --pre` and record its value as evidence EXPAND-1 itself touched no data (compare it to whatever the *next* audit run before this actually executes shows — not to the now-superseded `e32caa5f...` illustrative value, per ยง6b's correction).

Abort/rollback condition: the verification query returns anything other than exactly that one nullable `text` column, or the post-DDL non-null count is not 0 — `DROP COLUMN "relativePath"` (ยง10c), safe at this exact moment since no application code depends on it yet. `prisma migrate resolve --rolled-back <migration-name>` marks it un-applied in `_prisma_migrations` afterward, so history stays consistent with reality.

**EXPAND-2** — deploy the application code from ยง13 to **every** `apps/web` and `apps/worker` instance: the two reachable Asset-creating functions (ยง10a) compute `relativePath` via the shared normalizer and **reject the write** (not a NULL row) if normalization fails. This also ships the now-wired quiescence-check guard (ยง10a), always present, a no-op unless the Redis flag is set — so the pause mechanism used later needs no separate deploy of its own.

**GATE** — verify no old writer instances remain, before touching BACKFILL/ENFORCE at all:
- Confirm the deployment platform reports 100% of `apps/web` and `apps/worker` replicas on the EXPAND-2 build (this is an operational/deployment-topology fact, not a SQL check — this document cannot verify it from the database).
- As a second, DB-side corroboration (not a replacement for the above): run `scripts/027-backfill-relative-path.ts --dry-run` once and confirm the **live** row count with `relativePath IS NULL` is no longer growing across two runs a few minutes apart. A still-growing count means an old writer is still creating unpopulated rows — do not proceed; find and finish upgrading it first.
- Abort condition: any replica not yet on EXPAND-2, or a still-growing NULL count. Do not proceed to quiescence.

**QUIESCE → BACKFILL → verify → ENFORCE → verify → RESUME**, all inside one short, human-supervised window:
1. **Pause** Asset-creating writers: `npx tsx scripts/027-toggle-asset-write-pause.ts on` (from `apps/web`). This sets the Redis flag EXPAND-2's guard checks; it auto-expires after 30 minutes as a forgotten-resume safety net. Annotation editing, review, exports, AI tasks that don't create Assets — all unaffected, no need to stop them.
2. **Capture the authoritative PRE fingerprint for THIS cutover** (corrected per instruction — not the `e32caa5f...` value in ยง6b, which is only illustrative evidence from an earlier, now-stale audit): `npx tsx scripts/027-collision-fingerprint.ts --pre`, taken now specifically because writers are already paused and nothing can change under it. Record this run's fingerprint value; it is the one every later step in this same cutover is compared against.
3. **Final dry-run** (the preflight, run one last time with writers quiesced so nothing can move under it): `npx tsx scripts/027-backfill-relative-path.ts` (no flag = dry-run). Abort condition: mismatch bucket ≠ 0, or `PreparedImportItem.assetId` cardinality violation > 0 — **resume writers immediately** (`... off`) and stop; do not apply.
4. **Apply**: `npx tsx scripts/027-backfill-relative-path.ts --apply`.
5. **Verify BACKFILL**: `SELECT id FROM "Asset" WHERE "deletedAt" IS NULL AND "relativePath" IS NULL;` **must return zero rows — corrected, no residual tolerance for a NOT-DELETED row** (ยง6a withdrew the earlier permanent-exception draft). If it returns any row, resolve each by hand before proceeding (assign a real relativePath, or soft-delete that specific row) — never invented, never left NOT-DELETED-with-NULL. **Also re-run `npx tsx scripts/027-collision-fingerprint.ts --post` and compare against step 2's captured value** — must match byte-for-byte (BACKFILL only fills in previously-NULL values; it must never change which assets collide with which). Abort condition: any row from the first query, or a fingerprint mismatch — resume writers, resolve by hand, do not install the constraint/trigger. Belt-and-suspenders: step 6's `CHECK` constraint would itself refuse to install if the first condition were somehow missed (ยง6a).
6. **Install the constraint and trigger**: `specs/proposals/asset-relative-path/step-b-trigger.sql` (staged for durable history at `specs/proposals/asset-relative-path/prisma-migrations-staging/ENFORCE_asset_relative_path_guard/`, applied via `prisma migrate deploy` — ยง10d).
7. **Verify ENFORCE**: run every query in `specs/proposals/asset-relative-path/trigger-verification-queries.sql`, then `npx tsx scripts/027-verify-trigger.ts` (functional proof: creates a throwaway Dataset and two conflicting Asset rows inside a transaction that always rolls back, asserts the second is rejected with the exact ยง6/ยง11c marker, nothing committed). **Re-run `npx tsx scripts/027-collision-fingerprint.ts --post` a second time and compare against step 2's value again.** Abort condition: the constraint or trigger missing/disabled, the NOT-DELETED NULL count non-zero, the fingerprint not matching step 2's captured value, or the functional check failing.
8. **Resume writers**: `npx tsx scripts/027-toggle-asset-write-pause.ts off`.

**Steady-state invariant, corrected (ยง6a):** after cutover, a **live** Asset (`deletedAt IS NULL`) must have (a) a non-null `relativePath`, **and** (b) no collision with another live Asset's `(datasetId, relativePath)`. No exception, no permanent grandfather clause for a live row, including on revival. **(a) is enforced twice**: primarily at the application layer (EXPAND-2's reject-on-null-normalization for new writes; ยง6a's `assertRevivalHasCanonicalRelativePath` for any future revival), and as an unconditional DB backstop by the `asset_live_requires_relative_path` `CHECK` constraint. **The column itself stays nullable** (never `NOT NULL`) — the `CHECK` constraint expresses the real rule ("non-null *when live*"), which a plain `NOT NULL` cannot, and it is exactly what lets `deletedAt IS NOT NULL` historical rows (ยง5's 66 duplicates, and any archived/deleted row) keep `relativePath = NULL` forever. **(b) is the ยง6 trigger's job**, DB-enforced, race-safe, exactly as spiked.

No partial unique index is proposed anywhere in this design. It is not compatible with ยง5's historical-preservation decision.

### 10b. Backfill scope (amended) and revival behavior

Backfill now covers **every reconstructable Asset row, including soft-deleted and archived ones**, not only live ones — so a future revival (clearing `deletedAt`) already has a canonical identity instead of surfacing with `relativePath` still NULL. `scripts/027-backfill-relative-path.ts`'s `--dry-run`/`--apply` report four figures every run: counts by lifecycle (`live`/`archived`/`deleted`), by reconstruction source, unnormalizable rows (by lifecycle), and live-only collision groups (unchanged scope — a deleted or archived row sharing a path with anything is never a "collision," since the ยง6 trigger only ever checks `deletedAt IS NULL` rows).

**Revival behavior, corrected (ยง6a):** an Asset backfilled as `UNNORMALIZABLE` (its every candidate source fails ยง4's syntax rules — pathologically rare, e.g. a historical row whose only recorded path was itself invalid) keeps `relativePath = NULL` **while it stays non-live** (`deletedAt IS NOT NULL`) — that part is unchanged. **Reviving it is no longer a permanent tolerated exception.** Clearing `deletedAt` on such a row without also supplying a valid `relativePath` is rejected outright — by the application layer first (`assertRevivalHasCanonicalRelativePath`, ยง6a), and by the database's `asset_live_requires_relative_path` CHECK constraint as an unconditional backstop. An operator must assign a real, human-chosen `relativePath` in the *same* write that revives the row; the system never invents one and never lets the row become live without one.

**Idempotency, proven not asserted:** verified against a disposable sandbox schema (own tables mirroring `Asset`/`Dataset`/`PreparedImportItem`, dropped after) mixing live/archived/deleted/unnormalizable/colliding rows. First dry-run + apply wrote exactly the resolvable rows (archived and deleted rows included, unnormalizable row left NULL); a second dry-run found only the still-unnormalizable row as a candidate; a second apply wrote **zero** rows and left every value byte-identical to after the first apply. See ยง13 for the harness.

### 10c. Rollback matrix (per phase, requested explicitly)

| Phase | State after this phase | Valid rollback | Invalid / dangerous |
|---|---|---|---|
| **EXPAND-1** | Column added, empty, no deployed app version reads/writes it yet. | `ALTER TABLE "Asset" DROP COLUMN "relativePath";` — safe right now, nothing depends on it. | — |
| **EXPAND-2** | Some/all instances run app code that writes `relativePath` on new Assets. | **App rollback must complete first**: redeploy the pre-EXPAND-2 app version to every instance (it never references the column). *Only after that succeeds* is `DROP COLUMN` safe again. | Dropping the column while **any** instance still runs EXPAND-2 code — every subsequent Asset-creating write on that instance fails with a real "column does not exist" error (the exact live-DB failure mode this whole design has been careful to avoid triggering by accident). |
| **GATE** | Verification only; no new state. | Not a rollback point — if GATE fails (old writers detected, or the live-NULL count still growing), finish or roll back EXPAND-2 (above); do not proceed to BACKFILL. | Proceeding to quiesce/BACKFILL with GATE unresolved. |
| **BACKFILL** | Real, valuable `relativePath` values now populate most previously-NULL rows. | **Prefer roll-forward, not reversal**: if a resolution bug is found, fix the resolver and re-run `--apply` (idempotent — only touches rows still `NULL`, corrective updates for already-wrong-but-non-NULL rows are a separate, explicit, scoped `UPDATE` by asset id, never a blanket reset). A full reversal (`UPDATE "Asset" SET "relativePath" = NULL WHERE ...`, scoped) is available only for rows this specific backfill run touched (trivial to identify: it wrote a value where one was `NULL` moments before) and should be treated as a last resort, since it destroys work that is expensive (though not impossible) to redo. Dropping the column here is not blocked by app dependency (EXPAND-2 tolerates a null/absent value at this stage), but discards all accumulated data — avoid unless the corruption is systemic. | Silently "fixing" bad data with an unscoped `UPDATE ... SET "relativePath" = ...` that touches rows outside what this run wrote, or that guesses/invents a value (ยง4/ยง5 forbid inventing paths in every other context; this is no exception). |
| **ENFORCE** | `asset_live_requires_relative_path` CHECK constraint and the identity trigger are both installed. | **Incident rollback = de-enforce only, never touch data**: `ALTER TABLE "Asset" DROP CONSTRAINT asset_live_requires_relative_path;` and `DROP TRIGGER asset_relative_path_guard_trigger ON "Asset"; DROP FUNCTION asset_relative_path_guard();`. Immediately stops both enforcement rules (e.g., if the trigger has an unexpected false-positive blocking legitimate writes in production) while investigation continues — the column and every backfilled value are fully preserved, and re-running `step-b-trigger.sql` later re-installs enforcement without needing BACKFILL again. | Dropping the column or resuming writers with an unresolved incident still live. |

**The one universal rule across every phase**: a schema/enforcement rollback that would make a currently-deployed application version start failing its own writes is never valid until that application version itself has been rolled back or upgraded past the dependency. EXPAND-1→EXPAND-2 is the only transition where this actually bites (see the EXPAND-2 row); every later phase's rollback is data/enforcement-scoped and doesn't require an app rollback at all.

An incident rollback that manually reverts a `prisma migrate deploy`-applied migration's effect (e.g., ENFORCE's `DROP CONSTRAINT`/`DROP TRIGGER`) should be followed by `prisma migrate resolve --rolled-back <migration-name>` so `_prisma_migrations` reflects reality — otherwise a later `prisma migrate deploy` on this same environment would see that migration as already applied and skip it, even though its effect was just manually undone.

### 10d. Durable migration history — how this is represented so a fresh environment or `prisma migrate deploy` can reproduce it

Everything built this session lives in `specs/proposals/` and `scripts/`, deliberately outside `prisma/migrations/` and `schema.prisma`, so nothing could be auto-applied by an incidental `prisma migrate dev`/`deploy` before approval. That is correct for *this checkpoint*, but it means, as-is, there is no plan for Phase 027 to ever become durable, tracked migration history — a real gap, corrected here.

**The plan**, staged and ready at `specs/proposals/asset-relative-path/prisma-migrations-staging/` (full detail in that directory's `README.md`):
- **EXPAND-1** is representable in `schema.prisma` (a plain nullable `String?` field) — a real diff is prepared (not applied): `Asset.relativePath String?` added to the existing model, no other change. Its migration folder (`EXPAND1_add_asset_relative_path/migration.sql`, content identical to `step-a-add-column.sql`) is staged, ready to be moved into `prisma/migrations/<real-timestamp>_add_asset_relative_path/` and applied via `prisma migrate deploy` — not a bare `psql -f` — at execution time (ยง10's EXPAND-1 exact commands, updated to match).
- **ENFORCE**'s CHECK constraint and trigger are **not** expressible in `schema.prisma`'s DSL — Prisma has no first-class concept for either. This is Prisma's own documented supported pattern: a hand-authored `migration.sql` in a normally-named folder, applied and tracked by `prisma migrate deploy` exactly like a generated one. Staged at `ENFORCE_asset_relative_path_guard/migration.sql` (content identical to `step-b-trigger.sql`), same move-then-deploy execution.
- **BACKFILL has no migration folder, deliberately.** It is a one-time data operation, not a schema change — Prisma's own guidance is to keep data backfills out of `migration.sql` (they can be slow and need custom per-row logic, exactly true here: three-way source resolution, per-row normalization). `scripts/027-backfill-relative-path.ts` staying a standalone script, outside `prisma/migrations/`, is the correct pattern, not a gap.
- **A future `prisma db pull`/introspection** will not represent the CHECK constraint or trigger in `schema.prisma` (Prisma has no syntax for either) — expected and accepted, not schema drift to chase.

This makes `prisma migrate deploy` the actual EXPAND-1 and ENFORCE execution command in ยง10's exact-commands sections (updated above), not a parallel, untracked `psql` action — a fresh environment built from this repository's migration history after Phase 027 ships will reproduce the exact same column, constraint, and trigger.

## 11a. Spike evidence (2026-09-28, run once, results below; script and full output preserved by the operator for this report)

Ran against `_spike_027`, an isolated sandbox schema/table created and dropped by the script itself — the real `Asset` table and all 66 historical duplicates were never referenced by DDL or DML at any point. Historical duplicates in the sandbox (`hist-a`, `hist-b`, both `('ds1','dup/a.png')`) were inserted via two separate statements **before** the trigger was created, mirroring reality (the real 66 rows predate any guard; a `CREATE TRIGGER` never re-validates existing rows).

| # | Property required | Result |
|---|---|---|
| 1 | Insert at a historical occupied identity is rejected | PASS — `P2010`/`23505` |
| 2 | Two concurrent inserts for the same new identity: exactly one success, one conflict | PASS — 1 success, 1 failure (`P2010`/`23505`) |
| 3 | Unrelated update to a historical-duplicate row succeeds | PASS — a column outside the trigger's `UPDATE OF (...)` list updates without the trigger firing at all |
| 3b | *(documented edge case, not a pass/fail requirement)* Re-affirming a historical duplicate's own `relativePath` to its current value, with a live sibling still holding it | Correctly **rejected** — the trigger has no "value unchanged" special case, and the invariant it enforces is already violated by the pre-existing sibling. Consequence for Step C: application `update()` calls must not gratuitously resend `relativePath` when it isn't actually changing — Prisma's typed `update()` already only emits `SET` clauses for keys present in `data`, so this is a non-issue in practice, but is the mechanism, not a coincidence. |
| 4 | Changing a historical row's identity to another occupied path is rejected | PASS — `P2010`/`23505` |
| 5a | Soft-deleting one of two live duplicate siblings does not, by itself, free the identity while the other sibling is still live | PASS — a new insert at that identity still fails while `hist-a` remains live |
| 5b | Once the *last* live holder of an identity is soft-deleted, the identity is genuinely free | PASS — a new insert then succeeds |
| 5c | Reviving a soft-deleted row back into an identity now held live by another row is rejected | PASS — `P2010`/`23505` |
| — | Advisory lock derived from the exact `(datasetId, relativePath)` identity, acquired before the authoritative `EXISTS` check | By construction/code inspection — `pg_advisory_xact_lock(hashtextextended(NEW."datasetId" || ':' || NEW."relativePath", 0))` is the trigger's first statement, before the `IF EXISTS (...)` query; see ยง6's SQL. |
| — | Exact error shape via `$executeRawUnsafe` (raw-query path only — see ยง11c for the typed-call path, which differs) | `PrismaClientKnownRequestError { code: "P2010", meta: { code: "23505", message: "Unique constraint failed: " } }`, confirmed 6 separate times across tests 1/2/3b/4/5a/5c, all identical. **This shape is specific to the raw-query call style and is not what Step C's typed calls will see — see ยง11c.** |

## 11b. Withdrawn: the original "unchanged in substance" claim

This section originally claimed the ยง10 SQL backfill and a `P2010`-based error mapping could ship as-is once the raw-query spike passed. **Both were wrong**, caught by the follow-up spike in ยง11c: typed calls (the actual Step C call style) do not produce `P2010`, and a SQL `UPDATE` backfill risks NFKC/normalization drift against the TypeScript runtime path. ยง10 (and its ยง10a–ยง10c subsections) above are the corrected, final design; this section is kept only so the correction is visible in the document's history rather than silently overwritten.

## 11c. Follow-up spike: typed Prisma calls, narrow error marker, NFKC (2026-09-28)

Ran against a **fully disposable Prisma model and disposable generated client** — a throwaway `.prisma` schema file (never `prisma/schema.prisma`), generated to a scratch output directory (never `lib/generated/prisma`), backed by a dedicated `_spike_027_typed` Postgres schema with its own tables. The real `Asset` table, the real generated client, and the real project schema were not read or written at any point. Historical duplicates were seeded with the trigger explicitly disabled (`ALTER TABLE ... DISABLE TRIGGER`), then re-enabled — the same "history predates the guard" mirroring as the first spike, this time safe to do repeatedly across three trigger variants on one disposable table.

**Why a follow-up was necessary at all:** the first spike (ยง11a) only exercised `$executeRawUnsafe`. Its `P2010`/`meta.code:"23505"` shape turned out to be **specific to that call style** and does not occur for typed `.create()`/`.update()` calls, which Step C actually uses.

**Three trigger variants compared, typed calls only:**

| Variant | RAISE clause | Typed-call result |
|---|---|---|
| Custom SQLSTATE (`ERRCODE = 'AN001'`) | `USING ERRCODE = 'AN001', CONSTRAINT = '...'` | `PrismaClientUnknownRequestError`, `code: undefined`, `meta: undefined`. The only surviving evidence is the RAISE message text, buried inside an internal `ConnectorError(ConnectorError { ... PostgresError { ... } })` debug string with no documented format guarantee. **Rejected as a design** — strictly worse than the standard-code variants below. |
| Standard `unique_violation`, with `CONSTRAINT = '...'` label | `USING ERRCODE = 'unique_violation', CONSTRAINT = 'asset_relative_path_guard'` | `PrismaClientKnownRequestError`, `code: "P2002"`, `meta: { modelName: "SpikeAsset027Typed", target: null }`. The `CONSTRAINT` label had **zero observable effect** — Prisma cannot resolve `target` for a constraint it doesn't recognize from schema introspection, regardless of the label. |
| Standard `unique_violation`, no `CONSTRAINT` label | `USING ERRCODE = 'unique_violation'` | Identical shape to the row above. |

Every one of the three create/concurrent-create/update-retarget scenarios from ยง11a was re-run against each variant via genuine typed `db.spikeAsset027Typed.create()`/`.update()` calls — all passed for the two standard-SQLSTATE variants using the corresponding shape; the custom-SQLSTATE variant technically also passed (its message text was matched), but is not the chosen design, for the reason above.

**The narrowness proof — does any *real* schema-known constraint ever also produce `target: null`?** Tested twice, both give a populated array, never `null`:
- A genuine single-column `@unique` (`tag`) violated via typed `.create()` → `meta: { modelName: "SpikeOther027Typed", target: ["tag"] }`.
- A genuine composite `@@unique([a, b])` (structurally representative of `Asset`'s existing `[storageProvider,storageBucket,storageKey]`-style composite uniques) violated via typed `.create()` → `meta: { modelName: "SpikeComposite027Typed", target: ["a", "b"] }`.

Across every trial, `target` was `null` if and only if the conflict came from the trigger, and a real field-name array otherwise. **`error.code === "P2002" && error.meta?.target == null` (scoped to `modelName === "Asset"`) is therefore the application's stable, narrow `IMPORT_ITEM_CONFLICT` marker** — proven to not collide with `Asset`'s existing declared unique constraints, not merely assumed to.

**NFKC collision, demonstrated, not just asserted:** `"café.png"` (8 UTF-16 code units, precomposed é) and `"café.png"` (9 code units, `e` + combining acute) are byte-distinct (`rawEqual: false`) but become identical after `.normalize("NFKC")` (`nfkcEqual: true`). A plain SQL `=` comparison of the two raw, un-normalized strings correctly (for a naive equality check) treats them as different rows — proving that if normalization happened only on one side (e.g., a SQL backfill that skipped it) while the trigger/comparison stayed byte-level, the two forms would silently NOT collide when they should. This is exactly why ยง10 puts NFKC normalization in exactly one place (the shared TS function, called before any write), and lets the trigger do nothing but byte-equality comparison of already-normalized values.

All spike infrastructure — the `_spike_027_typed` Postgres schema, its tables/function/trigger, the disposable generated client directory, and the temporary in-repo `.spike-027-typed/schema.prisma` used only to invoke `prisma generate` — has been dropped/deleted. `git status` shows no trace of it; the real `Asset` table's row count was re-checked afterward and reflects only unrelated, independent activity (609, up from 597 at the ยง8 audit and 609 confirmed unchanged by this spike specifically).

## 13. Implementation status (2026-09-28, updated through this checkpoint — round 3)

Real code, real tests, no real migration. Full detail and command-by-command results are in this checkpoint's report; summary below.

**Created (round 1)**: `packages/domain/src/{asset-relative-path,asset-identity-conflict,asset-relative-path-backfill,asset-write-quiescence}.ts` (+ 30 tests); `apps/worker/src/jobs/coco-export-serializer.ts` (+ 4 tests, 1 real-DB); `scripts/027-{backfill-relative-path,verify-trigger}.ts`, `apps/web/scripts/027-toggle-asset-write-pause.ts`; `specs/proposals/asset-relative-path/{step-a-add-column,step-b-trigger,trigger-verification-queries}.sql`.

**Created (round 2, this checkpoint)**: `packages/domain/src/asset-revival.ts` (ยง6a's application-layer revival guard, +5 tests); `apps/web/src/lib/asset-write-quiescence-guard.ts` and `apps/worker/src/providers/asset-write-quiescence-guard.ts` (the quiescence check, now actually wired into both real Asset-creating write paths, not just designed); `apps/web/tests/asset-write-quiescence/guard.test.ts` (+4 tests against real Redis); `scripts/027-collision-fingerprint.ts` (ยง6b, run for real: baseline fingerprint `e32caa5f...` captured and confirmed reproducible).

**Modified (round 1)**: `apps/worker/src/jobs/export-dataset.ts` (JSON/COCO branching), `apps/web/src/lib/validation/export.ts`, `apps/web/src/lib/exports/export-service.ts` (per-format idempotency key), `apps/web/src/lib/jobs/retry-job.ts`, `apps/web/src/components/exports/export-form.tsx` (format picker), `specs/api/openapi.yaml`, `specs/api/schemas/jobs.yaml`.

**Modified (round 2)**: `apps/web/src/lib/asset-upload.ts` and `apps/worker/src/jobs/repository-asset-upsert.ts` (quiescence guard wired into `publishUploadedAsset`/`upsertMirroredRepositoryAsset`, the only two reachable production Asset-creating functions per ยง10a's inventory); `apps/web/src/app/api/assets/complete-upload/route.ts`, `apps/web/src/lib/imports/complete-local-folder-item.ts`, `apps/web/src/lib/api-response.ts` (503 `ASSET_WRITES_PAUSED_FOR_MIGRATION` mapping); `specs/proposals/asset-relative-path/step-b-trigger.sql` (added the `asset_live_requires_relative_path` CHECK constraint, ยง6a).

**A real defect was found and fixed in round 2**: the worker-side quiescence guard's first cut used a persistent shared Redis connection and left `node --test` hanging indefinitely after `tests/repository-import/asset-upsert.test.ts`'s assertions had already passed, because that test calls the real write function in-process with no spawned server to own the connection's lifecycle (unlike the web side's HTTP-based tests). Fixed by using a fresh, closed-in-`finally` connection per check on the worker side.

**The identical defect recurred on the web side in round 3, and was fixed the same way, not assumed safe by analogy.** Writing the permanent writer-boundary test (`apps/web/tests/asset-write-quiescence/writer-boundaries.test.ts`, calling `publishUploadedAsset` directly, in-process, with no spawned `next start`) reproduced the exact same hang for the web guard's own persistent-singleton connection. Fixed by converting it to the same fresh-connection-per-check pattern (with an injection seam kept for `guard.test.ts`'s own external-connection tests). Confirmed by rerunning both new tests to a clean exit (`exit=0`, both processes) plus every other web/worker suite this phase touches.

**Round 3 additions**: `packages/domain`'s lifecycle-predicate audit (ยง6a) confirmed by repository-wide search, not assumed — `Asset.archivedAt` and `AssetStatus.ARCHIVED` are both real schema fields that are **never written anywhere** in `apps/web/src` or `apps/worker/src` today; only `Asset.deletedAt` is real and written (by exactly 2 functions, one-way). The CHECK constraint and its abort query now reference the exact `deletedAt IS NULL`/`IS NOT NULL` predicate, never the retired word "live". `scripts/027-collision-fingerprint.ts`'s `e32caa5f...` value is now documented as illustrative evidence only — the QUIESCE procedure (ยง10) captures its own fresh, authoritative PRE fingerprint at the start of each real cutover instead. Durable migration-history staging added at `specs/proposals/asset-relative-path/prisma-migrations-staging/` (ยง10d) — `schema.prisma`/`prisma/migrations/` diffs fully prepared, still not applied. Two new permanent writer-boundary tests (`apps/web/tests/asset-write-quiescence/writer-boundaries.test.ts`, `apps/worker/tests/repository-import/asset-upsert.test.ts`'s new pause test) prove PAUSE ON blocks and PAUSE OFF restores the two real writer functions themselves, not just the standalone guard.

**`resolveCocoFileName`** (`coco-export-serializer.ts`) is the one place `file_name`/the images-sort-key is derived; it already prefers `relativePath` over `filename` whenever present. As of round 3 the real `select` still omits it (the column didn't exist yet), so behavior was unchanged. **As of round 4 (ยง13a), the column exists and new writes populate it — but the COCO serializer's own `select` has still not been touched this round**, so its behavior remains unchanged (filename-keyed) until that one line is added, which stays correctly sequenced after BACKFILL per your instruction (a Dataset exported today would still see filename-keyed output even for a brand-new, already-relativePath-bearing Asset, since nothing reads the column yet).

**Never touched, through round 3**: `schema.prisma`, `lib/generated/prisma`, `prisma/migrations/`. **Round 4 (ยง13a) changed this deliberately and by explicit approval**: EXPAND-1 is now real, applied migration history, not a pending proposal — see ยง13a for the full record. The 30 collision groups / 66 historical live Assets remain unchanged, reconfirmed by the ยง6b fingerprint immediately before and after EXPAND-1.

**Full real-stack E2E (Postgres+Redis+MinIO, COCO export → Job → BullMQ → worker → artifact → download → content validation)**: correctly sequenced *after* the real migration and the `relativePath` switch, per instruction — not run yet, not claimed as done. Today's suites pass with Redis-dependent cases skipped (local Redis isn't wired for the test harness's safe-test policy here); that is explicitly not treated as closure evidence for this phase.

## 13a. EXPAND-1 and EXPAND-2 — executed (2026-09-28, round 4)

**EXPAND-1 executed, exactly and only the additive column, through `prisma migrate deploy`:**
- Migration `20260928154856_add_asset_relative_path` (`ALTER TABLE "Asset" ADD COLUMN "relativePath" TEXT;`), applied via `npx prisma migrate deploy`. `_prisma_migrations`: `finished_at` set, `rolled_back_at` null, `applied_steps_count = 1`.
- Post-DDL: `relativePath` exists, `is_nullable = YES`, `data_type = text`. `SELECT count(*) FROM "Asset" WHERE "relativePath" IS NOT NULL` = 0 immediately after. Total `Asset` row count unchanged (609, before and after).
- ENFORCE objects confirmed absent both before and after: `asset_live_requires_relative_path` constraint, `asset_relative_path_guard_trigger` trigger, `asset_relative_path_guard` function — zero rows for all three, both times.
- Collision fingerprint identical before and after EXPAND-1: `e32caa5f7bfed3d8be8c3e585e3dac147856dccc1c1fb5d3c5d4e6478f22a52e` (`--pre`). `--post` now runs (column exists) and correctly returns 0 groups (nothing backfilled yet).
- Redis quiescence flag confirmed off before and after.
- `schema.prisma` updated (`Asset.relativePath String?`, documented inline) and the client regenerated (`prisma generate` + the project's whitespace-normalize script) — offline operations, no further DB call.

**EXPAND-2 applied** (single-environment dev setup — see the disclosed note below on what "every writer instance" means here): both reachable writer functions (§10a's inventory) now set `relativePath` via the shared normalizer, rejecting the write outright on failure:
- `apps/web/src/lib/asset-upload.ts`'s `publishUploadedAsset` — accepts an optional `relativePathHint` (used by folder-import completion, which now passes `PreparedImportItem.normalizedPath`); a plain upload falls back to its filename. Throws `UploadPublicationFailure("INVALID_RELATIVE_PATH")` → HTTP 422 on normalization failure.
- `apps/worker/src/jobs/repository-asset-upsert.ts`'s `upsertMirroredRepositoryAsset` — now takes `sourceRootPath` from the caller and reuses `resolveHistoricalCandidateRelativePath` (the same resolver BACKFILL uses) to compute it, so a new repository-import write and a backfilled historical row are computed identically. Throws on normalization failure.
- **Proven with real writes, not asserted**: both permanent writer-boundary tests now assert the created row's `relativePath` matches the expected canonical value.
- **Environment reality, disclosed**: this is a single dev environment with one `apps/web` and one `apps/worker` process reading from this same working tree — there is no separate fleet/rolling-deploy mechanism to orchestrate here. "Every writer instance" in this environment is satisfied by the source change itself; a real multi-instance production deployment would need its own rollout confirmation per §10's GATE step, which this environment cannot demonstrate.
- **Not done, deliberately**: `prepare-local-folder-import.ts`'s pre-existing `.toLowerCase()` case-folding was left untouched — changing it now would additionally tighten folder-import's own accept/reject surface (rejecting some previously-accepted, now-invalid-under-`normalizeAssetRelativePath` paths), a distinct behavior change not explicitly authorized by this approval.
- **BACKFILL was not started.** Two dry-runs of `scripts/027-backfill-relative-path.ts`, minutes apart, report the identical count both times: 609 candidates (597 live, 0 archived, 12 deleted), 0 unnormalizable, 30 live collision groups / 66 assets, 0 cardinality violations — stable, no drift between runs.

## 14. Non-goals
Provider `/format` proxying or merging; a scope/source filter on export (dropped); AI-task-level formatted-result download (future, separate feature); cleanup of the 66 historical duplicates; cleanup of dead `AnnotationStatus` values or `updateAnnotationInputSchema`.
