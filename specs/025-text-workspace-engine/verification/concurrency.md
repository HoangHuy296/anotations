# T168 — aggregate TEXT concurrency suite

Date: 2026-09-24. Real PostgreSQL (the live dev-stack instance), `--test-concurrency=1` (this repo's established convention for DB-heavy suites racing shared infrastructure, per T072's own note).

```
$ node --import tsx --test --test-concurrency=1 \
  tests/text-annotations/text-span-command-races.test.ts \
  tests/text-annotations/text-relation-commands.test.ts \
  tests/text-annotations/text-classification-races.test.ts \
  tests/text-workflow/text-review-workflow.test.ts
1..18
# tests 18
# pass 18
# fail 0
```

**Coverage, one barrier-synchronized real-Postgres-Serializable race per row**:

| File | Races covered |
| --- | --- |
| `text-span-command-races.test.ts` (T072) | simultaneous update/update on the same span (exactly one winner, one `REVISION_STALE`); simultaneous update/delete (exactly one winner, no resurrection); two creates competing for the last admission slot (`LIMIT_EXCEEDED` for the loser, winner's own replay still succeeds at the limit) |
| `text-relation-commands.test.ts` (T120) | concurrent relation-create vs. span-delete on the same endpoint — the relation existing and the span being deleted are proven mutually exclusive |
| `text-classification-races.test.ts` (T107) | two simultaneous SINGLE-group replacements from the same starting membership — exactly one wins, the other `REVISION_STALE`, exactly one row ever persisted; plus a same-operationId replay proof |
| `text-review-workflow.test.ts` (T087) | a review decision at a stale asset revision is refused, the newer state survives |

**Result**: PASS, 18/18. `T069` (this file's own alias for the update/update + update/delete case, per T069's tasks.md note) is included in `text-span-command-races.test.ts`'s coverage above, not a separate file.
