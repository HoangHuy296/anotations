/**
 * Release-owner approval step (offline: no database, no storage). Derives the approved-ID manifest from a T029 observed manifest and an explicit
 * list of Dataset ids. Usage: backfill-approve.ts <observed.json> <ids.txt> <out.json> <approver> <statement>
 * Appearing in the observed manifest is never approval; only ids listed here are approved, and each must be an observed candidate.
 */
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { deriveApprovedManifest } from "@/lib/datasets/modality-backfill-evidence";

const [observedPath, idsPath, outPath, approver, statement] = process.argv.slice(2);
try {
  if (!observedPath || !idsPath || !outPath || !approver || !statement) throw new Error("USAGE");
  const approvedIds = readFileSync(idsPath, "utf8").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const approved = deriveApprovedManifest({ observed: JSON.parse(readFileSync(observedPath, "utf8")), approvedIds, approver, approvedAt: new Date().toISOString(), statement });
  const fd = openSync(outPath, "wx", 0o400);
  try { writeSync(fd, JSON.stringify(approved, null, 2) + "\n"); } finally { closeSync(fd); }
  console.log(JSON.stringify({ ok: true, approvedIds: approved.approvedIds.length, sha256: approved.sha256 }));
} catch (error) {
  console.error("BACKFILL_APPROVE_FAILED", /^[A-Z][A-Z0-9_]+$/.test((error as Error)?.message ?? "") ? (error as Error).message : "UNEXPECTED_FAILURE");
  process.exitCode = 1;
}
