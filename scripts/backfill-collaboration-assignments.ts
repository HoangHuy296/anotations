import { PrismaClient } from "../lib/generated/prisma/client.js";
import { config as loadEnvironment } from "dotenv";

import { getDatabaseUrl } from "../database-url.js";

loadEnvironment({ path: ".env", override: true, quiet: true });
loadEnvironment({ path: ".env.local", override: false, quiet: true });

const databaseUrl = getDatabaseUrl();
if (!databaseUrl) throw new Error("DATABASE_URL is required for collaboration assignment backfill.");

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: ["error"] });

type BackfillReport = {
  scanned: number;
  created: number;
  alreadyPresent: number;
  exceptions: { ineligibleLegacyAssignee: number; missingMember: number };
};

async function main() {
  const report: BackfillReport = {
    scanned: 0,
    created: 0,
    alreadyPresent: 0,
    exceptions: { ineligibleLegacyAssignee: 0, missingMember: 0 },
  };
  const assets = await db.asset.findMany({
    where: { assignedToId: { not: null }, deletedAt: null },
    select: { id: true, datasetId: true, assignedToId: true },
  });

  for (const asset of assets) {
    if (!asset.assignedToId) continue;
    report.scanned += 1;
    const membership = await db.datasetMember.findUnique({
      where: { datasetId_userId: { datasetId: asset.datasetId, userId: asset.assignedToId } },
      select: { role: true },
    });
    if (!membership) {
      report.exceptions.missingMember += 1;
      continue;
    }
    if (membership.role !== "LABELER") {
      report.exceptions.ineligibleLegacyAssignee += 1;
      continue;
    }
    const existing = await db.assetAssignment.findUnique({
      where: { assetId_type: { assetId: asset.id, type: "ANNOTATION" } },
      select: { id: true },
    });
    if (existing) {
      report.alreadyPresent += 1;
      continue;
    }
    try {
      await db.$transaction(async (tx) => {
        const created = await tx.assetAssignment.create({
          data: { datasetId: asset.datasetId, assetId: asset.id, userId: asset.assignedToId!, type: "ANNOTATION" },
          select: { id: true },
        });
        await tx.assetAssignmentEvent.create({
          data: {
            datasetId: asset.datasetId,
            assetId: asset.id,
            assignmentId: created.id,
            action: "ASSIGNED",
            nextUserId: asset.assignedToId!,
          },
        });
      });
      report.created += 1;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        report.alreadyPresent += 1;
        continue;
      }
      throw error;
    }
  }

  // Deliberately aggregate-only: exception details could disclose assignment
  // relationships in logs. Operators can reconcile under authorized DB access.
  console.log(JSON.stringify(report));
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Collaboration assignment backfill failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
