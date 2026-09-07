import { logBulkAssetEvent } from "@annotationplatform/domain";
import { AssetStatus } from "@internal/db";

import { apiError, apiSuccess } from "@/lib/api-response";
import { addLabelBulk, assignBulk, changeStatusBulk, deleteAssetsBulk, removeLabelBulk, resolveBulkSelection, WorkflowStatusRequiresTransitionError } from "@/lib/assets/asset-bulk-service";
import { findAssetsWithAnnotationsReferencingLabel, resolveOrCreateLabel } from "@/lib/assets/asset-label-service";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { createAndEnqueueBulkAssetJob } from "@/lib/queue/enqueue-job";
import { assetBulkRequestSchema } from "@/lib/validation/asset-bulk";
import { datasetIdSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string }> };

/**
 * One unified bulk-mutation endpoint (022 §5/§34/§35) covering every Asset
 * Browser bulk action, rather than a separate route per button.
 */
export async function POST(request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const dataset = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!dataset.success) return apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.");
  const datasetId = dataset.data;

  const parsed = assetBulkRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Bulk request is invalid.", parsed.error.flatten().fieldErrors);
  const { action, selection, payload } = parsed.data;

  // Workflow states are intentionally unreachable through the generic bulk
  // organizer. They require the authenticated, revision-guarded workflow API.
  const workflowStatuses: AssetStatus[] = [AssetStatus.IN_PROGRESS, AssetStatus.NEEDS_REVIEW, AssetStatus.REVIEWED, AssetStatus.REJECTED];
  if (action === "CHANGE_STATUS" && workflowStatuses.includes(payload.status)) {
    return apiError(400, "WORKFLOW_STATUS_REQUIRES_TRANSITION", "Workflow statuses must be changed through the asset workflow action.");
  }

  // Never trust ownerId/datasetId/asset ownership from the client (022 §35) --
  // every action, and the selection resolution below, is scoped to this one
  // server-verified `datasetId`.
  const permission = action === "DELETE" ? "asset.delete" : action === "EXPORT_SELECTED" ? "job.createExport" : "dataset.update";
  const access = await requireDatasetPermission(actor, datasetId, permission);
  if (!access) return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
  if (access.forbidden) return apiError(403, "FORBIDDEN", "You do not have permission for this action.");

  const resolved = await resolveBulkSelection(datasetId, selection);
  const selectionMode = selection.mode;
  const startedAt = Date.now();
  const resolvedCountForJob = resolved.ok ? resolved.assetIds.length + resolved.notFoundIds.length : resolved.resolvedCount;

  // Export Selected always runs as a background Job regardless of size
  // (one code path, not a sync path that would need its own duplicate
  // manifest builder -- the manifest builder lives in the worker only,
  // per 022's web/worker app-boundary convention; see
  // apps/worker/src/jobs/export-selected-manifest.ts). Never sends
  // thousands of Asset records to the frontend to construct an export
  // either way (FR-029).
  if (action === "EXPORT_SELECTED") {
    logBulkAssetEvent("bulk_action_started", { userId: actor.id, datasetId, action, selectionMode, resolvedCount: resolvedCountForJob });
    const created = await createAndEnqueueBulkAssetJob(actor, { datasetId, type: "BULK_EXPORT_SELECTED", permission: "job.createExport", selection, resolvedCount: resolvedCountForJob });
    if (!created.ok) return apiError(created.status === 403 ? 403 : 404, created.status === 403 ? "FORBIDDEN" : "GITEA_NOT_FOUND", "The export could not be started.");
    return apiSuccess({ mode: "JOB", jobId: created.job.id }, { status: 202 });
  }

  // DELETE has a background-Job path for a selection exceeding the
  // synchronous cap; the four organize actions do not (research.md §7) --
  // an oversized organize selection is a hard 422.
  if (!resolved.ok) {
    if (action !== "DELETE") {
      return apiError(422, "SELECTION_TOO_LARGE", `Selection matches ${resolved.resolvedCount} assets, exceeding the maximum of ${resolved.max} assets for a synchronous bulk action.`, { resolvedCount: [String(resolved.resolvedCount)], max: [String(resolved.max)] });
    }
    logBulkAssetEvent("bulk_action_started", { userId: actor.id, datasetId, action, selectionMode, resolvedCount: resolved.resolvedCount });
    const created = await createAndEnqueueBulkAssetJob(actor, { datasetId, type: "BULK_DELETE_ASSETS", permission: "asset.delete", selection, resolvedCount: resolved.resolvedCount });
    if (!created.ok) return apiError(created.status === 403 ? 403 : 404, created.status === 403 ? "FORBIDDEN" : "GITEA_NOT_FOUND", "The background delete could not be started.");
    return apiSuccess({ mode: "JOB", jobId: created.job.id }, { status: 202 });
  }

  const { assetIds, notFoundIds } = resolved;
  const resolvedCount = assetIds.length + notFoundIds.length;
  if (action === "CHANGE_STATUS" && assetIds.length) {
    const workflowAssetCount = await db.asset.count({ where: { id: { in: assetIds }, datasetId, status: { in: workflowStatuses } } });
    if (workflowAssetCount) return apiError(400, "WORKFLOW_STATUS_REQUIRES_TRANSITION", "Workflow statuses must be changed through the asset workflow action.");
  }
  logBulkAssetEvent("bulk_action_started", { userId: actor.id, datasetId, action, selectionMode, resolvedCount });

  function finish(result: { processed: number; succeeded: number; failed: number; skipped: number }) {
    const durationMs = Date.now() - startedAt;
    const event = result.failed > 0 ? (result.succeeded > 0 ? "bulk_action_partial_failure" : "bulk_action_failed") : "bulk_action_completed";
    logBulkAssetEvent(event, { userId: actor!.id, datasetId, action, selectionMode, resolvedCount, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped, durationMs });
  }

  if (action === "ADD_LABEL") {
    const label = await resolveOrCreateLabel(datasetId, payload);
    if (!label.ok) { finish({ processed: resolvedCount, succeeded: 0, failed: resolvedCount, skipped: 0 }); return apiError(404, "LABEL_NOT_FOUND", "The label to add was not found."); }
    const result = await addLabelBulk(assetIds, notFoundIds, label.labelId, actor.id);
    finish(result);
    return apiSuccess({ mode: "SYNC", result });
  }

  if (action === "REMOVE_LABEL") {
    if (!payload.confirmedAnnotationWarning) {
      const affected = await findAssetsWithAnnotationsReferencingLabel(assetIds, payload.labelId);
      if (affected.length > 0) {
        return apiError(409, "ANNOTATION_REFERENCE_WARNING", "Some selected assets have annotations using this label; removing it will not affect those annotations.", { affectedAssetCount: [String(affected.length)] });
      }
    }
    const result = await removeLabelBulk(assetIds, notFoundIds, payload.labelId);
    finish(result);
    return apiSuccess({ mode: "SYNC", result });
  }

  if (action === "CHANGE_STATUS") {
    let result;
    try { result = await changeStatusBulk(datasetId, assetIds, notFoundIds, payload.status); }
    catch (error) {
      if (error instanceof WorkflowStatusRequiresTransitionError) return apiError(400, "WORKFLOW_STATUS_REQUIRES_TRANSITION", "Workflow statuses must be changed through the asset workflow action.");
      throw error;
    }
    finish(result);
    return apiSuccess({ mode: "SYNC", result });
  }

  if (action === "ASSIGN") {
    const outcome = await assignBulk(datasetId, assetIds, notFoundIds, payload.assignedToId);
    if (!outcome.ok) { finish({ processed: resolvedCount, succeeded: 0, failed: resolvedCount, skipped: 0 }); return apiError(400, "INVALID_ASSIGNEE", "The assignee must be a current member of this dataset."); }
    finish(outcome.result);
    return apiSuccess({ mode: "SYNC", result: outcome.result });
  }

  if (action === "DELETE") {
    const result = await deleteAssetsBulk(datasetId, assetIds, notFoundIds);
    finish(result);
    return apiSuccess({ mode: "SYNC", result });
  }

  // Unreachable: every `AssetBulkRequest["action"]` value is handled above
  // (EXPORT_SELECTED returns earlier, before selection resolution). Kept
  // only so this function is provably total.
  return apiError(400, "INVALID_REQUEST", "Unsupported bulk action.");
}
