# Phase 029 — MVP modality card: audit/status record (2026-10-05)

## Audit exceptions recorded

1. **Read-only application-database access (disclosed).** During diagnosis of the creation 500, one read-only `information_schema.columns` query ran against the live application Postgres (`annotationplatformdev-postgres-1`), listing `Dataset` columns whose names contain "modal". Result: only `primaryModality` exists; `Dataset.modality` and the three related Phase 029 fields are absent, consistent with the recovered pre-Phase 029 schema. No rows were read, nothing was written, and no further application-database inspection was performed under this task.
2. **Migration-candidate provenance gap.** The candidate `specs/proposals/phase029-modality/migrations/20260930030000_dataset_modality_g2/migration.sql` changed from SHA-256 `abf72fd2…55bc9` to `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7` (file mtime 2026-10-01 11:34 +07; first receipt using the new hash is run `20261001T084416Z`). The G3-retry handoff and `final-g3-receipt.json` still state `abf72fd2…` as "unchanged". No contemporaneous approval or diff record was found and the old bytes are not preserved. The current checksum is accepted for verification continuity only; the gap must be resolved at the release/deployment review. Migration bytes were not modified.

## Scope boundaries held

No change to `prisma/schema.prisma`, the generated client, any migration, or any database. Migration 24 not applied. No live-stack rebuild. G5 run `20261005T042640Z` is not closure evidence (probe 1, `localhost:9000`, was never intercepted; unresolved browser-safety issue, untouched here).

## MVP UI implemented

- `ModalityCard` (labelled radio cards with icons; append mode shows the parent modality fixed) replaces the plain `<select>` on `/datasets/imports` and `/datasets/local-folder`.
- `ClassEntry` (confirmed-class badges, icon-only `Remove <name>` buttons, ARIA combobox/listbox, honest empty-recommendation state) is built and tested but **not mounted** in either form and **not sent** in any request.
- `lib/imports/recommended-classes.ts` is the single maintained-source boundary; it returns `{ status: "none" }` for all four modalities. No defaults were invented.

## Server-side confirmed classes: NOT implemented — contract ambiguities

The Phase 029 contract says only that fingerprints include "normalized confirmed taxonomy" and that classes validate "through existing label rules". It does not determine:

1. the request field name/shape for confirmed classes;
2. the source of a class `color` (existing Label rules require a 6-digit hex; manual entry supplies none);
3. server behavior for duplicate normalized names within one submitted list (reject vs collapse);
4. the canonical order used in the fingerprint (entry order vs sorted by normalized name);
5. the created Labels' `modality` and `scope` (universal `null`/`OBJECT` vs the Dataset modality / TEXT scopes);
6. whether replay with a different class list is an `IDEMPOTENCY_KEY_CONFLICT` for `/api/datasets` (the contract lists only repository and folder fingerprints).

Existing rules that are determined and were reused: name 2–50 trimmed (`labelSchema`), identity `normalizeLabelName` (trim + `en-US` lowercase), per-Dataset uniqueness (`@@unique([datasetId, normalizedName])`), single-label duplicate → `DUPLICATE_NAME`.
