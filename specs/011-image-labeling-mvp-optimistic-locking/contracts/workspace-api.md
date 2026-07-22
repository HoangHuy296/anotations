# Workspace Interface Contract

## Authorized workspace read

The workspace resolves its actor and Dataset scope before it reads an image,
labels, annotations, description, or image-list result. A non-member receives a
safe not-found/forbidden outcome according to the existing security policy.

The safe workspace projection includes only:

- selected IMAGE Asset identity, filename, dimensions, status, description, and Asset revision;
- safe Dataset labels (`id`, name, color, modality/scope where needed);
- safe bounding-box annotations and their current version;
- result ordering/pagination metadata; and
- a short-lived authorized view capability acquired through the existing Asset
  view boundary.

It excludes bucket/key values, provider and storage credentials, private source
metadata, raw tokens, queue state, binary payloads, and arbitrary error stacks.

## Image list behavior

| Input | Rules | Result |
| --- | --- | --- |
| Dataset id | actor must have Dataset read access | only IMAGE Assets in that Dataset |
| filename filter | case-insensitive substring, applied before paging | matching results across whole Dataset |
| page/batch request | stable `batchIndex`, `orderIndex`, then id order; maximum 100 rows | safe items and page navigation state |
| status filter | existing safe Asset status vocabulary | matching safe status badges |

## Taxonomy behavior

- Readable labels are Dataset-scoped.
- Only existing `label.manage` permission can establish defaults, create a
  custom label, or delete an unreferenced label.
- Any annotation-capable user can choose a readable available label where their
  annotation permission permits the relevant shape mutation.
- Normalized names prevent duplicates. Deleting a referenced label is rejected.
- The labels API and server-action delete boundary both delegate to the same
  Dataset-scoped referenced-label guard.

## Save outcomes

| Outcome | UI-visible meaning | Durable side effect |
| --- | --- | --- |
| success | saved and current version/revision advanced | exactly one guarded mutation |
| validation failure | correct the input | none |
| unauthorized/not found | resource is not available | none |
| conflict | newer durable state exists; user must choose next action | none |
| temporary failure | local draft remains retryable by explicit user action | none until later successful save |
