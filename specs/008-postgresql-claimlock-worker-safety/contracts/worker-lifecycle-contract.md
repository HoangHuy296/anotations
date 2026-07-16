# Worker Lifecycle Integration Contract

## Delivery order

```text
BullMQ delivery { jobId }
  → strict payload validation
  → PostgreSQL Job lookup / existing Phase 007 skip guards
  → claimJob(jobId, privateWorkerId)
      → no claim: stop without business work
      → claimed: durable ownership is established; stop in Phase 008
```

No worker token, Job input, result, provider data, or business command is added to the queue delivery.

## Safety rules

1. The worker creates one process-private identity at startup; it is not configurable from browser input.
2. Duplicate delivery while a lease is valid must result in no second claim and no business invocation.
3. A worker must not begin a future business handler until it has a successful durable claim.
4. Phase 008 stops after proving claim/lease/lifecycle safety. It does not add processor dispatch, retry scheduling, artifact production, or HTTP handling.
5. Shutdown does not release or rewrite a Job lock opportunistically. Lease expiry and later approved recovery policy determine subsequent eligibility.

## Phase 008 observability audit

Only the allowlisted event names `JOB_CLAIMED`, `JOB_HEARTBEAT`,
`JOB_PROGRESS`, `JOB_COMPLETED`, `JOB_FAILED`, and `JOB_CANCELED` are added.
Their event data is empty. Queue events retain only the pre-existing queue
name/job-id fields. Lock tokens, worker identities, raw Job payload/state/result,
queue internals, credentials, repository/provider data, and private storage
references are not persisted in JobEvents or returned by the router.
