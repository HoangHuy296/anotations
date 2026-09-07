# Contract: Asset Annotation Workflow

Workflow APIs are dataset-scoped Next.js Route Handlers. The server derives actor, Asset, dataset scope, current state, and permissions; clients never submit a target status or history row.

## Read state and history

`GET /api/datasets/{datasetId}/assets/{assetId}/workflow`

Success (`200`):

```json
{
  "asset": { "id": "cuid", "status": "NEEDS_REVIEW", "revision": 18 },
  "history": [{ "id": "cuid", "action": "SUBMIT", "fromStatus": "IN_PROGRESS", "toStatus": "NEEDS_REVIEW", "assetRevision": 18, "feedback": null, "createdAt": "2026-09-03T06:00:00.000Z" }]
}
```

## Apply an action

`POST /api/datasets/{datasetId}/assets/{assetId}/workflow`

```json
{ "action": "APPROVE", "expectedRevision": 18 }
```

Actions: `START`, `SUBMIT`, `OPEN_REVIEW`, `APPROVE`, `REJECT`, `START_REWORK`, `RESUBMIT`. `expectedRevision` is a positive integer. `REJECT` requires a trimmed, non-empty bounded `feedback`; feedback is rejected for other actions.

Success (`200`) returns the current safe Asset `{ id, status, revision }` and created event. A state transition increments Asset revision once; `OPEN_REVIEW` records an inspection event without a state/revision change.

### Stale decision (`409 CONFLICT`)

When the Asset or any annotation changed since the reviewer loaded it:

```json
{
  "error": {
    "code": "STALE_REVISION",
    "message": "This asset changed after you loaded it. Reload before making a review decision.",
    "currentRevision": 19
  }
}
```

No Asset status, Annotation, or history event changes. The client must reload and require an explicit new decision; it must never transparently retry an old approval/rejection.

### Other outcomes

| Status | Code / condition |
| --- | --- |
| `400` | malformed action/revision or missing rejection feedback |
| `401` | unauthenticated |
| `403` | lacking required workflow permission |
| `404` | Asset unavailable outside authorized dataset scope |
| `409` | `INVALID_TRANSITION` when revision matches but source state disallows action |

## Phase 022 bulk compatibility

The existing bulk Assets endpoint retains its shape but returns a validation error (documented as `WORKFLOW_STATUS_REQUIRES_TRANSITION`) if generic `CHANGE_STATUS` would target or clear `IN_PROGRESS`, `NEEDS_REVIEW`, `REVIEWED`, or `REJECTED`.

## Required tests

1. Reviewer reads revision N; another actor changes an annotation to N+1; `APPROVE` and `REJECT` at N return `409` / `STALE_REVISION` with no event or state change.
2. Two simultaneous decisions at N produce one event and one `STALE_REVISION` loser.
3. Correct revision but wrong source status returns `INVALID_TRANSITION`.
4. Empty rejection feedback, unauthorized/cross-dataset requests, and invalid inputs perform no writes.
