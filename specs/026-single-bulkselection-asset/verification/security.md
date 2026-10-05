# T095 — security audit (static + test evidence; runtime capture pending)

Date: 2026-09-24. **Status: PARTIAL.** Static inspection and the automated tests below; capturing real logs/responses from a running web/worker stack belongs to T077+ and has not been done.

| Boundary (FR-016/017/029/030) | Evidence | Result |
| --- | --- | --- |
| Browser never chooses file locations or resolved records | `createAiTaskSchema`/`previewAiTargetSchema` use `.strict()` target objects: an extra `url` field is rejected (`ai-batch-task-creation.test.ts`); the client sends only intent (ids/query), never counts or filenames (`ai-batch-selection.vitest.spec.ts`: `filteredCount` never sent) | PASS |
| Forged counts / client target authority | Membership, order, limit and modality are resolved server-side inside the acceptance transaction; `filteredCount` is display-only; a stale/forged `previewFingerprint` → 409 `TARGET_CHANGED` (tested) | PASS |
| Preview leaks nothing | Preview response has no ids, storage keys or locations, and no count for an ineligible target; outsiders get the concealed 404 (tested) | PASS |
| Concealment / revoked access | Stranger → `DATASET_NOT_FOUND` on create, preview and retry, with no rows created (tested); worker dispatch re-checks requester/dataset (`REQUESTER_ACCESS_LOST`, tested) | PASS |
| Queue payload | Strict `{ jobId }` schema rejects `assetIds`, `input`, URL, `target` (tested); target lives only in PostgreSQL (`Job.input`) | PASS |
| Signed URLs / credentials in storage | Dispatch/poll tests assert no `X-Amz`, secret, host or URL in `Job`/`AiTask` rows across success, 4xx/5xx/network failures and provider errors that echo a signed URL; only URL SHA-256 digests and source-identity digests persist | PASS |
| Provider error text | Provider errors are never persisted: submit stores a fixed message + code; poll now stores a fixed message (hardened this pass — the adapter-supplied message was previously written verbatim) + sanitized per-Asset reason (`ai-batch-polling.test.ts`) | PASS |
| Client bundle | Only `types/ai-batch.ts` (type-only imports) reaches client code; every runtime user of `@annotationplatform/domain/ai-batch` is a server file (`ai-target-service`, `ai-task-service`, `ai-retry-service`) — `ai-target-context.ts` (client) imports no domain runtime | PASS (static) |
| Worker logging | The AI processors/provider contain no `console`/`logJobEvent` calls with URLs or provider bodies (grep) | PASS (static) |
| Web read views | `ai-task-read-service.ts` still excludes externalTaskId, provider output and lock fields; no new field was added to it | PASS (static) |

**Open (needs runtime):** captured worker logs and HTTP responses from a real batch run, and HTTP-level revoked-access reads (T077+). Not marked complete until then.

## Runtime addendum (2026-09-24, rebuilt stack — `verification/runtime.md`)

- Adversarial inputs over HTTP: a client-supplied `url` inside `target` → 400; `target` + `assetIds` together → 400; a foreign asset id among valid ones → 409 with no per-id detail; forged counts have no path (the client sends only ids/query); a stale fingerprint → 409 `TARGET_CHANGED`.
- Concealment over HTTP: a non-member gets 404 for preview, create, read projection and retry; unauthenticated preview 401.
- Real provider failure (an unreachable source object; the service echoes the signed URL in its error text): no `X-Amz`/`Signature`/storage host in the Job/AiTask rows or the web/worker container logs; the projection returns sanitized reasons only.
- Redis job data for three operations is exactly `{ "jobId": "…" }`.
- **Still open for T095:** revocation of an existing member's access mid-operation was not exercised end to end, and only a short log window was inspected.
