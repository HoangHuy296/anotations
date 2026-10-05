import "db-safety/deny-entry.cjs"; // G1: this writer has no approved operation scope.
/**
 * specs/027-coco-dataset-export §10/§10a -- Phase BACKFILL script.
 *
 * NOT RUNNABLE TODAY. This script queries and writes "Asset"."relativePath",
 * a column that does not exist in the real database yet (Phase EXPAND-1's
 * `ALTER TABLE "Asset" ADD COLUMN "relativePath" TEXT;` is a separate,
 * unapplied, later approval gate). Running this script before that ALTER
 * TABLE runs will fail immediately and loudly with a genuine Postgres
 * "column does not exist" error -- that failure mode is intentional and
 * relied upon as a safety property, not a bug to work around.
 *
 * Deliberately implemented with raw SQL ($queryRaw/$executeRaw) rather than
 * a typed Prisma model field: adding `relativePath` to schema.prisma and
 * regenerating the client is out of scope of this pass (that file is
 * protected by AGENTS.md's "no rewriting generated Prisma files without
 * explicit approval", and this script's only job is a one-off migration
 * tool, not a permanent typed application code path).
 *
 * SCOPE (amended): every reconstructable Asset row, including soft-deleted
 * and archived ones -- not just live ones -- so a future revival already
 * has a canonical identity instead of surfacing with relativePath still
 * NULL. A row whose candidate cannot be normalized (§4) is reported, never
 * invented a path for. Revival behavior for such a row is explicit, not
 * silent: it becomes a live Asset with relativePath = NULL, which is
 * tolerated indefinitely (§10's steady-state invariant already accepts a
 * NULL relativePath as "unenforced, not blocked") until an operator
 * assigns one by hand -- reviving it is never blocked by this migration.
 *
 * Collision detection is scoped to LIVE rows only (deletedAt IS NULL),
 * matching exactly what the §6 trigger itself enforces -- two deleted rows,
 * or a deleted and a live row, sharing a relativePath is not a conflict
 * (soft-deleted identities do not occupy the namespace). This keeps the
 * §5/§8 "30 groups / 66 live Assets" figure meaningful and unchanged by
 * this broader backfill scope.
 *
 * Modes:
 *   --dry-run (default): read-only. This IS the §10a preflight -- run it
 *     again, immediately before --apply, every single time, because this DB
 *     has active concurrent writers (§11c: 597 -> 609 -> 597 observed
 *     across sessions).
 *   --apply: writes the resolved relativePath to every currently-NULL
 *     Asset row (any lifecycle state). Idempotent / re-run-safe: never
 *     touches a row that already has a non-null relativePath, and the
 *     UPDATE re-checks relativePath IS NULL at write time, not just at the
 *     earlier read, closing the TOCTOU window against a concurrent writer.
 *
 * §5's historical-duplicate policy applies without exception: this script
 * never deletes, renames, or flags any Asset row. A collision it reports is
 * information for a human decision, never something it resolves itself.
 */
import { PrismaClient } from "../lib/generated/prisma/client.js";
import { config as loadEnvironment } from "dotenv";

import { getDatabaseUrl } from "../database-url.js";
import { resolveHistoricalCandidateRelativePath } from "../packages/domain/src/asset-relative-path-backfill.js";

loadEnvironment({ path: ".env", override: true, quiet: true });
loadEnvironment({ path: ".env.local", override: false, quiet: true });

const databaseUrl = getDatabaseUrl();
if (!databaseUrl) throw new Error("DATABASE_URL is required for the relativePath backfill.");

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: ["error"] });

type Row = {
  id: string;
  datasetId: string;
  filename: string;
  sourcePath: string | null;
  sourceRootPath: string | null;
  preparedImportNormalizedPath: string | null;
  deletedAt: Date | null;
  archivedAt: Date | null;
};

function lifecycle(row: Row): "live" | "archived" | "deleted" {
  if (row.deletedAt !== null) return "deleted";
  if (row.archivedAt !== null) return "archived";
  return "live";
}

