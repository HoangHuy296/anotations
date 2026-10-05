import "server-only";

import { createHash } from "node:crypto";

import { Modality, type Prisma } from "@internal/db";
import {
  AiSourceIdentityUnavailableError,
  computeAiSourceIdentityDigest,
  effectiveAiBatchLimit,
  selectAiSourceObject,
  type AiBatchTarget,
  type AiTargetMode,
} from "@annotationplatform/domain/ai-batch";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { previewAiTargetSchema } from "@/lib/validation/ai-task";
import { resolveBulkSelectionStrict, type BulkSelectionInput } from "@/lib/assets/asset-bulk-service";
import { BULK_SYNC_MAX_ASSETS } from "@/types/workspace";

/**
 * The one server-side path from an AI Detection target to an ordered,
 * authoritative Asset list (feature 026). Current-Asset, legacy `assetIds`
 * and Phase 022 explicit/filtered selections all converge here; nothing
 * after this point branches on how the target was expressed.
 *
 * Authorization (annotation.create on the dataset) is checked by the caller
 * before resolution so an actor certain to be refused never triggers a query.
 */
export type AiTargetInput =
  | { mode: "CURRENT_ASSET"; assetId: string }
  | { mode: "BULK_SELECTION"; selection: BulkSelectionInput }
  | { mode: "LEGACY_ASSET_IDS"; assetIds: string[] };

export type AiTargetFailureCode = "TARGET_EMPTY" | "TARGET_TOO_LARGE" | "ASSET_NOT_IN_DATASET" | "TARGET_MIXED_MODALITY" | "TARGET_INELIGIBLE" | "AI_CAPABILITY_UNVERIFIED";

export type ResolvedAiTarget =
  | { ok: true; targetMode: AiTargetMode; modality: "IMAGE" | "VIDEO"; targets: AiBatchTarget[]; effectiveLimit: number }
  | { ok: false; code: AiTargetFailureCode; status: 400 | 409 | 422; effectiveLimit: number };

const failureStatus: Record<AiTargetFailureCode, 400 | 409 | 422> = {
  TARGET_EMPTY: 400,
  TARGET_TOO_LARGE: 422,
  ASSET_NOT_IN_DATASET: 409,
  TARGET_MIXED_MODALITY: 422,
  TARGET_INELIGIBLE: 422,
  AI_CAPABILITY_UNVERIFIED: 409,
};

const assetSelect = {
  id: true, modality: true, sourceFingerprint: true, currentVersionId: true, sourceRevision: true, sizeBytes: true, checksum: true, cacheChecksum: true,
  storageProvider: true, storageBucket: true, storageKey: true, cacheProvider: true, cacheBucket: true, cacheKey: true, cacheStatus: true, cacheExpiresAt: true,
} as const;

function toSelection(target: AiTargetInput): { selection: BulkSelectionInput; targetMode: AiTargetMode } {
  if (target.mode === "CURRENT_ASSET") return { selection: { mode: "EXPLICIT", assetIds: [target.assetId] }, targetMode: "CURRENT_ASSET" };
  if (target.mode === "LEGACY_ASSET_IDS") return { selection: { mode: "EXPLICIT", assetIds: target.assetIds }, targetMode: "LEGACY_ASSET_IDS" };
  return { selection: target.selection, targetMode: target.selection.mode };
}

