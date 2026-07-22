# Local Folder Import Contract

All requests resolve the active actor and durable ownership server-side. Non-members receive safe not-found results and no side effects.

## Preparation

`POST /api/imports/local-folder` accepts validated safe manifest metadata only and returns safe preparation, Dataset, Job references, and bounded upload instructions. It never accepts absolute paths, browser handles, binary, owner IDs, or credentials.

## Upload completion

`POST /api/imports/[preparedImportId]/upload-capabilities` issues short-lived object-scoped capabilities for authorized expected items.

`POST /api/imports/[preparedImportId]/items/[itemId]/complete` verifies and reconciles one object, Asset, and modality row. Repetition returns the existing durable item outcome.

## Commit

`POST /api/jobs/[jobId]/commit-import` requires authorization, `IMPORT_DATASET`, and RUNNING/RETRYING. It validates the bound preparation and expected/completed counts.

| Condition | Result |
| --- | --- |
| count matches | idempotent completed outcome |
| count mismatch | `409 IMPORT_INCOMPLETE`; non-terminal Job |
| expired/invalid | safe conflict/not-found |
| non-member | safe not-found |

Responses expose only safe identifiers, counts, modality, expiry, safe Job state, and one-upload signed form fields when necessary. They never expose raw manifest data, paths, keys/private URLs, credentials, lock/queue fields, or binary.

## Redaction audit

The application response body never contains `storageKey`, `objectKey`, a
bucket name, raw MinIO URL, credentials, Job input/state/result, queue fields,
or a browser local absolute path. For the permitted presigned POST exception,
the browser receives only the provider-required transient form fields and an
opaque `fileId`; it must not persist or log either value.

## Security audit record

All four import routes resolve an authenticated actor before parsing/acting and
use server-side preparation or Dataset permission checks. Non-members are
concealed. `objectKey`, bucket, queue metadata, lock fields, and raw manifest
rows are not application response fields. Relative logical names are accepted
only in the bounded start manifest and reject absolute/traversal forms.