async function loadCandidateRows(): Promise<Row[]> {
  // No deletedAt/archivedAt filter -- every reconstructable row is
  // backfilled (see the module docstring). Scoped only to relativePath IS
  // NULL, which is what makes re-running this script safe.
  return db.$queryRaw<Row[]>`
    SELECT a.id, a."datasetId", a.filename, a."sourcePath",
           d."sourceRootPath", a."deletedAt", a."archivedAt",
           (SELECT pii."normalizedPath" FROM "PreparedImportItem" pii WHERE pii."assetId" = a.id) AS "preparedImportNormalizedPath"
    FROM "Asset" a
    JOIN "Dataset" d ON d.id = a."datasetId"
    WHERE a."relativePath" IS NULL
  `;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await loadCandidateRows();

  const bySource: Record<string, number> = {};
  const byLifecycle = { live: 0, archived: 0, deleted: 0 };
  const unnormalizableByLifecycle = { live: 0, archived: 0, deleted: 0 };
  const unnormalizable: Row[] = [];
  const resolved = new Map<string, string>(); // assetId -> relativePath
  const byDatasetAndPathLiveOnly = new Map<string, string[]>(); // "datasetId::relativePath" -> assetId[], LIVE rows only

  for (const row of rows) {
    const state = lifecycle(row);
    byLifecycle[state] += 1;
    const outcome = resolveHistoricalCandidateRelativePath({
      preparedImportNormalizedPath: row.preparedImportNormalizedPath,
      sourcePath: row.sourcePath,
      datasetSourceRootPath: row.sourceRootPath,
      filename: row.filename,
    });
    if (!outcome.ok) {
      unnormalizable.push(row);
      unnormalizableByLifecycle[state] += 1;
      continue;
    }
    bySource[outcome.source] = (bySource[outcome.source] ?? 0) + 1;
    resolved.set(row.id, outcome.relativePath);
    if (state === "live") {
      const key = `${row.datasetId}::${outcome.relativePath}`;
      const list = byDatasetAndPathLiveOnly.get(key) ?? [];
      list.push(row.id);
      byDatasetAndPathLiveOnly.set(key, list);
    }
  }

  const collisionGroups = [...byDatasetAndPathLiveOnly.entries()].filter(([, ids]) => ids.length > 1);
  // Also check LIVE candidates against ALREADY-set LIVE relativePath rows
  // (an earlier partial backfill run, or an already-upgraded EXPAND-era
  // writer). Never checked for archived/deleted candidates -- they cannot
  // conflict with anything, by design.
  const existingCollisions: Array<{ assetId: string; relativePath: string; collidesWithAssetId: string }> = [];
  const liveResolvedIds = rows.filter((r) => lifecycle(r) === "live" && resolved.has(r.id)).map((r) => r.id);
  if (liveResolvedIds.length > 0) {
    const existing = await db.$queryRaw<Array<{ id: string; datasetId: string; relativePath: string }>>`
      SELECT id, "datasetId", "relativePath" FROM "Asset" WHERE "deletedAt" IS NULL AND "relativePath" IS NOT NULL
    `;
    const existingByKey = new Map(existing.map((row) => [`${row.datasetId}::${row.relativePath}`, row.id]));
    for (const assetId of liveResolvedIds) {
      const row = rows.find((r) => r.id === assetId)!;
      const relativePath = resolved.get(assetId)!;
      const key = `${row.datasetId}::${relativePath}`;
      const clash = existingByKey.get(key);
      if (clash) existingCollisions.push({ assetId, relativePath, collidesWithAssetId: clash });
    }
  }

  // PreparedImportItem.assetId cardinality re-check (§11's cardinality
  // audit, re-verified live rather than trusted from a stale report).
  const cardinality = await db.$queryRaw<Array<{ assetId: string; itemCount: bigint }>>`
    SELECT "assetId", count(*) AS "itemCount" FROM "PreparedImportItem" WHERE "assetId" IS NOT NULL GROUP BY "assetId" HAVING count(*) > 1
  `;

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Candidate rows (relativePath IS NULL, any lifecycle): ${rows.length}`);
  console.log("By lifecycle:", byLifecycle);
  console.log("Composition by source:", bySource);
  console.log(`Unnormalizable (would remain NULL, reported not silently skipped): ${unnormalizable.length}`, unnormalizableByLifecycle);
  if (unnormalizable.length) console.log("  asset ids:", unnormalizable.map((r) => `${r.id} (${lifecycle(r)})`));
  console.log(`Collision groups among this run's LIVE candidates: ${collisionGroups.length}`);
  for (const [key, ids] of collisionGroups) console.log(`  ${key} -> ${ids.length} assets: ${ids.join(", ")}`);
  console.log(`Collisions against already-set LIVE relativePath rows: ${existingCollisions.length}`);
  for (const collision of existingCollisions) console.log(`  ${JSON.stringify(collision)}`);
  console.log(`PreparedImportItem.assetId cardinality violations (must be 0): ${cardinality.length}`);

  if (!apply) {
    console.log("\nDry run only. No rows written. Re-run with --apply after reviewing the above, immediately before Phase ENFORCE.");
    await db.$disconnect();
    return;
  }

  if (cardinality.length > 0) {
    console.log("\nABORTED: PreparedImportItem.assetId cardinality violation detected. Do not apply.");
    await db.$disconnect();
    process.exitCode = 1;
    return;
  }

  let written = 0;
  for (const [assetId, relativePath] of resolved) {
    // Scoped update: only ever writes a row that is STILL NULL at write
    // time (re-checked in the WHERE clause, not just at read time above) --
    // closes the TOCTOU window against a concurrent writer that set this
    // same row's relativePath in between this script's read and write.
    // Deliberately no deletedAt filter here -- deleted/archived rows are
    // backfilled too, per the widened scope.
    const result = await db.$executeRaw`
      UPDATE "Asset" SET "relativePath" = ${relativePath}
      WHERE id = ${assetId} AND "relativePath" IS NULL
    `;
    written += result;
  }
  console.log(`\nApplied. ${written} row(s) written (of ${resolved.size} resolved candidates; a smaller count than resolved means a concurrent writer already set some of them, which is expected and safe).`);
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
