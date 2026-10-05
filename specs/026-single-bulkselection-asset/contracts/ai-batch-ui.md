# AI Detection UI Contract (provisional)

Use the existing ai-detect-dialog.tsx and model/class/confidence/IoU controls. A bulk action opens that same panel; no separate configuration surface.

| Selection state | Target behavior |
| --- | --- |
| NONE | Current Asset, count one |
| EXPLICIT in this Dataset | Every distinct selected ID across pages and hidden filters |
| FILTERED in this Dataset | Server resolves current Phase 022 query across all pages |
| Active invalid/empty selection | Disabled execution with reason; never current-Asset fallback |
| Active selection from another Dataset | Reject stale context/reset explicitly before presenting a new target; never submit it |

On open, selection/filter change, model change or Dataset change, invalidate preview and disable Run until the latest authorized response arrives. Ignore canceled/out-of-order preview/model/class responses by request identity. Show verified mode/count/modality, configured effective limit when relevant and a useful safe invalidity reason. Discover models for the resolved bulk modality, which can differ from the open Asset. Classes reset/validate according to existing model-change behavior; thresholds remain shared.

Run label states the verified count, e.g. “Run AI on 7 assets”. Submit the exact current target and preview fingerprint. TARGET_CHANGED refreshes preview and requires another deliberate click; never auto-submit a changed target. One selected Asset in bulk mode is valid. Do not let user sorting/pagination redefine selection.

While accepted work runs, show durable operation reference, progress and links to authorized existing operation views. Closing/reopening or refreshing must recover from server state, not only component memory. If multiple operations exist, display/select their durable identities rather than silently attaching an arbitrary latest task.

Show all per-Asset outcomes and reconciled aggregate counts on completion, failure or cancellation, including successful zero-detection rows and retry lineage. A failed batch can still expose successful predictions. Refresh the currently viewed Asset from canonical reads if affected, even when another target fails; never merge other Assets' geometry into its store. Preserve single-Asset callback behavior without applying an entire batch to the current canvas.

Use existing dialog/drawer typography, loading/error primitives and keyboard/focus behavior. Disabled controls explain invalidity in visible text. Run can be disabled for a batch without removing existing successful output views. Bulk target intent must not inherit an unrelated open Asset's workflow eligibility; server eligibility governs every selected Asset.


## Implemented status (2026-09-24)

Implemented in the existing `ai-detect-dialog.tsx` (no second panel) with an "AI Detect" action in `bulk-action-bar.tsx` (image/video editable assets). Logic is unit-tested; **rendering is not browser-verified** (no browser automation in this repo). Per-Asset outcome display, operation reopening after refresh and retry/cancel result views (T039, T049) are not built.
