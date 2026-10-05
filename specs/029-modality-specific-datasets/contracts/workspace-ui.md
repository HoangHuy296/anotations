# Workspace and creation UI contract

Authorize/load Dataset server-side for `/workspace/[datasetId]`. Choose existing registry engine solely from Dataset.modality; pass selected Asset separately and optionally. IMAGE/VIDEO/AUDIO/TEXT each has deterministic empty shell/capabilities. Never choose engine from requested modality query, first/current Asset, extension, or client store. Validate selected Asset datasetId/modality/state; reject mismatches. Preserve flush-before-navigation, revisions and existing modality feature maturity.

Null historical Dataset renders an explicit resolution-needed state at the engine-switch release, never a fallback engine. Before that release, existing authorized legacy reads may remain; new ingestion is blocked under the confirmed policy. MIXED data is not hidden, split or transformed to satisfy a UI filter.

Catalog navigation stays exact workflow COMPLETED → `/datasets/visualize/[datasetId]`; every other status → `/workspace/[datasetId]`. Viewer auth and fresh lifecycle checks remain. Unsupported viewer modalities remain explicit; this does not implement visualization Phase5.

Creation UI: imports left-side modality control with visible labels/icons; local-folder equivalent card. Modality required before acceptance; append shows parent modality fixed. No preview-based auto-selection. Existing compatible class suggestions only; absent definitions show an honest unavailable state and manual entry. Draft badges are non-interactive labels with separate named remove buttons. Combobox has a visible label, input role combobox, synchronized expanded/controls, listbox/option roles, active descendant with focus retained in input, Arrow/Enter/Escape support, and no mount autofocus. Changing draft modality resets incompatible draft confirmation/idempotency state, never persisted content.

Independent CRUD constraint: preserve adjacent-trigger anchored panel, one active panel, viewport collision/scroll handling, keyboard focus, Escape/outside dismissal, return focus, and existing mutation/RBAC behavior. Current checked-in/worktree component still centers a modal; do not mark anchored behavior verified or implement it as a side effect of this planning command.

Keep Phase028 mixed-selection/format validation as defensive legacy/corruption handling. Dataset modality narrows capability presentation, not security validation. AI model capability and label scope remain independently validated; no automatic AUDIO/TEXT AI enablement.