export async function resolveAiTarget(
  datasetId: string,
  target: AiTargetInput,
  client: Pick<Prisma.TransactionClient, "asset"> = db,
): Promise<ResolvedAiTarget> {
  const effectiveLimit = effectiveAiBatchLimit(BULK_SYNC_MAX_ASSETS);
  const fail = (code: AiTargetFailureCode): ResolvedAiTarget => ({ ok: false, code, status: failureStatus[code], effectiveLimit });
  const { selection, targetMode } = toSelection(target);

  const resolved = await resolveBulkSelectionStrict(datasetId, selection, effectiveLimit, client);
  if (!resolved.ok) return fail(resolved.reason === "EMPTY" ? "TARGET_EMPTY" : resolved.reason === "TOO_LARGE" ? "TARGET_TOO_LARGE" : "ASSET_NOT_IN_DATASET");

  const rows = await client.asset.findMany({ where: { id: { in: resolved.assetIds }, datasetId, deletedAt: null, archivedAt: null }, select: assetSelect, orderBy: { id: "asc" } });
  // A concurrent delete/archive between the two reads must reject, not shrink, the target.
  if (rows.length !== resolved.assetIds.length) return fail("ASSET_NOT_IN_DATASET");

  const modalities = new Set(rows.map((row) => row.modality));
  if (modalities.size > 1) return fail("TARGET_MIXED_MODALITY");
  const modality = rows[0].modality;
  if (modality !== Modality.IMAGE && modality !== Modality.VIDEO) return fail("AI_CAPABILITY_UNVERIFIED");
  // v1 (decision D-V1): batches are IMAGE detection only. A single VIDEO Asset keeps
  // its existing behavior through this same path; a VIDEO batch is not evidenced.
  if (modality === Modality.VIDEO && rows.length > 1) return fail("AI_CAPABILITY_UNVERIFIED");

  const targets: AiBatchTarget[] = [];
  for (const [inputIndex, row] of rows.entries()) {
    try {
      targets.push({
        assetId: row.id,
        inputIndex,
        sourceIdentityDigest: computeAiSourceIdentityDigest({
          sourceFingerprint: row.sourceFingerprint,
          currentVersionId: row.currentVersionId,
          sourceRevision: row.sourceRevision,
          sizeBytes: row.sizeBytes,
          checksum: row.checksum,
          cacheChecksum: row.cacheChecksum,
          objectLocator: selectAiSourceObject(row),
        }),
      });
    } catch (error) {
      if (error instanceof AiSourceIdentityUnavailableError) return fail("TARGET_INELIGIBLE");
      throw error;
    }
  }
  return { ok: true, targetMode, modality, targets, effectiveLimit };
}

/**
 * Advisory freshness token over the resolved target and its context. Equality
 * proves only that the browser's preview still matches what the server would
 * accept now; it is never authorization and is recomputed on every acceptance.
 */
export function computeAiPreviewFingerprint(context: { datasetId: string; actorId: string; modelId?: string | null }, resolved: Extract<ResolvedAiTarget, { ok: true }>): string {
  return createHash("sha256").update(JSON.stringify({
    v: 1, d: context.datasetId, a: context.actorId, m: context.modelId ?? null, mode: resolved.targetMode, mod: resolved.modality, lim: resolved.effectiveLimit,
    t: resolved.targets.map((target) => [target.assetId, target.sourceIdentityDigest]),
  })).digest("hex");
}

export type AiTargetPreview =
  | { eligible: true; mode: AiTargetMode; count: number; modality: "IMAGE" | "VIDEO"; effectiveLimit: number; previewFingerprint: string }
  | { eligible: false; reason: AiTargetFailureCode; effectiveLimit: number };

export type PreviewAiTargetResult =
  | { ok: true; preview: AiTargetPreview }
  | { ok: false; status: 400 | 403 | 404; code: "INVALID_REQUEST" | "FORBIDDEN" | "DATASET_NOT_FOUND" };

/**
 * Read-only preview of what an AI run would target. Creates nothing, returns
 * no ids, storage locations or counts for a target that fails eligibility,
 * and never substitutes the current Asset for an invalid selection. The
 * fingerprint is advisory freshness only; acceptance re-authorizes and
 * re-resolves.
 */
export async function previewAiTarget(actor: RequestActor, input: unknown): Promise<PreviewAiTargetResult> {
  const parsed = previewAiTargetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, code: "INVALID_REQUEST" };
  const access = await requireDatasetPermission(actor, parsed.data.datasetId, "annotation.create");
  if (!access) return { ok: false, status: 404, code: "DATASET_NOT_FOUND" };
  if (access.forbidden) return { ok: false, status: 403, code: "FORBIDDEN" };

  const target: AiTargetInput = parsed.data.target.mode === "CURRENT_ASSET"
    ? { mode: "CURRENT_ASSET", assetId: parsed.data.target.assetId }
    : { mode: "BULK_SELECTION", selection: parsed.data.target.selection as BulkSelectionInput };
  const resolved = await resolveAiTarget(parsed.data.datasetId, target);
  if (!resolved.ok) return { ok: true, preview: { eligible: false, reason: resolved.code, effectiveLimit: resolved.effectiveLimit } };
  return {
    ok: true,
    preview: {
      eligible: true, mode: resolved.targetMode, count: resolved.targets.length, modality: resolved.modality, effectiveLimit: resolved.effectiveLimit,
      previewFingerprint: computeAiPreviewFingerprint({ datasetId: parsed.data.datasetId, actorId: actor.id, modelId: parsed.data.modelId }, resolved),
    },
  };
}
