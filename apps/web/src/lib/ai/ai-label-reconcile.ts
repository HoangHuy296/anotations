import "server-only";

import { AiLabelClassInvalidError, canonicalAiLabelKey, resolveAiClassLabels } from "@annotationplatform/domain/ai-label-resolution";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { DEFAULT_IMAGE_LABELS, ensureDefaultImageLabels } from "@/lib/workspace/label-management";

const FROZEN_ASSET_STATUSES = ["NEEDS_REVIEW", "REVIEWED", "REJECTED"] as const;
const READ_BATCH = 2000;
const WRITE_CHUNK = 1000;
const DEFAULT_KEYS = new Set<string>(DEFAULT_IMAGE_LABELS.map((label) => label.name.trim().toLocaleLowerCase("en-US")));

export type AiLabelReconcileClassReport = {
  predictedClass: string;
  outcome: "REUSED" | "CREATED" | "CONFLICT" | "INVALID" | "UNKNOWN";
  annotations: number;
  tracks: number;
};

export type AiLabelReconcileResult =
  | {
    ok: true; dryRun: boolean; scanned: number; annotationsUpdated: number; tracksUpdated: number; labelsCreated: number;
    classes: AiLabelReconcileClassReport[];
    skipped: { noOriginalClass: number; trackClassMismatch: number };
  }
  | { ok: false; status: 404 | 403 | 409; code: "NOT_FOUND" | "FORBIDDEN" | "UNSUPPORTED_MODALITY" };

/**
 * Scoped, idempotent repair of AI annotations that were persisted without a label although their original provider class is recorded
 * (`properties.predictedClass`, written by both AI writers). It never reruns inference, never deletes or moves a box/track, and never touches a row a
 * human could have edited: only AI-sourced rows that are still unlabeled at revision 1 are candidates, and every write re-checks exactly that predicate,
 * so an edit that lands concurrently wins. Classes resolve through the shared contract (reuse / create Dataset label / report conflict).
 * Rows without recorded class metadata are counted and left alone: no guessing.
 */
