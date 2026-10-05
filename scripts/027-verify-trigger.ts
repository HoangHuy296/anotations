import "db-safety/deny-entry.cjs"; // G1: this writer has no approved operation scope.
/**
 * specs/027-coco-dataset-export §10, Phase ENFORCE verification (functional
 * check, referenced by trigger-verification-queries.sql).
 *
 * NOT RUNNABLE TODAY: needs the real Asset.relativePath column and the
 * Step B trigger, neither of which exist yet (separate, unapplied approval
 * gate). Run this immediately after installing the trigger, inside the
 * quiescence window, before resuming writers.
 *
 * Creates one throwaway Dataset/User and two conflicting Asset rows INSIDE
 * a single transaction that always rolls back -- nothing this script does
 * is ever committed or visible to any other session, and no real dataset or
 * historical row is touched.
 */
import { PrismaClient, Prisma } from "../lib/generated/prisma/client.js";
import { config as loadEnvironment } from "dotenv";

import { getDatabaseUrl } from "../database-url.js";
import { isAssetRelativePathConflict } from "../packages/domain/src/asset-identity-conflict.js";

loadEnvironment({ path: ".env", override: true, quiet: true });
loadEnvironment({ path: ".env.local", override: false, quiet: true });

const databaseUrl = getDatabaseUrl();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: ["error"] });

async function main() {
  let outcome: "PASS" | "FAIL" = "FAIL";
  let detail = "";
  try {
    await db.$transaction(async (tx) => {
      const owner = await tx.user.create({ data: { email: `verify-027-${Date.now()}@test.invalid`, role: "MANAGER" }, select: { id: true } });
      const dataset = await tx.dataset.create({ data: { ownerId: owner.id, name: "verify-027-trigger" }, select: { id: true } });

      // First row: should succeed (relativePath is new/unique in this
      // throwaway dataset).
      await tx.$executeRaw`
        INSERT INTO "Asset" (id, "datasetId", modality, filename, "mimeType", "sourceFingerprint", "sourceMode", status, "relativePath")
        VALUES (${`verify-1-${Date.now()}`}, ${dataset.id}, 'IMAGE', 'a.png', 'image/png', ${`verify-fp-1-${Date.now()}`}, 'UPLOAD', 'NEW', 'a/1.png')
      `;

      // Second row: same (datasetId, relativePath) -- must be rejected by
      // the trigger, not silently accepted.
      try {
        await tx.$executeRaw`
          INSERT INTO "Asset" (id, "datasetId", modality, filename, "mimeType", "sourceFingerprint", "sourceMode", status, "relativePath")
          VALUES (${`verify-2-${Date.now()}`}, ${dataset.id}, 'IMAGE', 'a.png', 'image/png', ${`verify-fp-2-${Date.now()}`}, 'UPLOAD', 'NEW', 'a/1.png')
        `;
        detail = "SECOND INSERT UNEXPECTEDLY SUCCEEDED -- the trigger is not enforcing.";
      } catch (error) {
        const matches = isAssetRelativePathConflict(error);
        detail = `second insert rejected as expected=${matches}; shape=${JSON.stringify({ code: (error as Prisma.PrismaClientKnownRequestError).code, meta: (error as Prisma.PrismaClientKnownRequestError).meta })}`;
        outcome = matches ? "PASS" : "FAIL";
      }

      // Always roll back -- nothing this script does is ever committed.
      throw new Error("__ROLLBACK_INTENTIONAL__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__ROLLBACK_INTENTIONAL__") throw error;
  }

  console.log(`Trigger functional verification: ${outcome}`);
  console.log(detail);
  console.log("Nothing committed -- the throwaway Dataset/User/Asset rows above never persisted.");
  await db.$disconnect();
  process.exitCode = outcome === "PASS" ? 0 : 1;
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
