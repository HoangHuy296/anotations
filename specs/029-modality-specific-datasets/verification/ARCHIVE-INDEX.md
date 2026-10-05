# Phase 029 verification evidence — archive index

Raw run evidence is **not stored in Git**. It stays at its original paths on the author's machine and is preserved in content-addressed local archives. This file identifies them. No original has been deleted, moved, renamed, rewritten or compacted; deleting any original needs explicit approval at G5 closure and the later release/provenance review.

## Archives (local, git-ignored under `.data/cleanup-archives/`)

| Archive | SHA-256 | Files | Source bytes | Archive bytes |
| --- | --- | ---: | ---: | ---: |
| `20261001T032449Z/phase029-verification.tar.gz` | `a8e0c5e89743e3f66beb85c38ab0e122097114fe845c354ba2339181d30ac838` | 867 | — | 7,807,169 |
| `phase029-evidence-3383a39b001f5651/phase029-evidence-3383a39b001f5651.tar.gz` | `3383a39b001f56518228514c204c697a7e32b0920ee0b3a1395a3d589bc8d2bb` | 2,151 | 1,017,237,576 | 129,666,031 |

Created 2026-10-05T05:11:44Z. Each archive has an adjacent `manifest.json` (per file: path, bytes, SHA-256, mode, mtime) and `summary.json`. Archive member path equals the original repository-relative path (identity mapping), so `tar -xzf` into the repository root restores files to their original locations.

The second archive holds every file under `specs/029-modality-specific-datasets/verification/` that the first archive did not contain, plus the 15 top-level incident, recovery, rehearsal and preflight reports (re-included explicitly). It excludes `mvp-modality-card-status-20261005.md`, which is committed.

## Verification performed

Archive SHA-256, byte count and filename prefix match its summary. All 2,151 members re-read and matched the manifest (hash and size); none missing or extra. All 2,151 originals re-hashed after archiving and are unchanged (size, mtime, SHA-256). The first archive's checksum is unchanged.

## Secret classification

Everything in the second archive, including the contents of its 43 `.gz` files, was scanned for credential patterns. No value matched any live `.env`/`.env.local` credential. Matches are harness-source fixture literals and expressions in `.diff` files, per-run UUID tokens, an unrelated hostname-like word in a negative-test URL, and references to expired disposable receipts. Nothing was redacted or altered.

## Evidence status that must stay explicit

- G5 is **OPEN / UNVERIFIED**. Runs `20261005T034620Z` and `20261005T042640Z` failed and are not closure evidence. In the latter, the browser-isolation probe for `http://localhost:9000/` was never intercepted (probe 1); that is an unresolved browser-safety issue.
- Run `20261005T034620Z` has no `cleanup-independent.json`; later exact-ID checks are supplementary only.
- Candidate migration SHA-256 moved from `abf72fd2…` to `13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7` without a contemporaneous approval or diff record; see `mvp-modality-card-status-20261005.md`.
- G3 performance was not accepted (see the archived G3-retry handoff).
- Failed and superseded runs are preserved as evidence and were not reconciled.
