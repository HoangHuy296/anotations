# Contract: Rate-Limit Rejection

Applies to: `POST /api/ai/tasks`, the import-initiation route(s) (e.g. `POST` on the local-folder-import / repository-import-request endpoints), `POST /api/export` — the "at minimum" set from FR-037.

## Request

No new request field. Rate limiting is evaluated against the authenticated actor (`getRequestActor()`, existing session-based auth) before any other validation that would create durable state — i.e. before a `Job`/`PreparedImport` row is created, but after authentication (`401` still takes priority over `429`).

## Response — limit exceeded

Uses the existing `apiError()` helper and envelope (`apps/web/src/lib/api-response.ts`) unchanged in shape. Adds one new `ApiErrorCode` member: `"RATE_LIMITED"`.

```json
HTTP 429 Too Many Requests
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "You have created too many <ai-task|import|export> requests. Try again in <n> seconds."
  }
}
```

Headers (standard, additive, no existing header removed):

```
Retry-After: <seconds-until-window-reset>
Cache-Control: no-store          (already set by apiError)
X-Content-Type-Options: nosniff  (already set by apiError)
```

## Response — within limit

Unchanged from today: whatever the route already returns on success. No new field is added to a successful response — the rate limiter is purely a gate, not a payload change, satisfying "do not change existing API response contracts unnecessarily."

## Non-goals

- No response field exposes the caller's current count or remaining budget in this phase (kept to "basic operational visibility," not a public quota API). This can be added later as a non-breaking additive header (e.g. `X-RateLimit-Remaining`) without contract change if a future need arises.
- Internal worker-initiated operations never call these routes as an end user, so they are unaffected by definition (FR-039) — no bypass flag or header is introduced.
