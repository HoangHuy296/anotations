import "server-only";

import { Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";

/**
 * Dataset Overview aggregate (022 User Story 5).
 *
 * Every field here is drawn from exactly one existing state axis, never a
 * blend of two. This phase's spec (FR-017/SC-009) already requires Asset
 * status, Annotation status, Job status, and AI task status to stay
 * distinct; this service extends the same discipline to `progress` and
 * `health` so a future phase never has to *refactor* a conflated number --
 * it only ever has to *add* a new, clearly-scoped one:
 *
 *   - `progress` here is Asset-lifecycle progress (Asset.status !== NEW),
 *     the exact definition the workspace tabs already show. It is NOT
 *     annotation-completion percentage and NOT review-workflow progress --
 *     neither of those has a canonical definition yet. When a real
 *     Annotation-completion metric or a real Review workflow exists (the
 *     latter is explicitly out of scope until Phase 027 Quality Control /
 *     an eventual Review-state model), it belongs in its own field, e.g.
 *     `annotationProgress` / `reviewProgress` -- never folded into this one.
 *   - `health` here is data-integrity/operational health only (FR-034) --
 *     storage references, sync conflicts, failed background Jobs, stuck
 *     imports. It never becomes an annotation-quality, reviewer-agreement,
 *     or AI-accuracy signal (those belong to a future Quality Control /
 *     Analytics phase's own aggregate, not this one).
 *   - Today, "review" has no independent state machine -- FR-003/FR-017's
 *     Assumptions already establish that review-shaped values
 *     (NEEDS_REVIEW/REVIEWED/REJECTED) live *inside* `AssetStatus`. This
 *     service does not attempt to carve a separate "review count" out of
 *     that enum here, specifically so a real Review state machine (027)
 *     can be introduced later as an addition, not a migration off a
 *     number this page already promised meant something else.
 *
 * Future phases (024 Collaboration/assignment, 027 Quality Control/review,
 * 028 Analytics, 029 Notification) should each read from their own future
 * state source and expose their own field on their own surface -- never
 * repurpose a field defined here.
 */
export type DatasetOverview = {
  dataset: { id: string; name: string; description: string | null; primaryModality: Modality | null; sourceMode: string; createdAt: string; updatedAt: string };
  assetCounts: { total: number; byModality: Record<Modality, number> };
  annotationCount: number;
  /** Asset-lifecycle progress only -- see the module doc comment. */
  progress: { completedAssets: number; totalAssets: number };
  health: {
    missingStorageReferences: number;
    syncConflicts: number;
    failedJobs: number;
    incompleteImports: number;
  };
};

export type DatasetOverviewResult = { ok: false; status: 403 | 404 } | { ok: true; overview: DatasetOverview };

const HEALTH_JOB_LOOKBACK_DAYS = 30;

export async function readDatasetOverview(actor: RequestActor, datasetId: string): Promise<DatasetOverviewResult> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };

  const dataset = await db.dataset.findFirst({
    where: { id: datasetId, deletedAt: null, archivedAt: null },
    select: { id: true, name: true, description: true, primaryModality: true, sourceMode: true, createdAt: true, updatedAt: true },
  });
  if (!dataset) return { ok: false, status: 404 };

  const jobLookbackFrom = new Date(Date.now() - HEALTH_JOB_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [total, byModalityRows, annotationCount, completedAssets, missingStorageReferences, syncConflicts, failedJobs, incompleteImports] = await Promise.all([
    db.asset.count({ where: { datasetId, deletedAt: null, archivedAt: null } }),
    db.asset.groupBy({ by: ["modality"], where: { datasetId, deletedAt: null, archivedAt: null }, _count: { _all: true } }),
    db.annotation.count({ where: { datasetId } }),
    // Identical definition to `readWorkspacePage`'s `completed` -- one
    // Asset-lifecycle progress number, not re-derived differently here.
    db.asset.count({ where: { datasetId, deletedAt: null, archivedAt: null, status: { not: "NEW" } } }),
    db.asset.count({ where: { datasetId, deletedAt: null, archivedAt: null, storageKey: null, status: { notIn: ["NEW", "PROCESSING"] } } }),
    db.asset.count({ where: { datasetId, deletedAt: null, archivedAt: null, syncStatus: { in: ["CONFLICT", "UNKNOWN"] } } }),
    db.job.count({ where: { datasetId, status: "FAILED", createdAt: { gte: jobLookbackFrom } } }),
    db.preparedImport.count({ where: { datasetId, status: "PREPARING", deadlineAt: { lt: new Date() } } }),
  ]);

  const byModality: Record<Modality, number> = { IMAGE: 0, VIDEO: 0, TEXT: 0, AUDIO: 0 };
  for (const row of byModalityRows) byModality[row.modality] = row._count._all;

  return {
    ok: true,
    overview: {
      dataset: {
        id: dataset.id, name: dataset.name, description: dataset.description, primaryModality: dataset.primaryModality,
        sourceMode: dataset.sourceMode, createdAt: dataset.createdAt.toISOString(), updatedAt: dataset.updatedAt.toISOString(),
      },
      assetCounts: { total, byModality },
      annotationCount,
      progress: { completedAssets, totalAssets: total },
      health: { missingStorageReferences, syncConflicts, failedJobs, incompleteImports },
    },
  };
}
