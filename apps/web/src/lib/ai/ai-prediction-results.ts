import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { isValidImageGeometryForType } from "@/lib/validation/annotation-api";
import { claimEditableAssetContent } from "@/lib/workflow/asset-workflow-service";
import { toSafeAnnotation } from "@/lib/annotations/safe-annotation";
import type { AiPredictionPreview } from "@/types/ai-prediction";

const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict();
const prediction = z.object({ assetId: z.string(), labelKey: z.string().min(1).max(256), confidence: z.number().min(0).max(1), boundingBoxes: box });
export const savePredictionSchema = z.object({ assetId: z.string().min(1).max(128), index: z.number().int().nonnegative(), labelId: z.string().min(1).max(128) }).strict();

const AI_COLORS = ["#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#84cc16", "#f97316", "#14b8a6", "#a855f7"] as const;

/** Stable per prediction and guaranteed not to reuse a current taxonomy color. */
export function aiPredictionColor(taskId: string, _index: number, labelKey: string, taxonomyColors: readonly string[]): string {
  const used = new Set(taxonomyColors.map((color) => color.toLowerCase()));
  // Every prediction for the same provider class must advertise the same
  // color because the arrow resolves them to one dataset Label.
  const offset = createHash("sha256").update(`${taskId}:${labelKey.trim().toLocaleLowerCase("en-US")}`).digest()[0] ?? 0;
  for (let step = 0; step < AI_COLORS.length; step++) {
    const color = AI_COLORS[(offset + step) % AI_COLORS.length];
    if (!used.has(color.toLowerCase())) return color;
  }
  // An unusually large taxonomy may consume the fixed palette. Probe
  // deterministic generated colors until one is genuinely unused.
  for (let attempt = 0; ; attempt++) {
    const color = `#${createHash("sha256").update(`ai:${taskId}:${labelKey}:${attempt}`).digest("hex").slice(0, 6)}`;
    if (!used.has(color.toLowerCase())) return color;
  }
}

/** Only the canonical geometry and safe labels are projected; never return raw task JSON. */
export function projectPredictionResults(output: unknown, input: unknown, assetId: string): AiPredictionPreview[] {
  const scope = z.object({ assetIds: z.array(z.string()) }).safeParse(input);
  if (!scope.success || !scope.data.assetIds.includes(assetId)) return [];
  const parsed = z.object({ predictions: z.array(z.unknown()).max(10000) }).safeParse(output);
  if (!parsed.success) return [];
  return parsed.data.predictions.flatMap((item, index) => {
    const p = prediction.safeParse(item);
    if (!p.success || p.data.assetId !== assetId || !isValidImageGeometryForType("BOUNDING_BOX", p.data.boundingBoxes)) return [];
    return [{ index, assetId, labelKey: p.data.labelKey, confidence: p.data.confidence, color: AI_COLORS[0], geometry: p.data.boundingBoxes, saved: false }];
  });
}

export function predictionAnnotationId(taskId: string, index: number) {
  return `c${createHash("sha256").update(`${taskId}:${index}`).digest("hex").slice(0, 24)}`;
}

// Legacy automatic annotations have no prediction index. Match their class and
// geometry to avoid offering an already persisted prediction a second time.
function wasSaved(p: AiPredictionPreview, taskId: string, rows: Array<{ id: string; geometry: unknown; label: { normalizedName: string } | null; properties: unknown }>) {
  return rows.some((row) => {
    if (row.id === predictionAnnotationId(taskId, p.index)) return true;
    const properties = row.properties as { aiPredictionIndex?: unknown } | null;
    if (properties?.aiPredictionIndex === p.index) return true;
    const geometry = box.safeParse(row.geometry);
    return row.label?.normalizedName === p.labelKey.trim().toLocaleLowerCase("en-US") && geometry.success &&
      (Object.keys(p.geometry) as Array<keyof typeof p.geometry>).every((key) => Math.abs(p.geometry[key] - geometry.data[key]) < 1e-12);
  });
}

