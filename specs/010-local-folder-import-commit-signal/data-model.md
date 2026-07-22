# Data Model: Local Folder Import and Commit Signal

## PreparedImport

One expiring durable preparation links a requester, newly created Dataset, one `IMPORT_DATASET` Job, immutable expected count/safe manifest, idempotency context, deadline, and commit state. It has no binary, absolute path, browser handle, credential, or private URL.

## PreparedImportItem

One expected logical file item holds safe relative name, MIME/size, inferred modality, deterministic fingerprint, completion state, and optional Asset relation. A unique item identity allows acknowledgement/retry reconciliation without duplicate Assets.

## Existing entities

- **Job** remains the canonical lifecycle/progress/timeout/event authority.
- **Dataset** is created before transfer and can have null `primaryModality`.
- **Asset** is created/reconciled once per verified completed item; `Asset.modality` is authoritative and selects its child metadata row.

## State transitions

| From | Action | To |
| --- | --- | --- |
| QUEUED | private worker claim | RUNNING |
| RUNNING/RETRYING | authorized commit and complete count | COMPLETED |
| RUNNING/RETRYING | commit count mismatch | unchanged; `IMPORT_INCOMPLETE` |
| RUNNING/RETRYING | deadline without commit | FAILED / `IMPORT_COMMIT_TIMEOUT` |
| RUNNING | valid cancellation acknowledgement | CANCELED |

## Invariants

- Preparation, Job, Dataset, item, and Asset remain in one Dataset scope.
- An item has at most one published Asset.
- Cleanup deletes an object only if no durable Asset references it.
- Totals derive from durable expected/completed items, never queue or browser counters.
