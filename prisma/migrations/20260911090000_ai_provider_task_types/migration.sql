-- Preserve legacy values and historical task snapshots.
ALTER TYPE "AiTaskType" ADD VALUE IF NOT EXISTS 'DETECTION';
ALTER TYPE "AiTaskType" ADD VALUE IF NOT EXISTS 'TRACKING';
