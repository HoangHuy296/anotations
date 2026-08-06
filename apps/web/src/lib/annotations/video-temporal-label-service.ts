import "server-only";

import { AnnotationSource, AnnotationStatus, AnnotationType, Modality, Prisma } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { assertAnnotationPermission, requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { toSafeVideoTemporalLabel } from "@/lib/annotations/video-projection";
import { videoTemporalLabelCreateSchema, videoTemporalLabelDeleteSchema, videoTemporalLabelUpdateSchema } from "@/lib/validation/video-annotation";

export type TemporalLabelFailure = "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT";
export type TemporalLabelResult<T> = { ok: true; value: T } | { ok: false; reason: TemporalLabelFailure };

const temporalTypes = new Set<AnnotationType>([AnnotationType.EVENT, AnnotationType.SCENE, AnnotationType.SHOT_BOUNDARY]);
const select = {
  id: true, assetId: true, labelId: true, type: true, startMs: true, endMs: true,
  revision: true, properties: true, createdAt: true, updatedAt: true,
} satisfies Prisma.AnnotationSelect;

async function resolve(actor: RequestActor, assetId: string) {
  const asset = await db.asset.findFirst({ where: { id: assetId, deletedAt: null, archivedAt: null, modality: Modality.VIDEO }, select: { id: true, datasetId: true, durationMs: true } });
  if (!asset) return null;
  const access = await requireDatasetPermission(actor, asset.datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  return { asset };
}

async function sameDatasetLabel(labelId: string | null | undefined, datasetId: string) {
  if (!labelId) return true;
  const label = await db.label.findFirst({ where: { id: labelId, datasetId, OR: [{ modality: null }, { modality: Modality.VIDEO }] }, select: { id: true } });
  return Boolean(label);
}

function validBounds(startMs: number, endMs: number, durationMs: number | null) {
  return Number.isFinite(durationMs) && (durationMs as number) > 0 && startMs >= 0 && startMs < endMs && endMs <= (durationMs as number);
}

export async function createVideoTemporalLabel(actor: RequestActor, assetId: string, input: unknown): Promise<TemporalLabelResult<ReturnType<typeof toSafeVideoTemporalLabel>>> {
  const parsed = videoTemporalLabelCreateSchema.safeParse(input);
  if (!parsed.success || !temporalTypes.has(parsed.data.type as AnnotationType)) return { ok: false, reason: "INVALID_REQUEST" };
  const resolved = await resolve(actor, assetId);
  if (!resolved) return { ok: false, reason: "NOT_FOUND" };
  if (!validBounds(parsed.data.startMs, parsed.data.endMs, resolved.asset.durationMs)) return { ok: false, reason: "INVALID_REQUEST" };
  const permission = await assertAnnotationPermission(actor, resolved.asset.datasetId, "annotation.create");
  if (!permission) return { ok: false, reason: "NOT_FOUND" };
  if (permission.forbidden || !(await sameDatasetLabel(parsed.data.labelId, resolved.asset.datasetId))) return { ok: false, reason: permission.forbidden ? "FORBIDDEN" : "NOT_FOUND" };
  const annotation = await db.annotation.create({ data: { datasetId: resolved.asset.datasetId, assetId, labelId: parsed.data.labelId ?? null, createdById: actor.id, modality: Modality.VIDEO, type: parsed.data.type as AnnotationType, source: AnnotationSource.MANUAL, geometry: {}, properties: parsed.data.properties as Prisma.InputJsonValue, status: AnnotationStatus.DRAFT, startMs: parsed.data.startMs, endMs: parsed.data.endMs, isKeyframe: false, isInterpolated: false }, select });
  return { ok: true, value: toSafeVideoTemporalLabel({ ...annotation, type: annotation.type as "EVENT" | "SCENE" | "SHOT_BOUNDARY", startMs: annotation.startMs as number, endMs: annotation.endMs as number }) };
}

async function resolveExisting(actor: RequestActor, annotationId: string) {
  const annotation = await db.annotation.findFirst({ where: { id: annotationId, modality: Modality.VIDEO, trackId: null, isKeyframe: false, isInterpolated: false, type: { in: [AnnotationType.EVENT, AnnotationType.SCENE, AnnotationType.SHOT_BOUNDARY] } }, select: { ...select, createdById: true, datasetId: true, asset: { select: { modality: true, durationMs: true, deletedAt: true, archivedAt: true } } } });
  if (!annotation || annotation.asset.modality !== Modality.VIDEO || annotation.asset.deletedAt || annotation.asset.archivedAt) return null;
  const access = await requireDatasetPermission(actor, annotation.datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  return { annotation };
}

export async function updateVideoTemporalLabel(actor: RequestActor, annotationId: string, input: unknown): Promise<TemporalLabelResult<ReturnType<typeof toSafeVideoTemporalLabel>>> {
  const parsed = videoTemporalLabelUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const resolved = await resolveExisting(actor, annotationId);
  if (!resolved) return { ok: false, reason: "NOT_FOUND" };
  const permission = await assertAnnotationPermission(actor, resolved.annotation.datasetId, resolved.annotation.createdById === actor.id ? "annotation.updateOwn" : "annotation.updateAny");
  if (!permission) return { ok: false, reason: "NOT_FOUND" };
  if (permission.forbidden) return { ok: false, reason: "FORBIDDEN" };
  if (!(await sameDatasetLabel(parsed.data.labelId, resolved.annotation.datasetId))) return { ok: false, reason: "NOT_FOUND" };
  const startMs = parsed.data.startMs ?? resolved.annotation.startMs;
  const endMs = parsed.data.endMs ?? resolved.annotation.endMs;
  if (startMs === null || endMs === null || !validBounds(startMs, endMs, resolved.annotation.asset.durationMs)) return { ok: false, reason: "INVALID_REQUEST" };
  const data: Prisma.AnnotationUncheckedUpdateManyInput = { revision: { increment: 1 }, updatedById: actor.id, startMs, endMs };
  if (parsed.data.labelId !== undefined) data.labelId = parsed.data.labelId;
  if (parsed.data.properties !== undefined) data.properties = parsed.data.properties as Prisma.InputJsonValue;
  const changed = await db.annotation.updateMany({ where: { id: annotationId, revision: parsed.data.expectedRevision }, data });
  if (changed.count !== 1) return { ok: false, reason: "CONFLICT" };
  const current = await db.annotation.findUniqueOrThrow({ where: { id: annotationId }, select });
  return { ok: true, value: toSafeVideoTemporalLabel({ ...current, type: current.type as "EVENT" | "SCENE" | "SHOT_BOUNDARY", startMs: current.startMs as number, endMs: current.endMs as number }) };
}

export async function deleteVideoTemporalLabel(actor: RequestActor, annotationId: string, input: unknown): Promise<TemporalLabelResult<null>> {
  const parsed = videoTemporalLabelDeleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const resolved = await resolveExisting(actor, annotationId);
  if (!resolved) return { ok: false, reason: "NOT_FOUND" };
  const permission = await assertAnnotationPermission(actor, resolved.annotation.datasetId, resolved.annotation.createdById === actor.id ? "annotation.updateOwn" : "annotation.updateAny");
  if (!permission) return { ok: false, reason: "NOT_FOUND" };
  if (permission.forbidden) return { ok: false, reason: "FORBIDDEN" };
  const removed = await db.annotation.deleteMany({ where: { id: annotationId, revision: parsed.data.expectedRevision } });
  return removed.count === 1 ? { ok: true, value: null } : { ok: false, reason: "CONFLICT" };
}
