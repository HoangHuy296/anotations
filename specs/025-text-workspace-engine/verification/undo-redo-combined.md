# T172 — combined Undo/Redo regression

Date: 2026-09-24.

```
$ vitest run tests/workspace/text-workspace.vitest.spec.ts
Test Files  1 passed (1)
Tests  8 passed (8)
```

**New test**: `"T172: a combined session (label, then geometry, then property edits on one span) undoes and redoes each in correct LIFO order with zero cross-kind interference"`. One span, three edits pushed in sequence within a single session (relabel, then resize, then annotate a custom property) — exercising all three `TextUndoEntry` kinds this feature actually has (`label`/`geometry`/`properties`, T095/T081) together, not each in isolation. Asserts:

- Each of the 6 submitted commands (3 undo + 3 redo) patches fields from exactly one kind-group, never a mix — real proof of "no cross-kind interference," not just an assumption.
- Undo order is LIFO on the edit sequence itself (properties → geometry → label); after all three, the span is back to its exact pre-session state (original label, original range, no custom properties).
- Redo order is LIFO on the *undo* sequence (label → geometry → properties, i.e. the most-recently-undone edit redoes first) — standard editor semantics, and the one subtlety this test specifically catches (a naive "redo in original edit order" implementation would get this backwards).
- After all three redos, the span is back to its exact pre-undo state.

**Known gap, explicit per this closure's own instruction (not silently treated as complete)**: **relation and classification edits are not part of this regression** because relation Undo/Redo (T135) and classification Undo/Redo (T115) do not exist yet — see [summary.md](summary.md)'s "Known gaps" section. `TextUndoEntry`'s type is a closed union of exactly `label` | `geometry` | `properties`; there is no relation/classification variant to combine into this test, and adding a fake one would misrepresent untested behavior as tested. When those two are eventually built, this is the test to extend, not replace.

**Result**: PASS for the three edit kinds that exist, with the above scope explicitly documented rather than implied to be broader than it is.
