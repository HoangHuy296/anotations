-- specs/027-coco-dataset-export §10, Phase ENFORCE verification.
-- Run these AFTER step-b-trigger.sql, still inside the quiescence window,
-- BEFORE resuming writers. All read-only. If any check fails, do not
-- resume writers -- investigate before proceeding.

-- 1. The trigger and its function both exist and are enabled.
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'asset_relative_path_guard_trigger' AND tgrelid = '"Asset"'::regclass;
-- Expect exactly one row, tgenabled = 'O' (origin, i.e. enabled).

SELECT proname FROM pg_proc WHERE proname = 'asset_relative_path_guard';
-- Expect exactly one row.

-- 2. Zero live rows remain with relativePath NULL (or an explicitly
--    acknowledged, named residual from an earlier dry-run report -- never
--    an unexamined assumption of zero).
SELECT count(*) FROM "Asset" WHERE "deletedAt" IS NULL AND "relativePath" IS NULL;
-- Expect 0 (or the exact acknowledged residual count/list from the last
-- dry-run's "unnormalizable" report).

-- 3. The known 30/66 historical collision groups are still exactly what
--    they were at last audit -- confirms nothing was mutated during this
--    cutover, only the new column/trigger were added.
WITH live AS (
  SELECT id, "datasetId", "relativePath" FROM "Asset" WHERE "deletedAt" IS NULL AND "relativePath" IS NOT NULL
)
SELECT count(*) AS collision_groups, sum(cnt) AS colliding_assets FROM (
  SELECT count(*) cnt FROM live GROUP BY "datasetId", "relativePath" HAVING count(*) > 1
) t;
-- Expect collision_groups/colliding_assets to match (or exceed only by
-- legitimate new concurrent-writer activity during the quiescence window,
-- which should be none, since writers were paused) the last dry-run's
-- reported figures. A DECREASE would mean something was deleted/renamed --
-- investigate immediately, §5 forbids that.

-- 4. Functional proof the trigger actually rejects a real conflict: run
--    scripts/027-verify-trigger.ts (Node, not SQL -- needs a real datasetId
--    this file cannot know at review time). It creates a throwaway Dataset
--    and two conflicting Asset rows INSIDE a transaction, asserts the
--    second insert is rejected with the exact §6/§11c marker shape, then
--    ROLLBACKs -- nothing it creates is ever committed or visible to any
--    other session.
