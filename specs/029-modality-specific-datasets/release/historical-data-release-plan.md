# Historical Dataset release plan (plan only — nothing is backfilled or resolved)

Data source: read-only transactions on the shared dev database on 2026-10-05 (system identifier `7662655305624969250`, 23 migrations, `transaction_read_only = on`; counts and metadata flags only, no object bytes). Every figure is a fresh read, not the dated 116/609 audit. **No row was changed.** This plan is a proposal for the G-DATA gate; it authorizes nothing.

## 1. Inventory by asset composition (all 120 Datasets, including archived/deleted)
| Composition (all Assets) | Live | Archived/deleted | Total |
| --- | --- | --- | --- |
| EMPTY (no Asset) | 12 | 35 | 47 |
| IMAGE only | 48 | 9 | 57 |
| VIDEO only | 8 | 1 | 9 |
| AUDIO only | 0 | 0 | 0 |
| TEXT only | 1 | 0 | 1 |
| MIXED (more than one modality) | 6 | 0 | 6 |
| **Total** | **75** | **45** | **120** |

The **67 single-modality Datasets** are 57 IMAGE + 9 VIDEO + 1 TEXT (57 live, 10 not live). After migration 24, all 120 are unresolved (`modality` NULL).

## 2. The three legacy-`primaryModality` disagreements
`Dataset.primaryModality` is a legacy field; it is never used as a source of truth and is never copied into `modality`. It disagrees with the authoritative Asset composition in exactly three Datasets, and in all three the Assets are MIXED:
| Dataset | Legacy `primaryModality` | Authoritative Assets (live) |
| --- | --- | --- |
| `cms5m6k4y001110fcqkuoviit` | VIDEO | 7 Assets: 6 IMAGE, 1 VIDEO |
| `cms5yfsgf000g100zf3yfrw7h` | AUDIO | 19 Assets: 9 IMAGE, 4 VIDEO, 3 AUDIO, 3 TEXT |
| `cmudvng90015vpo0k8cr70pci` | IMAGE | 18 Assets: 16 IMAGE, 1 VIDEO, 1 AUDIO |

No single-modality Dataset disagrees: of the 67, 39 carry a matching `primaryModality` (33 IMAGE, 6 VIDEO) and 28 carry NULL. The other three MIXED Datasets (`cms7al8r5001210cg7zmi72hw`, `cmshgaiqi018np70kbpzk40g2`, `cmswufc1i001dmm0kj4bloc9l`; each 5 IMAGE, 1 VIDEO, 1 AUDIO) have a NULL legacy value. Rule: **assignment is derived only from the verified Assets; a legacy value that agrees adds nothing and one that disagrees is ignored and reported.** The legacy field is left untouched (decision D-5).

## 3. Cohorts of the 67 single-modality Datasets
Cohort membership uses database metadata only (Asset modality, storage reference, subtype row, in-flight Jobs). It is **provisional** until the fresh dry run (T029) re-reads everything at migration time and verifies source identity.
| Cohort | Rule | IMAGE | VIDEO | TEXT | Datasets | Assets | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A — ready** | live, every Asset has a storage reference and its subtype row, no non-terminal Job, no PREPARING import | 24 | 4 | 1 | **29** | 189 | proposed first backfill set |
| **B — ready after in-flight disposition** | as A but the Dataset has a non-terminal Job or PREPARING import | 5 | 1 | 0 | **6** | 43 | backfill only after those Jobs/imports are terminalized (`in-flight-work-plan.md`) |
| **C — metadata incomplete** | live, at least one Asset has no storage reference and no subtype row | 19 | 3 | 0 | **22** | 22 | **not eligible**; remediation first (T030). 19 IMAGE Datasets have one Asset with neither storage reference nor `ImageAsset`; 3 VIDEO Datasets one Asset without `VideoAsset` (22 missing subtype rows, matching the earlier audit); 8 of the IMAGE ones also have stale in-flight Jobs |
| **D — not live** | archived or deleted, metadata clean | 9 | 1 | 0 | **10** | 296 | separate decision D-4; recommended: leave unresolved until a restore is requested |
| **Total** | | 57 | 9 | 1 | **67** | | |

Weight of the data: the live VIDEO Datasets hold 154,344 annotations; all four substantial ones (128,363; 12,987; 12,986; 8) are in **cohort A**. The 48 live IMAGE Datasets hold 80 annotations. Cohort C VIDEO Datasets hold none.

`EMPTY` and `MIXED` are not part of any cohort and are never backfilled:
- **EMPTY** keeps `modality` NULL. The 12 live EMPTY Datasets are resolvable by their owner or an administrator through the already-built explicit resolution action (one-time, immutable receipt, current-role check; verified in `g2:candidate`). The 35 not-live EMPTY Datasets (13 of them with stale in-flight work) are not resolvable until restored.
- **MIXED** (6, all live) keeps `modality` NULL and **has no resolution action**. It is never split, moved, deleted, relabelled or assigned; the workspace shows the unresolved state. Any future policy needs its own approval.

