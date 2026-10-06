/**
 * Maintenance child for T029 (`observe`) and T031 (`apply`). Started ONLY by scripts/db-safety/backfill-launcher.mjs, which has already verified
 * the database and storage targets, the migration history and every implementation hash, and which provides the environment below.
 * Run it by hand and it refuses: every input must be present and consistent.
 */
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { db } from "@/lib/db";
import { applyApprovedBackfill, buildBackfillManifest } from "@/lib/datasets/modality-backfill";
import { createMinioStatObject, createStorageClient, describeStorage } from "@/lib/datasets/modality-backfill-storage";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const need = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`BACKFILL_ENV_MISSING`); return value; };
function writeImmutable(dir: string, name: string, text: string) {
  const fd = openSync(join(dir, name), "wx", 0o400);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  return sha256(text);
}
function readPinned(path: string, expected: string) {
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expected) throw new Error("MANIFEST_FILE_HASH_MISMATCH");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

async function main() {
  const operation = need("BACKFILL_OPERATION");
  const evidenceDir = need("BACKFILL_EVIDENCE_DIR");
  const bucket = need("STORAGE_BUCKET");
  const client = createStorageClient({ endpoint: need("STORAGE_ENDPOINT"), accessKey: need("STORAGE_ACCESS_KEY"), secretKey: need("STORAGE_SECRET_KEY"), region: process.env.STORAGE_REGION || undefined });
  const statObject = createMinioStatObject(client);
  if (operation === "identity") {
    // Launcher pre-check: where the storage is and whether the configured bucket answers. No database access, no object access.
    try { console.log(JSON.stringify(await describeStorage({ endpoint: need("STORAGE_ENDPOINT"), accessKey: need("STORAGE_ACCESS_KEY"), secretKey: need("STORAGE_SECRET_KEY"), region: process.env.STORAGE_REGION || undefined }, bucket, client))); }
    catch { throw new Error("STORAGE_UNAVAILABLE"); }
    return 0;
  }
  if (operation === "observe") {
    const manifest = await buildBackfillManifest({ client: db, statObject, expectedBucket: bucket });
    const fileSha256 = writeImmutable(evidenceDir, "observed-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    console.log(JSON.stringify({ operation, ok: true, candidates: manifest.candidates.length, rejected: manifest.rejected.length, manifestSha256: manifest.manifestSha256, fileSha256 }));
    return 0;
  }
  if (operation === "apply") {
    const observed = readPinned(need("BACKFILL_OBSERVED_PATH"), need("BACKFILL_OBSERVED_SHA256"));
    const approved = readPinned(need("BACKFILL_APPROVED_PATH"), need("BACKFILL_APPROVED_SHA256"));
    const { run, lineage } = await applyApprovedBackfill({ client: db, observed, approved, runToken: need("BACKFILL_RUN_TOKEN"), statObject });
    const fileSha256 = writeImmutable(evidenceDir, "result.json", JSON.stringify({ lineage, run }, null, 2) + "\n");
    console.log(JSON.stringify({ operation, ok: run.status === "COMPLETED", status: run.status, counts: run.counts, lineage, fileSha256 }));
    return run.status === "COMPLETED" ? 0 : 3;
  }
  throw new Error("BACKFILL_OPERATION_INVALID");
}

main().then(code => { process.exitCode = code; }, error => {
  // Only a fixed code is printed: database, storage and path details never reach the output.
  console.error("BACKFILL_RUN_FAILED", /^[A-Z][A-Z0-9_]+$/.test((error as Error)?.message ?? "") ? (error as Error).message : "UNEXPECTED_FAILURE");
  process.exitCode = 1;
}).finally(() => db.$disconnect());