export async function readAiPredictionResults(actor: RequestActor, assetId: string, taskId?: string) {
  const asset = await db.asset.findFirst({ where: { id: assetId, modality: "IMAGE", deletedAt: null, archivedAt: null }, select: { datasetId: true } });
  if (!asset) return null;
  const access = await requireDatasetPermission(actor, asset.datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const task = await db.aiTask.findFirst({
    where: { ...(taskId ? { id: taskId } : {}), datasetId: asset.datasetId, status: "SUCCEEDED", modality: "IMAGE", type: { in: ["DETECT_OBJECTS", "DETECTION"] }, input: { path: ["assetIds"], array_contains: [assetId] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, output: true, input: true },
  });
  if (!task) return taskId ? null : { taskId: null, predictions: [] };
  const [rows, taxonomy] = await Promise.all([
    db.annotation.findMany({ where: { datasetId: asset.datasetId, assetId, properties: { path: ["aiTaskId"], equals: task.id } }, select: { id: true, geometry: true, properties: true, label: { select: { normalizedName: true } } } }),
    db.label.findMany({ where: { datasetId: asset.datasetId }, select: { color: true } }),
  ]);
  return { taskId: task.id, predictions: projectPredictionResults(task.output, task.input, assetId).map((p) => ({ ...p, color: aiPredictionColor(task.id, p.index, p.labelKey, taxonomy.map((label) => label.color)), saved: wasSaved(p, task.id, rows) })) };
}

export class PredictionSaveError extends Error {
  constructor(readonly code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "WORKFLOW_LOCKED") { super(code); }
}

export async function saveAiPrediction(actor: RequestActor, taskId: string, raw: unknown) {
  const input = savePredictionSchema.parse(raw);
  const task = await db.aiTask.findUnique({ where: { id: taskId }, select: { id: true, datasetId: true, status: true, modality: true, type: true, input: true, output: true, modelKeySnapshot: true } });
  if (!task || task.status !== "SUCCEEDED" || task.modality !== "IMAGE" || !["DETECT_OBJECTS", "DETECTION"].includes(task.type)) throw new PredictionSaveError("NOT_FOUND");
  const access = await requireDatasetPermission(actor, task.datasetId, "annotation.create");
  if (!access || access.forbidden) throw new PredictionSaveError("NOT_FOUND");
  const p = projectPredictionResults(task.output, task.input, input.assetId).find((item) => item.index === input.index);
  if (!p) throw new PredictionSaveError("NOT_FOUND");
  const id = predictionAnnotationId(task.id, p.index);
  return db.$transaction(async (tx) => {
    // Serializes saves per Asset and preserves the existing review-state guard.
    if (!await claimEditableAssetContent(tx, input.assetId, task.datasetId)) throw new PredictionSaveError("WORKFLOW_LOCKED");
    const taxonomy = await tx.label.findMany({ where: { datasetId: task.datasetId }, select: { color: true } });
    const color = aiPredictionColor(task.id, p.index, p.labelKey, taxonomy.map((label) => label.color));
    const label = await tx.label.findFirst({ where: { id: input.labelId, datasetId: task.datasetId, normalizedName: p.labelKey.trim().toLocaleLowerCase("en-US"), OR: [{ modality: null }, { modality: "IMAGE" }] }, select: { id: true } });
    if (!label) throw new PredictionSaveError("NOT_FOUND");
    const rows = await tx.annotation.findMany({ where: { datasetId: task.datasetId, assetId: input.assetId, properties: { path: ["aiTaskId"], equals: task.id } }, include: { label: true } });
    const existing = rows.find((row) => wasSaved(p, task.id, [row]));
    if (existing) {
      if (existing.labelId !== label.id) throw new PredictionSaveError("CONFLICT");
      return toSafeAnnotation(existing);
    }
    const annotation = await tx.annotation.create({ data: {
      id, datasetId: task.datasetId, assetId: input.assetId, labelId: label.id, createdById: actor.id,
      modality: "IMAGE", type: "BOUNDING_BOX", source: "AI", status: "DRAFT", geometry: p.geometry,
      properties: { aiTaskId: task.id, aiPredictionIndex: p.index, predictedClass: p.labelKey, aiDisplayLabel: `#${p.index + 1} ${p.labelKey}`, aiColor: color, confidence: p.confidence, modelKey: task.modelKeySnapshot },
    }, include: { label: true } });
    return toSafeAnnotation(annotation);
  });
}
