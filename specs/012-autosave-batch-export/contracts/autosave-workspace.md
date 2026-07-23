# Autosave and Workspace Navigation Contract

## Boundary

The existing authorized workspace Server Actions remain the only durable write boundary for annotations and image descriptions. Browser state contains drafts and save states only; it does not own revisions, permission decisions, or canonical geometry.

## Mutation requests

Each request carries only the resource identity already within the loaded authorized Dataset, the expected revision, and the field(s) allowed by that mutation.

| Mutation | Required browser values | Server guarantee |
| --- | --- | --- |
| Create bounding box | Dataset/Asset reference, active authorized label, bounded geometry | Server derives actor/Dataset/modality/type and returns current annotation revision. |
| Geometry update | Annotation/Asset/Dataset reference, expected annotation revision, bounded canonical geometry | Only geometry and editor metadata change; revision increments exactly once on success. |
| Label reassignment | Annotation/Asset/Dataset reference, expected annotation revision, authorized label | Only label/editor metadata change; geometry is unchanged; revision increments on success. |
| Delete | Annotation/Asset/Dataset reference, expected annotation revision | Deletes only the authorized current annotation; stale target has no mutation. |
| Description update | Dataset/Asset reference, expected Asset revision, description | Only Asset description/revision changes; revision increments exactly once on success. |

All mutations resolve the current session actor and Dataset permission server-side. A non-member receives a safe concealed result; a known member without the action permission receives the existing safe forbidden result. No mutation result includes private storage/provider data.

## Save response

```ts
type SaveOutcome<T> =
  | { ok: true; value: T }                 // Includes the current returned revision
  | { ok: false; status: 401 | 403 | 404 | 409; reason: "AUTH" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "FAILED" }
```

The client maps a `409/CONFLICT` to `conflict`, retains its draft, and does not automatically retry an overwrite. Other failed outcomes retain the draft and map to `failed` unless the user explicitly discards it.

## Debounce and flush rules

1. An eligible semantic edit schedules its resource's save at exactly 1.5 seconds after the latest eligible edit.
2. A later edit to that resource replaces the earlier timer; different resources remain independently tracked.
3. `flush(resource)` cancels that resource's timer and awaits one save for its newest draft.
4. Navigation, search/filter selection changes, batch changes, previous/next, and leaving the workspace call the relevant flush before changing selection.
5. A save that resolves `failed` or `conflict` blocks automatic destructive navigation; the user must resolve/retry/discard explicitly.
6. Pan, zoom, pointer move, and transform preview do not schedule writes. The action-end handler schedules the save.

## Authorized Asset list contract

Conceptual query values:

```ts
type WorkspaceListQuery = {
  page?: number;                // one-based, defaults to 1
  q?: string;                   // trimmed, case-insensitive filename substring
  statuses?: AssetStatus[];     // zero or more allowed status filters
  image?: string;               // current selected asset id, optional
};
```

The server and URL contract accept zero or more allowed `statuses` values. The
right-sidebar UI deliberately exposes one status selector plus `All statuses`;
it does not compose a new multi-status filter. Existing repeated-status URLs
remain supported and are preserved unless the user explicitly applies a new
single-status or all-status selection. An absent `statuses` value means all
statuses; an empty or invalid filter is rejected or normalized according to the
server validation contract, never broadened silently. Response contains only
safe Asset display fields, the active query context, total matching count,
page/pageSize, and safe Dataset progress. Results are ordered consistently by
`batchIndex`, `orderIndex`, and id; page size is 100. The selected Asset is
reconciled against this same result set.

## Required verification

- Debounce begins at 1.5 seconds and only once per resource/draft.
- Reload after success returns the durable annotation geometry/description and advanced revision.
- Two-session stale save returns conflict and leaves durable state unchanged.
- Pending save flushes before navigation; failed/conflict save retains local draft and blocks automatic discard.
- Search/filter spans 250 Assets, batches never exceed 100, and previous/next follows the active filtered order.
- Authorization denial leaves annotations, Asset metadata, Jobs, queue, and storage unchanged.
