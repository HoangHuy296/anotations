import "server-only";
import { isModalityTransactionConflict, retryModalityTransaction } from "@annotationplatform/domain";
import { Prisma } from "@internal/db";
import { db } from "@/lib/db";
import {
  ASSET_EVIDENCE_SELECT, assetEvidenceDigest, backfillSubject, classifyDatasetEvidence, observeObjects, sealManifest, selectApprovedCandidates, summarizeRun, verifyManifest,
  type AssetEvidenceRow, type BackfillManifest, type CandidateOutcome, type DatasetEvidence, type ManifestCandidate, type RejectCode, type RunResult, type StatObject, type StopCode,
} from "./modality-backfill-evidence";

/**
 * T029 (manifest) and T031 (assignment) for the historical SINGLE-modality backfill.
 *
 * Authority: evidence only. There is no actor, no route and no UI: the caller is a receipt-bound maintenance runner that stays stopped until
 * a separate G-DATA approval. This is not `resolveEmptyDataset` (the owner/ADMIN path for EMPTY Datasets) and it never reads `primaryModality`.
 * Database semantics relied on: specs/029-modality-specific-datasets/release/t031-fence-semantics.md.
 */
type Client = typeof db;
type Tx = Prisma.TransactionClient;
const NON_TERMINAL_JOB = ["QUEUED", "RUNNING", "RETRYING", "CANCELING"] as const;

async function readEvidence(client: Client | Tx, datasetId: string): Promise<DatasetEvidence | null> {
  const dataset = await client.dataset.findUnique({ where: { id: datasetId }, select: { id: true, modality: true, modalityContentRevision: true, deletedAt: true, archivedAt: true } });
  if (!dataset) return null;
  const assets = (await client.asset.findMany({ where: { datasetId }, select: ASSET_EVIDENCE_SELECT, orderBy: { id: "asc" } })) as unknown as AssetEvidenceRow[];
  const jobs = await client.job.count({ where: { datasetId, status: { in: [...NON_TERMINAL_JOB] } } });
  const preparing = await client.preparedImport.count({ where: { datasetId, status: "PREPARING" } });
  return { id: dataset.id, live: dataset.deletedAt === null && dataset.archivedAt === null, modality: dataset.modality, revision: dataset.modalityContentRevision, inflight: jobs + preparing > 0, assets };
}

// ============================================================ T029 — select-only manifest
/**
 * Reads every Dataset (select-only: findMany/findUnique/count, no write call exists in this function), classifies it from its own Asset evidence,
 * verifies object metadata through the injected stat (no byte reads) and returns a sealed manifest of eligible Datasets plus every rejection with its code.
 * Per-Dataset database reads share one RepeatableRead snapshot; object metadata is read after it, outside the transaction.
 */
