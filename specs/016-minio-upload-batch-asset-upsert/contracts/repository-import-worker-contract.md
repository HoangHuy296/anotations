# Repository Import Worker Contract

## Input

BullMQ delivery is exactly:

```json
{ "jobId": "durable-job-id" }
```

The worker reloads the Job from PostgreSQL. The safe repository input already
stored by Phase 015 may contain provider, owner, repo, resolved ref, normalized
root, visibility, bounded manifest summary, and `sourceConnectionId`; it must
not contain a token, source URL, MinIO credential, raw provider response, or
binary data.

## Processing contract

1. Claim with `jobId` + generated lock token.
2. Re-resolve private source access or derive approved public provider access
   from server configuration.
3. List only files below the normalized root at the immutable ref.
4. Split eligible candidates into policy-sized batches (50–200).
5. Download one source file server-side, mirror it to deterministic private
   MinIO storage, reconcile Asset + one child metadata row, and compensate
   safely on failed publication.
6. Commit aggregate progress and one safe event per batch with the lock token.
7. Complete, fail, or acknowledge cancellation through existing lifecycle
   helpers.

## Output restrictions

- No queue message other than `{ jobId }`.
- No full manifest, token, repository URL, storage key, signed URL, binary, or
  raw provider error in Job summary/Event/API response.
- The existing safe Job-status projection exposes only approved aggregate
  counters/stage/safe summary.