export async function reconcileAiLabels(actor: RequestActor, datasetId: string, options: { dryRun: boolean }): Promise<AiLabelReconcileResult> {
  const access = await requireDatasetPermission(actor, datasetId, "label.manage");
  if (!access) return { ok: false, status: 404, code: "NOT_FOUND" };
  if (access.forbidden) return { ok: false, status: 403, code: "FORBIDDEN" };
  const modality = (await db.dataset.findUnique({ where: { id: datasetId }, select: { modality: true } }))?.modality ?? null;
  if (modality !== "IMAGE" && modality !== "VIDEO") return { ok: false, status: 409, code: "UNSUPPORTED_MODALITY" };

  // 0. Datasets written before defaults carried the Dataset modality hold the six defaults as IMAGE labels inside a VIDEO dataset. The shared default-label
  //    service repairs exactly those rows (same id/name/colour, modality only), so apply it first; a dry run reports the outcome without writing.
  if (!options.dryRun) await ensureDefaultImageLabels(actor, datasetId);

  // 1. Read candidates (read-only, batched by id cursor).
  type Candidate = { id: string; trackId: string | null; predictedClass: string | null; trackClass: string | null };
  const candidates: Candidate[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.annotation.findMany({
      where: {
        datasetId, modality, source: "AI", labelId: null, revision: 1,
        asset: { deletedAt: null, archivedAt: null, status: { notIn: [...FROZEN_ASSET_STATUSES] } },
        OR: [{ trackId: null }, { track: { labelId: null, revision: 1 } }],
      },
      orderBy: { id: "asc" }, take: READ_BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, trackId: true, properties: true, track: { select: { properties: true } } },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const own = (row.properties as { predictedClass?: unknown } | null)?.predictedClass;
      const track = (row.track?.properties as { predictedClass?: unknown } | null)?.predictedClass;
      candidates.push({ id: row.id, trackId: row.trackId, predictedClass: typeof own === "string" ? own : null, trackClass: typeof track === "string" ? track : null });
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < READ_BATCH) break;
  }

  // 2. Group by canonical class; classify rows we must not touch.
  const skipped = { noOriginalClass: 0, trackClassMismatch: 0 };
  const byClass = new Map<string, { display: string; annotationIds: string[]; trackIds: Set<string>; invalid: boolean; unknown: boolean }>();
  for (const candidate of candidates) {
    if (candidate.predictedClass === null) { skipped.noOriginalClass++; continue; }
    if (candidate.trackId && candidate.trackClass !== null && candidate.trackClass.trim().toLocaleLowerCase("en-US") !== candidate.predictedClass.trim().toLocaleLowerCase("en-US")) { skipped.trackClassMismatch++; continue; }
    let key: string; let invalid = false; let unknown = false;
    try { const canonical = canonicalAiLabelKey(candidate.predictedClass); if (!canonical) { key = "unknown"; unknown = true; } else key = canonical.key; }
    catch (error) { if (!(error instanceof AiLabelClassInvalidError)) throw error; key = `invalid:${candidate.predictedClass.slice(0, 64)}`; invalid = true; }
    const entry = byClass.get(key) ?? { display: candidate.predictedClass.trim(), annotationIds: [], trackIds: new Set<string>(), invalid, unknown };
    entry.annotationIds.push(candidate.id);
    if (candidate.trackId) entry.trackIds.add(candidate.trackId);
    byClass.set(key, entry);
  }
  const resolvable = [...byClass.entries()].filter(([, entry]) => !entry.invalid && !entry.unknown);

  // 3. Resolve (creating missing labels) and write, atomically; a dry run only reports what would happen.
  const classes: AiLabelReconcileClassReport[] = [];
  let annotationsUpdated = 0; let tracksUpdated = 0; let labelsCreated = 0;
  const run = async (tx: Pick<typeof db, "label" | "annotation" | "videoObjectTrack">, write: boolean) => {
    const existing = await tx.label.findMany({ where: { datasetId, normalizedName: { in: resolvable.map(([key]) => key) } }, select: { id: true, normalizedName: true, modality: true, scope: true } });
    const preResolution = write ? await resolveAiClassLabels(tx, datasetId, modality, resolvable.map(([, entry]) => entry.display)) : null;
    for (const [key, entry] of byClass) {
      if (entry.invalid) { classes.push({ predictedClass: entry.display, outcome: "INVALID", annotations: entry.annotationIds.length, tracks: entry.trackIds.size }); continue; }
      if (entry.unknown) { classes.push({ predictedClass: entry.display, outcome: "UNKNOWN", annotations: entry.annotationIds.length, tracks: entry.trackIds.size }); continue; }
      const row = existing.find((label) => label.normalizedName === key);
      const repairableDefault = Boolean(row) && modality === "VIDEO" && row!.modality === "IMAGE" && row!.scope === "OBJECT" && DEFAULT_KEYS.has(key);
      const compatible = row ? ((row.modality === null || row.modality === modality) && row.scope === "OBJECT") || (!write && repairableDefault) : true;
      const labelId = write ? preResolution!.labelIds.get(key) ?? null : row && compatible ? row.id : null;
      const outcome: AiLabelReconcileClassReport["outcome"] = !compatible ? "CONFLICT" : row ? "REUSED" : "CREATED";
      classes.push({ predictedClass: entry.display, outcome, annotations: entry.annotationIds.length, tracks: entry.trackIds.size });
      if (!write || !labelId || outcome === "CONFLICT") continue;
      for (let i = 0; i < entry.annotationIds.length; i += WRITE_CHUNK) {
        const result = await tx.annotation.updateMany({ where: { id: { in: entry.annotationIds.slice(i, i + WRITE_CHUNK) }, datasetId, source: "AI", labelId: null, revision: 1 }, data: { labelId } });
        annotationsUpdated += result.count;
      }
      const trackIds = [...entry.trackIds];
      for (let i = 0; i < trackIds.length; i += WRITE_CHUNK) {
        const result = await tx.videoObjectTrack.updateMany({ where: { id: { in: trackIds.slice(i, i + WRITE_CHUNK) }, labelId: null, revision: 1 }, data: { labelId } });
        tracksUpdated += result.count;
      }
    }
    if (preResolution) labelsCreated = preResolution.created.length;
  };
  if (options.dryRun) await run(db, false);
  else await db.$transaction(async (tx) => { await run(tx, true); }, { timeout: 60_000 });

  return { ok: true, dryRun: options.dryRun, scanned: candidates.length, annotationsUpdated, tracksUpdated, labelsCreated, classes: classes.sort((a, b) => b.annotations - a.annotations), skipped };
}