export async function buildBackfillManifest(input: { client?: Client; statObject: StatObject; expectedBucket: string; now?: () => Date }): Promise<BackfillManifest> {
  const client = input.client ?? db;
  const policy = { expectedBucket: input.expectedBucket };
  const ids = (await client.dataset.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(row => row.id);
  const candidates: ManifestCandidate[] = [];
  const rejected: { datasetId: string; code: RejectCode }[] = [];
  for (const datasetId of ids) {
    const evidence = await client.$transaction(tx => readEvidence(tx, datasetId), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    if (!evidence) continue;
    const verdict = classifyDatasetEvidence(evidence, policy);
    if (!verdict.ok) { rejected.push({ datasetId, code: verdict.code }); continue; }
    const observed = await observeObjects(evidence.assets, input.statObject);
    if (!observed.ok) { rejected.push({ datasetId, code: observed.code === "OBJECT_CHECK_FAILED" ? "OBJECT_MISSING" : observed.code }); continue; }
    candidates.push({ datasetId, modality: verdict.modality, datasetRevision: evidence.revision.toString(), assetCount: evidence.assets.length, assetEvidenceDigest: assetEvidenceDigest(evidence.assets), objects: observed.objects });
  }
  return sealManifest({ generatedAt: (input.now?.() ?? new Date()).toISOString(), policy, candidates, rejected });
}

// ============================================================ T031 — approved-ID execution
export type ApprovalLineage = { observedManifestSha256: string; approvedManifestSha256: string; approvedIdsDigest: string; executedManifestSha256: string };
/**
 * Executes only what the release owner approved. Both manifests are verified first (throws before any database access); the executed set is the
 * observed candidates named by the approved manifest, so a Dataset that merely appeared in the observed manifest is never mutated.
 */
export async function applyApprovedBackfill(input: {
  client?: Client; observed: unknown; approved: unknown; runToken: string; statObject: StatObject; signal?: AbortSignal; testPoint?: (point: BackfillTestPoint, datasetId: string) => Promise<void>;
}): Promise<{ run: RunResult; lineage: ApprovalLineage }> {
  const { observed, approved, executed } = selectApprovedCandidates(input.observed, input.approved);
  const run = await applyBackfillManifest({ client: input.client, manifest: executed, runToken: input.runToken, statObject: input.statObject, signal: input.signal, testPoint: input.testPoint });
  return { run, lineage: { observedManifestSha256: observed.manifestSha256, approvedManifestSha256: approved.sha256, approvedIdsDigest: approved.approvedIdsDigest, executedManifestSha256: executed.manifestSha256 } };
}

// ============================================================ T031 — evidence-bound assignment
class Stop extends Error {
  constructor(readonly code: StopCode) { super(code); }
}
export type BackfillTestPoint = "BEFORE_TRANSACTION" | "AFTER_CLAIM" | "BEFORE_ASSIGN";

/**
 * Applies an approved manifest. One Serializable transaction per Dataset, in manifest order, stopping at the first failure:
 *  1. compare-and-swap claim of the parent fence against the MANIFEST revision (no `+1` arithmetic is assumed),
 *  2. re-read all Asset rows under the Dataset row lock and require the manifest digest,
 *  3. re-check in-flight work, 4. assign `modality` + opaque receipt subject (the database trigger repeats the all-Asset equality check).
 * Object metadata is re-verified before the transaction. A stop rolls back that Dataset entirely; earlier commits are final (immutable by trigger).
 */
export async function applyBackfillManifest(input: {
  client?: Client; manifest: unknown; runToken: string; statObject: StatObject; signal?: AbortSignal; testPoint?: (point: BackfillTestPoint, datasetId: string) => Promise<void>;
}): Promise<RunResult> {
  const manifest = verifyManifest(input.manifest); // throws MANIFEST_INVALID before any database access
  const subject = backfillSubject(input.runToken); // throws RUN_TOKEN_INVALID
  const client = input.client ?? db;
  const policy = manifest.policy;
  const outcomes: CandidateOutcome[] = [];
  let halted = false;

  for (const candidate of manifest.candidates) {
    if (halted || input.signal?.aborted) { halted = true; outcomes.push({ datasetId: candidate.datasetId, status: "NOT_ATTEMPTED" }); continue; }
    try {
      outcomes.push(await processCandidate(client, candidate, policy, subject, input));
    } catch (error) {
      halted = true;
      outcomes.push({ datasetId: candidate.datasetId, status: "STOPPED", code: error instanceof Stop ? error.code : isModalityTransactionConflict(error) ? "SERIALIZATION_EXHAUSTED" : "DATABASE_REJECTED" });
    }
  }
  return summarizeRun(manifest, input.runToken, outcomes);
}

async function processCandidate(client: Client, candidate: ManifestCandidate, policy: { expectedBucket: string }, subject: string, input: Parameters<typeof applyBackfillManifest>[0]): Promise<CandidateOutcome> {
  // Idempotent replay of an interrupted run: this exact subject already assigned this exact modality.
  const current = await client.dataset.findUnique({ where: { id: candidate.datasetId }, select: { modality: true, modalityResolverSubject: true, modalityResolvedAt: true, modalityContentRevision: true } });
  if (!current) throw new Stop("DATASET_NOT_LIVE");
  if (current.modality !== null) {
    if (current.modality === candidate.modality && current.modalityResolverSubject === subject && current.modalityResolvedAt) {
      return { datasetId: candidate.datasetId, status: "COMMITTED_REPLAY", modality: candidate.modality, resolvedAt: current.modalityResolvedAt.toISOString(), subject, revisionBefore: candidate.datasetRevision, revisionAfter: current.modalityContentRevision.toString() };
    }
    throw new Stop("DATASET_ALREADY_RESOLVED");
  }

  // Object metadata outside any database lock: the stored objects must still match what the manifest approved.
  const before = await readEvidence(client, candidate.datasetId);
  if (!before) throw new Stop("DATASET_NOT_LIVE");
  const observed = await observeObjects(before.assets, input.statObject);
  if (!observed.ok) throw new Stop(observed.code);
  if (JSON.stringify(observed.objects) !== JSON.stringify(candidate.objects)) throw new Stop("ASSET_EVIDENCE_CHANGED");
  await input.testPoint?.("BEFORE_TRANSACTION", candidate.datasetId);

  const expectedRevision = BigInt(candidate.datasetRevision);
  return retryModalityTransaction(() => client.$transaction(async tx => {
    const claim = await tx.dataset.updateMany({
      where: { id: candidate.datasetId, modality: null, deletedAt: null, archivedAt: null, modalityContentRevision: expectedRevision },
      data: { modalityContentRevision: { increment: 1 } },
    });
    if (claim.count !== 1) {
      const now = await tx.dataset.findUnique({ where: { id: candidate.datasetId }, select: { modality: true, deletedAt: true, archivedAt: true } });
      throw new Stop(!now || now.deletedAt !== null || now.archivedAt !== null ? "DATASET_NOT_LIVE" : now.modality !== null ? "DATASET_ALREADY_RESOLVED" : "STALE_DATASET_FENCE");
    }
    await input.testPoint?.("AFTER_CLAIM", candidate.datasetId);
    const locked = await readEvidence(tx, candidate.datasetId);
    if (!locked) throw new Stop("DATASET_NOT_LIVE");
    if (locked.assets.length !== candidate.assetCount || assetEvidenceDigest(locked.assets) !== candidate.assetEvidenceDigest) throw new Stop("ASSET_EVIDENCE_CHANGED");
    const verdict = classifyDatasetEvidence({ ...locked, modality: null }, policy);
    if (!verdict.ok) throw new Stop(verdict.code);
    if (verdict.modality !== candidate.modality) throw new Stop("ASSET_EVIDENCE_CHANGED");
    await input.testPoint?.("BEFORE_ASSIGN", candidate.datasetId);
    const assigned = await tx.dataset.update({ where: { id: candidate.datasetId }, data: { modality: candidate.modality, modalityResolverSubject: subject }, select: { modality: true, modalityResolverSubject: true, modalityResolvedAt: true, modalityContentRevision: true } });
    if (assigned.modality !== candidate.modality || assigned.modalityResolverSubject !== subject || !assigned.modalityResolvedAt) throw new Stop("DATABASE_REJECTED");
    return { datasetId: candidate.datasetId, status: "COMMITTED" as const, modality: candidate.modality, resolvedAt: assigned.modalityResolvedAt.toISOString(), subject, revisionBefore: candidate.datasetRevision, revisionAfter: assigned.modalityContentRevision.toString() };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
