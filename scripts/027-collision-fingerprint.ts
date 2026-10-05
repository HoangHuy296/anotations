/**
 * specs/027-coco-dataset-export §10 (correction #3) -- deterministic
 * fingerprint of the exact historical live-collision SET, not just a
 * "30 groups / 66 assets" count that could hide a swap (e.g. one asset
 * removed from a group while another was added, keeping counts identical
 * but membership different). Run this at every migration checkpoint and
 * compare fingerprints -- they must be byte-identical whenever no data
 * change was intended (EXPAND-1, GATE, before/after BACKFILL apply,
 * before/after ENFORCE), and the print-out shows exactly which group
 * changed if they ever differ.
 *
 * Two modes, same fingerprint algorithm, so a --pre run (before the
 * relativePath column exists) and a --post run (after BACKFILL) are
 * directly comparable across the migration boundary:
 *   --pre  : derives each live Asset's candidate relativePath via the same
 *            resolveHistoricalCandidateRelativePath() the backfill uses --
 *            runnable TODAY, no schema change required.
 *   --post : reads the real "Asset"."relativePath" column directly --
 *            only runnable after Phase EXPAND-1/BACKFILL.
 *
 * Path values are never printed raw -- only a truncated SHA-256 digest,
 * per instruction ("sensitive path values hashed/redacted").
 */
import { createHash } from "node:crypto";
import { PrismaClient } from "../lib/generated/prisma/client.js";
import { config as loadEnvironment } from "dotenv";

import { getDatabaseUrl } from "../database-url.js";
import { resolveHistoricalCandidateRelativePath } from "../packages/domain/src/asset-relative-path-backfill.js";

loadEnvironment({ path: ".env", override: true, quiet: true });
loadEnvironment({ path: ".env.local", override: false, quiet: true });

const databaseUrl = getDatabaseUrl();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: ["error"] });

function pathHash(relativePath: string): string {
  return createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
}

type Group = { datasetId: string; pathHash: string; assetIds: string[] };

function fingerprintOf(groups: Group[]): string {
  // Canonical order: (datasetId, pathHash) ascending, assetIds sorted
  // within each group -- so the fingerprint depends only on true
  // membership, never on query/array order.
  const canonical = groups
    .map((g) => ({ datasetId: g.datasetId, pathHash: g.pathHash, assetIds: [...g.assetIds].sort() }))
    .sort((a, b) => (a.datasetId === b.datasetId ? (a.pathHash < b.pathHash ? -1 : 1) : a.datasetId < b.datasetId ? -1 : 1));
  const serialized = JSON.stringify(canonical);
  return createHash("sha256").update(serialized).digest("hex");
}

async function preGroups(): Promise<Group[]> {
  const rows = await db.$queryRaw<Array<{ id: string; datasetId: string; filename: string; sourcePath: string | null; sourceRootPath: string | null; preparedImportNormalizedPath: string | null }>>`
    SELECT a.id, a."datasetId", a.filename, a."sourcePath", d."sourceRootPath",
           (SELECT pii."normalizedPath" FROM "PreparedImportItem" pii WHERE pii."assetId" = a.id) AS "preparedImportNormalizedPath"
    FROM "Asset" a JOIN "Dataset" d ON d.id = a."datasetId"
    WHERE a."deletedAt" IS NULL
  `;
  const byKey = new Map<string, { datasetId: string; relativePath: string; assetIds: string[] }>();
  for (const row of rows) {
    const outcome = resolveHistoricalCandidateRelativePath({
      preparedImportNormalizedPath: row.preparedImportNormalizedPath, sourcePath: row.sourcePath,
      datasetSourceRootPath: row.sourceRootPath, filename: row.filename,
    });
    if (!outcome.ok) continue; // unnormalizable rows never form a "collision" -- reported separately by the backfill script
    const key = `${row.datasetId}::${outcome.relativePath}`;
    const entry = byKey.get(key) ?? { datasetId: row.datasetId, relativePath: outcome.relativePath, assetIds: [] };
    entry.assetIds.push(row.id);
    byKey.set(key, entry);
  }
  return [...byKey.values()].filter((e) => e.assetIds.length > 1).map((e) => ({ datasetId: e.datasetId, pathHash: pathHash(e.relativePath), assetIds: e.assetIds }));
}

async function postGroups(): Promise<Group[]> {
  const rows = await db.$queryRaw<Array<{ id: string; datasetId: string; relativePath: string }>>`
    SELECT id, "datasetId", "relativePath" FROM "Asset" WHERE "deletedAt" IS NULL AND "relativePath" IS NOT NULL
  `;
  const byKey = new Map<string, { datasetId: string; relativePath: string; assetIds: string[] }>();
  for (const row of rows) {
    const key = `${row.datasetId}::${row.relativePath}`;
    const entry = byKey.get(key) ?? { datasetId: row.datasetId, relativePath: row.relativePath, assetIds: [] };
    entry.assetIds.push(row.id);
    byKey.set(key, entry);
  }
  return [...byKey.values()].filter((e) => e.assetIds.length > 1).map((e) => ({ datasetId: e.datasetId, pathHash: pathHash(e.relativePath), assetIds: e.assetIds }));
}

async function main() {
  const mode = process.argv.includes("--post") ? "post" : "pre";
  const groups = mode === "post" ? await postGroups() : await preGroups();
  const fp = fingerprintOf(groups);
  console.log(`Mode: ${mode}`);
  console.log(`Collision groups: ${groups.length}, colliding assets: ${groups.reduce((n, g) => n + g.assetIds.length, 0)}`);
  console.log(`FINGERPRINT (sha256 of the canonical group set): ${fp}`);
  console.log("Per-group detail (datasetId, truncated pathHash, sorted assetIds -- no raw path values):");
  for (const g of [...groups].sort((a, b) => (a.datasetId === b.datasetId ? (a.pathHash < b.pathHash ? -1 : 1) : a.datasetId < b.datasetId ? -1 : 1))) {
    console.log(`  ${g.datasetId} :: ${g.pathHash} -> ${[...g.assetIds].sort().join(",")}`);
  }
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
