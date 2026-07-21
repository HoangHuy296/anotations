# Progress UI Contract

## Screen

The authenticated Dataset member opens a Job detail view. It renders only `SafeJobStatus` and `SafeJobEvent` values from [job-api.md](./job-api.md).

## Required states

| UI element | Data source | Behavior |
| --- | --- | --- |
| Progress card | safe status | displays Job type, status, stage, and update time |
| Stage indicator | safe status stage | renders a neutral waiting state when stage is absent |
| Progress bar | safe counters | handles null totals, zero totals, and clamped display percentages without changing durable values |
| Counters | safe status | shows processed, total, successful, failed, and skipped values only when available |
| Event list | safe events | supports empty, loading, error, and next-page states; never renders raw event data |
| Cancel control | safe status + actor capability | enabled only for eligible non-terminal state; disabled after accepted request until refreshed durable state |
| Retry control | safe status + actor capability | enabled only for failed eligible state; returns/navigation follows successor reference |
| Error panel | safe summary | renders only safe message/outcome; omitted when summary is null |

## Refresh behavior

- Fetch status and first event page when the view opens.
- While status is non-terminal and the page is visible, refresh at most once every five seconds.
- Stop automatic refresh on terminal status or hidden page; a user-initiated refresh remains available.
- After cancel or retry response, refresh from the server before changing the displayed durable status.

## Safety boundaries

- The UI derives permissions from safe server responses; it does not send owner ids, lock tokens, worker ids, queue ids, paths, credentials, or raw Job data.
- A missing or unauthorized Job uses the application's not-found/unauthorized experience without leaking whether the identifier exists.
- No import commit, local-folder selection, staging, or import progress UI is included in this phase.