## 4. Can a receipt-bound post-M24 backfill of the verified set happen in the same maintenance window?
**Yes in design; not yet in fact.** It can stay a distinct evidence and action boundary, and it can eliminate the degraded interval entirely for cohorts A and B. But **the tooling does not exist**: the repository contains only the EMPTY resolution action. T029 (select-only dry run) and T031 (per-candidate Serializable assignment) are open and must be built, reviewed and proven on a disposable database first.

Proposed window shape (each arrow is a separate gate with its own receipt, evidence directory and authorization):
1. drain and back up (`rollout-sequence`, outside this document) → apply M24 → apply M25 → **boundary 1: schema evidence closed and signed** (history 25, 1842 entries, 120 Datasets still NULL, table fingerprints unchanged);
2. **web and worker stay stopped.** With no application writer running, the fence protocol's quiescence assumption holds and no user sees a degraded workspace;
3. **backfill action (G-DATA, separately authorized):** fresh read-only dry run → approved-ID manifest (hash bound into the receipt) → per-candidate assignment → **boundary 2: backfill evidence closed**;
4. start the new web and worker together → application postflight.

Rules for the action itself:
- Inputs: the approved Dataset ID list only (cohort A first; B after its disposition; never C, D, EMPTY or MIXED unless separately approved).
- Per candidate: verify Asset composition and source identity outside the lock, then one Serializable transaction that claims the parent fence, requires the returned counter to equal the dry-run counter plus its own single increment, re-reads every Asset ID, modality and source-identity field, and assigns only a still-NULL parent (`modality`, receipt subject, resolvedAt). The trigger repeats the equality check.
- Stop on the first stale or failed candidate; remaining Datasets stay unresolved (degraded but safe); no automatic retry.
- **Assignments are immutable by trigger.** A wrong assignment cannot be corrected without a separately reviewed corrective migration or a restore, so the dry run, the approved-ID hash and the pre-action backup are the only safeguards. This is why the action needs its own approval and why the window must not merge it with the schema change.
- Resolver subject: an opaque receipt string (≤128 chars) identifying the run, for example `system:phase029-backfill:<receipt-id>` (decision D-6).
- Byte identity: database locks do not freeze object bytes. Either verify an immutable identity per object (ETag/size/version already stored as source identity) or block that candidate; no new storage versioning is assumed.
- If the window is cut short, services can start with every Dataset unresolved: the accepted degraded state of section 5.

## 5. If no backfill happens before runtime cutover (fallback state)
All 120 Datasets are unresolved. Behavior (from the implementation, the contracts and disposable tests; not exercised on the shared database): workspace shows "resolution needed" with no engine and no annotation editing; Dataset library, overview and settings still load; local-folder append, direct upload and repository import into those Datasets are rejected (`DATASET_MODALITY_UNRESOLVED`); exports/AI follow the legacy defensive checks; the 12 live EMPTY Datasets can be resolved by their owners; the 6 MIXED cannot be. Annotation data (154k video annotations) stays intact but is not editable through the workspace until resolution.

## 6. Blockers and decisions (G-DATA)
| ID | Item | Why it blocks |
| --- | --- | --- |
| B-1 | **No single-modality backfill tool exists** (T029 dry run, T031 assignment protocol) | nothing to authorize or run; must be built and disposable-tested |
| B-2 | **T030**: 523 assets lacking successful content verification (dated audit; the count must be re-measured) and 22 missing subtype rows | cohort C cannot be assigned; cohort A's "verified" definition depends on what content verification means (D-3) |
| B-3 | In-flight work on cohort B Datasets | cohort B waits for `in-flight-work-plan.md` dispositions |
| B-4 | Content verification reads object bytes/identity through the server-side storage client; not authorized in this checkpoint | the dry run cannot be fresh without it |
| B-5 | MIXED has no approved policy | stays unresolved |

Decisions needed: **D-1** approve building T029/T031 (scope: select-only dry run, approved-ID manifest, Serializable assignment, evidence format). **D-2** approve cohort A as the first candidate set (29 Datasets) and cohort B after disposition. **D-3** define "verified" for the first backfill: stored Asset modality + subtype row + storage reference only, or full content/identity verification. **D-4** cohort D policy (recommended: leave unresolved). **D-5** legacy `primaryModality`: leave untouched (recommended) or align. **D-6** resolver-subject format. **D-7** whether the 12 live EMPTY Datasets are resolved by their owners after cutover (default) or by an approved administrator action. **D-8** cohort C remediation owner and approach (T030).
