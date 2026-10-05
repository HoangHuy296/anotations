# Rollout and historical-data contract

1. Review additive nullable schema and normal generated-client command separately. No default or existing migration rewrite.
2. Deploy coordinated creation + publication guards; drain old writers and queued/prepared unresolved work safely. Keep IDs/revisions/workflow. Null historical targets reject new ingestion.
3. Re-audit PostgreSQL plus source classification; separately list EMPTY, single-modality candidates, MIXED, missing subtype/content. Include archived/deleted rows. Recorded 116/609 audit is historical evidence, not production truth.
4. Use reviewed approved-ID dry run; all mutation paths and backfill share tested transaction/fencing protocol. Phase027 Redis guard and visualization locks alone are insufficient. Verify source identity again before assignment; database repeatable reads do not freeze object bytes.
5. Assign only genuinely unambiguous verified historical data with approved policy; owner/admin explicitly resolves still-empty datasets. MIXED remains null/blocked until separate resolution approval. Never split/move/delete/rewrite automatically.
6. Switch workspace engine from Dataset; null gets explicit resolution UI. Keep legacy defensive export/AI checks.
7. Validate final cross-table equality and independent fixedness, including empty datasets; only then required field. Custom trigger SQL needs separate Phase029 approval and new reviewed migration. Parent modality must never cascade to Asset modality.

Rollback retains assigned values/additive column and stops incompatible old writers; it does not reset modality or restore old inference. No automated reversal of historical content. Preserve immutable snapshots and existing snapshot identities; a capture-contract change is separately versioned.

Release gates: concurrency tests pass across replays/reparent/restore; classifier support limitations visible; missing historical media/subtypes resolved before affected backfill; no null/mismatch before NOT NULL; audited event for EMPTY resolution; no new dependencies/configuration without separate review. The plan does not claim all historical resolution or all synchronous media-format parity is already deliverable.
