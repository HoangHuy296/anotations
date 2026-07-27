# Repository Import Progress UI Contract

## Routes

- `/datasets/new` — Create from Repository wizard.
- `/datasets/[datasetId]/imports/[jobId]` — authorized import progress page.

`/datasets/new/local-folder` remains the separate approved local-folder flow.

## Wizard behavior

1. The user enters a safe repository selection and Dataset name. The browser
   never holds a provider token, encryption value, queue data, storage key, or
   owner ID.
2. Preview calls the existing Phase-014 read-only preflight endpoint and shows
   only its safe repository/ref/root/visibility/bounded-preview DTO.
3. Submit creates a fresh idempotency key at the UI action boundary and calls
   `POST /api/datasets/from-repository`.
4. On `201` or idempotent `200`, navigate to returned `progressPath`.
5. On a safe validation/ownership/preflight error, remain on the wizard and
   display the stable user-safe message. No UI retry may invent a different
   idempotency key for the same in-flight submission.

## Progress page behavior

The page reads only the existing authorized safe Job-status projection from
PostgreSQL. It may display:

- Dataset name/identity;
- Job type/status/stage;
- safe progress and counters;
- an explicitly whitelisted nullable summary;
- safe timestamps and a link back to the Dataset.

It must not display raw Job input/state/result/events/errors, SourceConnection
details, repository credentials/private URLs, queue IDs/status, MinIO data, or
provider diagnostics. Direct navigation by a non-member gets the existing
concealed result.

## Accessibility and navigation

Wizard controls and status changes must have accessible labels and keyboard
operation. Loading/submitting state prevents duplicate clicks but does not
replace server-side idempotency. The progress page preserves a clear pending
delivery state when durable acceptance succeeded but queue transport is
temporarily unavailable.
