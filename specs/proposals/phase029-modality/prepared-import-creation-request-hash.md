# Phase 029 / T015 — migration 25: `PreparedImport.creationRequestHash`

**Status: PROMOTED to the canonical active chain (release-chain commit, 2026-10-05); NOT applied to the shared dev database.** The migration now lives at `prisma/migrations/20261006000000_prepared_import_creation_request_hash/migration.sql` (byte-identical to the frozen proposal, SHA-256 `a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859`, 68 bytes). Canonical `prisma/schema.prisma` and the tracked generated client already contain the field (accepted earlier; schema SHA-256 `4fe3d96a…`). The runner bindings were updated for the 25-migration chain. This promotion is not an authorization to apply it anywhere: shared-dev application remains a separate gated step (see `specs/029-modality-specific-datasets/release/README.md`). Disposable proof: `release:phase029-chain` PASS, history 25, schema entries 1829 → 1841 → 1842.

## Migration
- Path: `prisma/migrations/20261006000000_prepared_import_creation_request_hash/migration.sql` (sorts after migration 24; moved from `specs/proposals/phase029-modality/migrations/` unchanged).
- SQL (the whole file): `ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" TEXT;`
- Nullable, no default, no backfill, no index, no uniqueness, no trigger, nothing else.
- Migration 24 (`20260930030000_dataset_modality_g2`) is untouched: SHA-256 `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7`.
- Prisma diff (now in the canonical schema and tracked client): `creationRequestHash String?` in `model PreparedImport`, no attributes. `prisma migrate diff` between the 25-migration database and the canonical schema reports no difference.

## Meaning of the column
`NULL` = the preparation carried no confirmed taxonomy (every historical row and every no-class request), so existing no-class replay behavior is unchanged.
A non-null value is the hash below. It is immutable after creation and is never read for anything except replay comparison.

## Canonical taxonomy contract
- Request field: optional strict `confirmedClasses: string[]`, **0..100 entries**; 101 fails with 400 `INVALID_REQUEST` before any creation/import side effect. The same limit must appear in server validation, OpenAPI and tests.
- Absent and `[]` both mean no confirmed taxonomy.
- Each name uses the existing label-name rule (trimmed, 2–50).
- Normalization is exactly `normalizeLabelName` (trim + `toLocaleLowerCase("en-US")`); no Unicode normalization.
- A normalized duplicate rejects the whole request with 400 `INVALID_REQUEST`.
- Identity = the sorted set of normalized names. Request order and display casing do not affect it.
- Persisted display name = the trimmed spelling from the first successful creation; an equivalent replay never rewrites Labels.
- Labels use `modality = Dataset.modality`, `scope = OBJECT`. No TEXT scope is inferred.
- Color is server-derived and excluded from identity. `POST /api/datasets` gains no idempotency mechanism.

### Folder start fingerprint (stored in this column, only when classes are non-empty)
`sha256_hex(JSON.stringify({ v: 1, kind: "local-folder-creation", modality, taxonomy: [sorted normalized names] }))`

Examples (computed offline):

| Request | Result |
| --- | --- |
| IMAGE `["Car"," person ","Traffic Sign"]` | `3738861fa6fe048ace7a091d87a423513e799ffa50ce6e42a88cbe81f654f8dd` over `{"v":1,"kind":"local-folder-creation","modality":"IMAGE","taxonomy":["car","person","traffic sign"]}` |
| IMAGE `["traffic sign","CAR","Person"]` | identical to the row above |
| IMAGE `["Car","person","Bus"]` | different (`bd047794…`) |
| VIDEO with the first request's classes | different (`68420490…`) |
| `[]` / absent | `NULL` |
| `["Car","car "]` | rejected (duplicate) |

Replay: compare `stored ?? null` with the computed value; any difference is `IDEMPOTENCY_KEY_CONFLICT` (this includes adding or dropping classes relative to the original).

### Repository fingerprint
The existing Dataset `creationRequestHash` canonical JSON gains `taxonomy: { v: 1, classes: [sorted normalized names] }` **only when non-empty**, so a no-class request stays byte-identical to today's.

## Color (bounded, deterministic)
Palette: the existing 24 uppercase `LABEL_COLORS` presets (moved to a shared constant; the manual picker is unchanged).
Process the sorted normalized names in order. For the name at index `i`:
1. `base = hash(name) % 24`, with `hash = (h*31 + codepoint) >>> 0` over the normalized name (the worker's `labelColor` formula, copied, not imported).
2. If `i < 24`: try `base, base+1, … base+23 (mod 24)` (at most 24 steps, a `for` loop, never `while`) and take the first palette entry not used by an earlier name. Fewer than 24 are used when `i < 24`, so one always exists.
3. If `i >= 24`: stop uniqueness probing and use `base` (colors repeat).
No unbounded loop is possible. Colors are uppercase `#RRGGBB`, independent of request order, and excluded from identity. The worker `labelColor`, `aiPredictionColor`, default image labels and all historical colors are unchanged.

## Rollback
`ALTER TABLE "PreparedImport" DROP COLUMN "creationRequestHash";` (separately reviewed, never automatic). Dropping the column loses only the stored `PreparedImport.creationRequestHash` values (replay comparison of confirmed classes would then be unavailable). It does **not** delete persisted Labels or any Dataset, Job or Asset data.

## What the promotion did not authorize
Applying migration 24 or 25 to the shared dev database, taking the rollout backup, stopping or replacing any service, building or deploying release images, backfilling or resolving any historical Dataset, and pushing `main`. Each remains a separate explicit authorization.
