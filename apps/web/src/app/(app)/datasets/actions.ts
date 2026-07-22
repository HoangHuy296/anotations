"use server";
import { DatasetMemberRole } from "@internal/db";
import { z } from "zod";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { datasetIdSchema } from "@/lib/validation/dataset";

const memberInputSchema = z.object({ datasetId: datasetIdSchema, userId: z.string().cuid(), role: z.enum(["MANAGER", "REVIEWER", "LABELER"]) });

export async function archiveDatasetAction(datasetId: unknown) {
  const parsed = datasetIdSchema.safeParse(datasetId); if (!parsed.success) return { ok: false, status: 400 };
  const actor = await getRequestActor(); if (!actor) return { ok: false, status: 401 };
  const access = await requireDatasetPermission(actor, parsed.data, "dataset.delete");
  if (!access) return { ok: false, status: 404 }; if (access.forbidden) return { ok: false, status: 403 };
  await db.dataset.update({ where: { id: parsed.data }, data: { archivedAt: new Date() } }); return { ok: true, status: 200 };
}

export async function upsertDatasetMemberAction(input: unknown) {
  const parsed = memberInputSchema.safeParse(input); if (!parsed.success) return { ok: false, status: 400 };
  const actor = await getRequestActor(); if (!actor) return { ok: false, status: 401 };
  const access = await requireDatasetPermission(actor, parsed.data.datasetId, "member.manage");
  if (!access) return { ok: false, status: 404 }; if (access.forbidden) return { ok: false, status: 403 };
  if (access.dataset.ownerId === parsed.data.userId) return { ok: false, status: 403 };
  const user = await db.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
  if (!user) return { ok: false, status: 404 };
  const existing = await db.datasetMember.findUnique({ where: { datasetId_userId: { datasetId: parsed.data.datasetId, userId: parsed.data.userId } }, select: { role: true } });
  if (existing?.role === DatasetMemberRole.OWNER) return { ok: false, status: 403 };
  await db.datasetMember.upsert({ where: { datasetId_userId: { datasetId: parsed.data.datasetId, userId: parsed.data.userId } }, update: { role: parsed.data.role }, create: { datasetId: parsed.data.datasetId, userId: parsed.data.userId, role: parsed.data.role } });
  return { ok: true, status: 200 };
}

export async function removeDatasetMemberAction(input: unknown) {
  const parsed = z.object({ datasetId: datasetIdSchema, userId: z.string().cuid() }).safeParse(input); if (!parsed.success) return { ok: false, status: 400 };
  const actor = await getRequestActor(); if (!actor) return { ok: false, status: 401 };
  const access = await requireDatasetPermission(actor, parsed.data.datasetId, "member.manage");
  if (!access) return { ok: false, status: 404 }; if (access.forbidden || access.dataset.ownerId === parsed.data.userId) return { ok: false, status: 403 };
  const member = await db.datasetMember.findUnique({ where: { datasetId_userId: { datasetId: parsed.data.datasetId, userId: parsed.data.userId } }, select: { role: true } });
  if (member?.role === DatasetMemberRole.OWNER) return { ok: false, status: 403 };
  await db.datasetMember.deleteMany({ where: { datasetId: parsed.data.datasetId, userId: parsed.data.userId } });
  return { ok: true, status: 200 };
}
