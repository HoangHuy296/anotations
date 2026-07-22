# Local Folder Import UI Contract

The new-folder UI shows selection, preflight results, per-item upload progress, durable Job progress, commit state, timeout/failure state, and authorized retry/cancel controls.

- Never render or send an absolute local path.
- Browser selection/transfer is client-side; status/events use Phase 009 safe durable APIs.
- Commit may be offered only after visible completion, but the backend remains authoritative.
- Partial, timeout, cancellation, and failure states show safe counts/summaries only.
