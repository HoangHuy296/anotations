# T008 — migration 24 provenance: release exception for acceptance

**Status: ACCEPTED 2026-10-05** by the project owner as exception RPE-029-M24. The acceptance **accepts** the missing provenance between `abf72fd2…` and the final `13f0e977…`; it does not reconstruct or erase it, and it does not claim recovery of the unavailable old migration bytes. Nothing here rewrites history, fabricates a missing record, or changes any SQL byte.

## Recorded facts
1. **Early evidence used a different SHA-256.** The G2 and early G3 runs recorded the candidate checksum `abf72fd238a8caec79c6c018662debadb7d01a7fbcf5dee8f3337d95dbe55bc9` (`abf72fd2…`). Runs: `g2/20260930T143753Z`, `g2/20260930T145123Z`, `g3/runs/20260930T150233Z`, `g3/runs/20260930T150534Z`, `g3-retry/runs/20261001T031440Z`, `g3-retry/runs/20261001T031819Z`, `g3-contention/runs/20261001T033314Z`, `…034355Z`, `…035416Z`.
2. **The frozen release candidate has SHA-256 `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7`** (`13f0e977…`, 7,526 bytes), now at `prisma/migrations/20260930030000_dataset_modality_g2/`. First recorded use: `g3-contention/runs/20261001T043731Z` (the earlier note in `mvp-modality-card-status-20261005.md` names `g3-retry/…T084416Z`; the contention run is earlier and is the correct first use). The file's modification time, 2026-10-01 11:34 +07 = 04:34 UTC, lies between the last `abf72fd2…` run (≈03:54 UTC) and that first use (04:37 UTC).
3. **The contemporaneous transition diff and any approval of it are unavailable.** None was found in the repository, in the verification tree, or in the archive (`.data/cleanup-archives/…`, `ARCHIVE-INDEX.md`).
4. **The old bytes are not preserved.** The `abf72fd2…` file exists in no commit, no archive and no evidence directory.
5. **Stale statements remain in earlier handoffs** (`verification/g3-retry/handoff.md`, `verification/g3/retry-defect-handoff.md`, `final-g3-receipt.json`): they describe the candidate as unchanged at `abf72fd2…`. They are history and are left unedited; this document supersedes them for the question "which bytes were verified later".

## Read-only reconstruction from archived evidence (no bytes invented)
Both the last old-hash run and the first final-hash run archived the full installed definition of the 12 added objects (`exact-12-additions.json`, produced from the reviewed schema manifest: definitions of the columns, constraints, triggers and `pg_get_functiondef` of each function). Comparing `g3-contention/runs/20261001T035416Z` (old) with `…T043731Z` (final):

- **11 of the 12 entries are identical**: 4 columns, 2 CHECK constraints, 3 triggers, and the functions `phase029_guard_dataset_insert()` and `phase029_guard_dataset_assignment()`.
- **One entry differs: `phase029_guard_asset_write()`.** The old function took the parent Dataset fence (`UPDATE "Dataset" SET "modalityContentRevision" = … + 1`) on **every** Asset INSERT/UPDATE/DELETE. The final function adds a `requires_fence` test for UPDATE: when none of the evidence columns (datasetId, modality, source identity, storage, checksum, mime/size, width/height/duration/textLength, relativePath …) changed, it skips the parent UPDATE and instead reads the parent modality (plain MVCC read) and rejects only a mismatch. INSERT, DELETE and every evidence-changing UPDATE still take the fence exactly as before.
- **Limit of this reconstruction:** it recovers the installed object definitions, not the file bytes. Comments, whitespace or statement text outside those definitions (for example the header comments and the `SET LOCAL` lines) could have differed and cannot be known.

**Why it changed (evidence, not recollection):** the contention investigation immediately before the change (`g3-contention/runs/20261001T033314Z`–`…035416Z`) showed the old candidate exhausting its three attempts in 131 of 320 Serializable same-parent transactions at eight clients (baseline 2/320) and 108 of 320 in update-only. With the final bytes (`…T045031Z`): 3/320 and 0/320 (baseline 3/320 and 1/320); metadata same-parent p50 22.7 ms vs 39.3 ms for the old candidate. This is consistent with a deliberate contention fix, but no document records the decision.

## What applies to the final bytes
Everything below was run against `13f0e977…` (each run records that checksum):
- G3 concurrent correctness schedule (17 steps) — `g3-contention/runs/20261001T045031Z`, `g3-retry/runs/20261001T084416Z`, `…T112901Z`, `…20261002T052913Z`.
- Contention/benchmark comparison against the matched baseline — `g3-contention/runs/20261001T043731Z`, `…044338Z`, `…045031Z` (performance not accepted; see the T007 review).
- Disposable migration, schema delta of exactly 12 objects, historical Datasets unresolved, no data change — all g3-retry runs from `20261001T084416Z` and the release proof below.
- Runtime/contract verification in disposable infrastructure — `focused-runs/20261005T151306Z-8ef5d532` (ingestion replay, 12/12), `…T151630Z-444947ca` (repository reuse, 4/4), `…T090512Z-7478b8a9`, `…T095654Z-7aeb542a`, `…T101135Z-15df4e63`, `…T101254Z-b148440d`.
- Canonical release chain 23 → 24 → 25 from scratch — `focused-runs/20261005T160813Z-2c4c4b77` (`release-chain-proof.md`).
Nothing verified on the old bytes is relied on for release.

## Does the reconstruction change the safety assessment?
No new risk was found. The delta narrows the set of Asset UPDATEs that serialize on the parent Dataset row; it does not relax any check on INSERT, DELETE or an evidence-changing UPDATE, and the invariant for non-evidence UPDATEs (the asset's modality equals the resolved parent's, which is immutable once set) is still checked on every write. The behavior the narrowing relies on, "unchanged-modality metadata and cleanup allowed", "metadata/workflow preserve revision semantics" and "different-Asset metadata writes skip the parent fence", is covered by G3 correctness steps that passed on the final bytes. What stays unrecoverable is the review history of the change; that is a process gap, not a technical one.

## Proposed release provenance exception (for acceptance)
> **Exception RPE-029-M24.** Release accepts migration `20260930030000_dataset_modality_g2` with SHA-256 `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7` although (a) early G2/G3 evidence used `abf72fd2…`, (b) no contemporaneous diff or approval of the change exists, and (c) the earlier bytes are not preserved. The acceptance rests on: the read-only reconstruction above (one function, `phase029_guard_asset_write()`, narrowed the parent-fence rule for non-evidence UPDATEs; 11 of 12 objects unchanged), and on all correctness, concurrency, disposable-migration and runtime verification having been executed against the final bytes. The exception does not extend to any other file, does not waive the T007 SQL approval, and does not authorize applying the migration anywhere.

| Acceptance | |
| --- | --- |
| Accepted by | Project owner (instruction given in the session of 2026-10-05) |
| Date | 2026-10-05 |
| Conditions | The reconstructed installed definitions (`phase029_guard_asset_write()` is the only differing object) are supporting evidence only. The old migration bytes, the contemporaneous diff and any approval of the change remain unavailable and are not claimed to be recovered. The acceptance covers migration 24 only, does not waive the T007 approval (separately granted for the exact bytes), and does not authorize applying the migration anywhere |

T008 (G-MIG provenance item) is closed by this acceptance. Applying any migration to the shared dev database remains a separate, ungranted gate.
