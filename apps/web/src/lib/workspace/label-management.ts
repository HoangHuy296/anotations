import "server-only";

import { Modality, Prisma } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { normalizeLabelName } from "@/lib/validation/label";

const DEFAULT_IMAGE_LABELS = [
  { name: "object", color: "#0EA5E9" },
  { name: "person", color: "#8B5CF6" },
  { name: "vehicle", color: "#F59E0B" },
  { name: "animal", color: "#10B981" },
  { name: "text", color: "#E11D48" },
  { name: "aidetect", color: "#ff99fc" },
] as const;

export async function ensureDefaultImageLabels(actor: RequestActor, datasetId: string) {
  const access = await requireDatasetPermission(actor, datasetId, "label.manage");
  if (!access) return { ok: false as const, status: 404 as const };
  if (access.forbidden) return { ok: false as const, status: 403 as const };
  const existing = await db.label.count({ where: { datasetId } });
  if (existing > 0) return { ok: true as const, created: 0 };
  let created = 0;
  for (const label of DEFAULT_IMAGE_LABELS) {
    try {
      await db.label.create({ data: { datasetId, modality: Modality.IMAGE, name: label.name, normalizedName: normalizeLabelName(label.name), color: label.color } });
      created += 1;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
  }
  return { ok: true as const, created };
}

export async function deleteUnreferencedLabel(actor: RequestActor, labelId: string) {
  const label = await db.label.findFirst({ where: { id: labelId }, select: { id: true, datasetId: true, _count: { select: { annotations: true } } } });
  if (!label) return { ok: false as const, status: 404 as const };
  const access = await requireDatasetPermission(actor, label.datasetId, "label.manage");
  if (!access) return { ok: false as const, status: 404 as const };
  if (access.forbidden) return { ok: false as const, status: 403 as const };
  if (label._count.annotations > 0) return { ok: false as const, status: 409 as const };
  const deleted = await db.label.deleteMany({ where: { id: label.id, annotations: { none: {} } } });
  return deleted.count === 1 ? { ok: true as const } : { ok: false as const, status: 409 as const };
}

export { DEFAULT_IMAGE_LABELS };
