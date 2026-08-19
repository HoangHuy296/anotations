# Contract: Properties Panel — Assets Pagination & Label Creation

This is a UI/prop contract (component props + the existing REST endpoint it calls), not a new API surface — both pieces reuse endpoints/components that already exist.

## Assets tab pagination

No new endpoint. `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx` already computes `workspace.page.pageSize` and passes it through `PropertiesPanel` → `{Image,Video,Placeholder}PropertiesTabs` → `AssetNavigator` as a prop (`asset-navigator.tsx:14`), which already renders working `Previous`/`Next` buttons (`PageButton`) gated on `page <= 1` / `page * pageSize >= totalAssets`.

**Contract**: the page-size computation changes to a fixed `10` for this tab. No prop signature changes, no new component. `GET /api/datasets/[datasetId]/assets`'s existing paginated response shape (`{ items, page, pageSize, total }` equivalent already consumed here) is unchanged — this is the endpoint FR-042 explicitly says must not change.

**Verification** (see `quickstart.md`): a dataset with 11+ assets shows exactly 10 on page 1, `Next` is enabled and advances to page 2 showing the remainder, `Previous` is disabled on page 1 and enabled thereafter, and the boundary counter text (`"1–10 of 11"` style, already rendered by `AssetNavigator`) reflects the new page size correctly.

## Labels tab creation form

**Existing endpoint reused, unchanged**: `POST /api/datasets/{datasetId}/labels`

```json
// Request body — same schema the panel already sends today, just with a
// user-chosen `color` instead of the hardcoded "#0EA5E9"
{
  "name": "Pedestrian",
  "color": "#22C55E",
  "description": "",
  "hotkey": ""
}
```

```json
// Response — unchanged
HTTP 200 { "data": { "id": "...", "name": "Pedestrian", "color": "#22C55E", ... } }
```

**Contract change is UI-only**: the Labels tab's creation form gains the same three fields `apps/web/src/components/labels/label-form.tsx` already renders on the dedicated `/labels` page — a name input, a visual color palette/swatch picker, and an editable "Color code" hex text field kept in sync with the picker (both bound to one `color` form value, `/^#[0-9A-Fa-f]{6}$/`-validated) — replacing the current name-only input plus hardcoded color. No new validation rule beyond what `label-form.tsx` and the existing `POST` route already enforce.

## "Add defaults" explanation

No endpoint change — `ensureDefaultImageLabelsAction` is called exactly as it is today. **Contract change is UI copy only**: add a short explanatory string next to (or as a tooltip on) the existing "Add defaults" button, e.g. *"Adds this dataset's own default label set. Labels that look the same in another dataset don't count — each dataset keeps its own."* Exact copy is a task-breakdown detail; the requirement (FR-045/SC-013) is that the panel itself explains the action, not that a specific wording is used.
