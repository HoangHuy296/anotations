import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * Phase 010's worker receipt validates the durable preparation after it has
 * claimed the Job. Browser transfer remains direct to MinIO; completion is an
 * explicit authorized application signal, so this handler deliberately does
 * not mark the Job terminal or proxy any bytes.
 */
export async function processImportDataset(db: PrismaClient, jobId: string) {
  const preparation = await db.preparedImport.findUnique({ where: { jobId }, select: { id: true, status: true } });
  return Boolean(preparation && preparation.status === "PREPARING");
}

