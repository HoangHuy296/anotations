import { createHash } from "node:crypto";
import { z } from "zod";
import { datasetModalitySchema, type DatasetModality } from "@annotationplatform/domain";

/**
 * T029/T031 pure evidence rules for the historical SINGLE-modality backfill (Phase 029).
 *
 * Authority is the Dataset's own Asset rows plus the stored objects' metadata. The legacy `primaryModality`
 * field is deliberately absent from every type in this file: it is never read, compared or copied.
 * See specs/029-modality-specific-datasets/release/t031-fence-semantics.md for the database semantics this relies on.
 */

/** Columns the Asset write trigger treats as evidence (migration 24 lines 72–86), plus identity, soft-delete and subtype presence. */
export const ASSET_EVIDENCE_SELECT = {
  id: true, datasetId: true, modality: true, sourceMode: true, storageProvider: true, storageBucket: true, storageKey: true, checksum: true,
  externalRepositoryId: true, sourceProvider: true, sourceRef: true, sourceRevision: true, sourcePath: true, relativePath: true,
  sourceFileSha: true, sourceBlobSha: true, sourceLfsOid: true, sourceEtag: true, sourceUrl: true, sourceFingerprint: true, currentVersionId: true,
  mimeType: true, sizeBytes: true, width: true, height: true, durationMs: true, textLength: true, deletedAt: true,
  imageAsset: { select: { assetId: true } }, videoAsset: { select: { assetId: true } }, audioAsset: { select: { assetId: true } }, textAsset: { select: { assetId: true } },
} as const;

const EVIDENCE_FIELDS = [
  "id", "datasetId", "modality", "sourceMode", "storageProvider", "storageBucket", "storageKey", "checksum", "externalRepositoryId",
  "sourceProvider", "sourceRef", "sourceRevision", "sourcePath", "relativePath", "sourceFileSha", "sourceBlobSha", "sourceLfsOid",
  "sourceEtag", "sourceUrl", "sourceFingerprint", "currentVersionId", "mimeType", "sizeBytes", "width", "height", "durationMs", "textLength",
] as const;

type Scalar = string | number | bigint | boolean | Date | null;
export type AssetEvidenceRow = {
  [K in (typeof EVIDENCE_FIELDS)[number]]: Scalar;
} & {
  id: string; datasetId: string; modality: DatasetModality; sizeBytes: bigint | null; storageProvider: string | null; storageBucket: string | null;
  storageKey: string | null; sourceEtag: string | null; deletedAt: Date | null;
  imageAsset: { assetId: string } | null; videoAsset: { assetId: string } | null; audioAsset: { assetId: string } | null; textAsset: { assetId: string } | null;
};

export type DatasetEvidence = {
  id: string;
  live: boolean;
  modality: DatasetModality | null;
  revision: bigint;
  inflight: boolean;
  assets: readonly AssetEvidenceRow[];
};
export type ObjectObservation = { size: bigint; etag: string | null };
/** Injected storage metadata read (HEAD/stat style). Returns null when the object does not exist. Never reads object bytes. */
export type StatObject = (bucket: string, key: string) => Promise<ObjectObservation | null>;
export type BackfillPolicy = { expectedBucket: string };

export const REJECT_CODES = [
  "DATASET_NOT_LIVE", "DATASET_ALREADY_RESOLVED", "EMPTY_DATASET", "MIXED_MODALITY", "INFLIGHT_WORK_PRESENT", "SOFT_DELETED_ASSET_PRESENT",
  "ASSET_SUBTYPE_MISSING", "ASSET_SUBTYPE_MISMATCH", "STORAGE_REFERENCE_UNSUPPORTED", "BUCKET_NOT_APPROVED", "SIZE_UNRECORDED",
  "OBJECT_MISSING", "SIZE_MISMATCH", "ETAG_MISMATCH",
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export const STOP_CODES = [
  ...REJECT_CODES, "STALE_DATASET_FENCE", "ASSET_EVIDENCE_CHANGED", "MANIFEST_INVALID", "SERIALIZATION_EXHAUSTED", "OBJECT_CHECK_FAILED", "DATABASE_REJECTED",
] as const;
export type StopCode = (typeof STOP_CODES)[number];

// ---------------------------------------------------------------- canonical JSON and digests
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonicalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function subtypesOf(asset: AssetEvidenceRow): DatasetModality[] {
  const present: DatasetModality[] = [];
  if (asset.imageAsset) present.push("IMAGE");
  if (asset.videoAsset) present.push("VIDEO");
  if (asset.audioAsset) present.push("AUDIO");
  if (asset.textAsset) present.push("TEXT");
  return present;
}

/** Deterministic digest of every Asset row of the Dataset (including soft-deleted), independent of read order. */
export function assetEvidenceDigest(assets: readonly AssetEvidenceRow[]): string {
  const rows = [...assets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(asset => ({
    ...Object.fromEntries(EVIDENCE_FIELDS.map(field => [field, asset[field]])),
    deletedAt: asset.deletedAt,
    subtypes: subtypesOf(asset),
  }));
  return sha256(canonicalJson(rows));
}

// ---------------------------------------------------------------- classification (database evidence only)
export type Classification = { ok: true; modality: DatasetModality } | { ok: false; code: RejectCode };
const reject = (code: RejectCode): Classification => ({ ok: false, code });

/** SINGLE modality from authoritative Asset evidence. EMPTY, MIXED, inconsistent, insufficient and non-live Datasets are rejected. */
export function classifyDatasetEvidence(dataset: DatasetEvidence, policy: BackfillPolicy): Classification {
  if (!dataset.live) return reject("DATASET_NOT_LIVE");
  if (dataset.modality !== null) return reject("DATASET_ALREADY_RESOLVED");
  if (dataset.assets.length === 0) return reject("EMPTY_DATASET");
  const modalities = new Set(dataset.assets.map(asset => asset.modality));
  if (modalities.size > 1) return reject("MIXED_MODALITY");
  if (dataset.inflight) return reject("INFLIGHT_WORK_PRESENT");
  if (dataset.assets.some(asset => asset.deletedAt !== null)) return reject("SOFT_DELETED_ASSET_PRESENT");
  for (const asset of dataset.assets) {
    const subtypes = subtypesOf(asset);
    if (subtypes.length === 0) return reject("ASSET_SUBTYPE_MISSING");
    if (subtypes.length !== 1 || subtypes[0] !== asset.modality) return reject("ASSET_SUBTYPE_MISMATCH");
    if (asset.storageProvider !== "MINIO" || !asset.storageBucket || !asset.storageKey) return reject("STORAGE_REFERENCE_UNSUPPORTED");
    if (asset.storageBucket !== policy.expectedBucket) return reject("BUCKET_NOT_APPROVED");
    if (asset.sizeBytes === null) return reject("SIZE_UNRECORDED");
  }
  const [modality] = modalities;
  return { ok: true, modality: datasetModalitySchema.parse(modality) };
}

const normalizeEtag = (etag: string) => etag.replace(/^W\//, "").replace(/^"|"$/g, "").toLowerCase();

/** Object metadata rule (D-3): existence and size; the recorded ETag only when the Asset records one. No byte reads, no invented ETag/version requirement. */
export function verifyObjectObservation(asset: AssetEvidenceRow, observation: ObjectObservation | null): RejectCode | null {
  if (observation === null) return "OBJECT_MISSING";
  if (asset.sizeBytes === null || observation.size !== asset.sizeBytes) return "SIZE_MISMATCH";
  if (asset.sourceEtag !== null) {
    if (observation.etag === null || normalizeEtag(observation.etag) !== normalizeEtag(asset.sourceEtag)) return "ETAG_MISMATCH";
  }
  return null;
}

/** Stats every Asset object (sequentially, metadata only). Returns the first rejection code or the observations in Asset-id order. */
export async function observeObjects(assets: readonly AssetEvidenceRow[], statObject: StatObject): Promise<{ ok: true; objects: ManifestObject[] } | { ok: false; code: RejectCode | "OBJECT_CHECK_FAILED" }> {
  const objects: ManifestObject[] = [];
  for (const asset of [...assets].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    let observation: ObjectObservation | null;
    try { observation = await statObject(asset.storageBucket as string, asset.storageKey as string); }
    catch { return { ok: false, code: "OBJECT_CHECK_FAILED" }; }
    const failure = verifyObjectObservation(asset, observation);
    if (failure) return { ok: false, code: failure };
    objects.push({ assetId: asset.id, size: (observation as ObjectObservation).size.toString(), etag: (observation as ObjectObservation).etag });
  }
  return { ok: true, objects };
}

// ---------------------------------------------------------------- manifest
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const manifestObjectSchema = z.object({ assetId: z.string().min(1), size: z.string().regex(/^\d+$/), etag: z.string().nullable() }).strict();
export type ManifestObject = z.infer<typeof manifestObjectSchema>;
export const manifestCandidateSchema = z.object({
  datasetId: z.string().min(1),
  modality: datasetModalitySchema,
  datasetRevision: z.string().regex(/^\d+$/),
  assetCount: z.number().int().min(1),
  assetEvidenceDigest: hex64,
  objects: z.array(manifestObjectSchema).min(1),
}).strict();
export type ManifestCandidate = z.infer<typeof manifestCandidateSchema>;
export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("dataset-modality-backfill-manifest"),
  generatedAt: z.iso.datetime(),
  policy: z.object({ expectedBucket: z.string().min(1) }).strict(),
  candidates: z.array(manifestCandidateSchema),
  rejected: z.array(z.object({ datasetId: z.string().min(1), code: z.enum(REJECT_CODES) }).strict()),
  approvedIdsDigest: hex64,
  manifestSha256: hex64,
}).strict();
export type BackfillManifest = z.infer<typeof manifestSchema>;

export const approvedIdsDigest = (ids: readonly string[]) => sha256(canonicalJson([...ids].sort()));
const manifestBody = (m: { schemaVersion: 1; kind: "dataset-modality-backfill-manifest"; policy: { expectedBucket: string }; candidates: readonly ManifestCandidate[] }) =>
  canonicalJson({ schemaVersion: m.schemaVersion, kind: m.kind, policy: m.policy, candidates: m.candidates });

export function sealManifest(input: { generatedAt: string; policy: BackfillPolicy; candidates: ManifestCandidate[]; rejected: { datasetId: string; code: RejectCode }[] }): BackfillManifest {
  const candidates = [...input.candidates].sort((a, b) => (a.datasetId < b.datasetId ? -1 : 1));
  const rejected = [...input.rejected].sort((a, b) => (a.datasetId < b.datasetId ? -1 : a.datasetId > b.datasetId ? 1 : 0));
  const body = { schemaVersion: 1 as const, kind: "dataset-modality-backfill-manifest" as const, policy: input.policy, candidates };
  return manifestSchema.parse({ ...body, generatedAt: input.generatedAt, rejected, approvedIdsDigest: approvedIdsDigest(candidates.map(c => c.datasetId)), manifestSha256: sha256(manifestBody(body)) });
}

/** Fails closed: unknown keys, a modified candidate, unsorted or duplicate Dataset ids, or a wrong digest all throw `MANIFEST_INVALID`. */
export function verifyManifest(raw: unknown): BackfillManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("MANIFEST_INVALID");
  const manifest = parsed.data;
  const ids = manifest.candidates.map(candidate => candidate.datasetId);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1] >= id)) throw new Error("MANIFEST_INVALID");
  if (manifest.manifestSha256 !== sha256(manifestBody(manifest)) || manifest.approvedIdsDigest !== approvedIdsDigest(ids)) throw new Error("MANIFEST_INVALID");
  for (const candidate of manifest.candidates) {
    const objectIds = candidate.objects.map(object => object.assetId);
    if (objectIds.length !== candidate.assetCount || new Set(objectIds).size !== objectIds.length) throw new Error("MANIFEST_INVALID");
  }
  return manifest;
}

// ---------------------------------------------------------------- subject and accounting
const RUN_TOKEN = /^[a-z0-9][a-z0-9-]{6,62}[a-z0-9]$/;
export const BACKFILL_SUBJECT_PREFIX = "system:phase029-backfill:";
/** Opaque receipt subject (D-6). Never an actor id; at most 128 characters including the prefix. */
export function backfillSubject(runToken: string): string {
  if (!RUN_TOKEN.test(runToken)) throw new Error("RUN_TOKEN_INVALID");
  return `${BACKFILL_SUBJECT_PREFIX}${runToken}`;
}

export type CandidateOutcome =
  | { datasetId: string; status: "COMMITTED" | "COMMITTED_REPLAY"; modality: DatasetModality; resolvedAt: string; subject: string; revisionBefore: string; revisionAfter: string }
  | { datasetId: string; status: "STOPPED"; code: StopCode }
  | { datasetId: string; status: "NOT_ATTEMPTED" };
export type RunResult = {
  status: "COMPLETED" | "STOPPED";
  runToken: string;
  manifestSha256: string;
  counts: { candidates: number; committed: number; replayed: number; stopped: number; notAttempted: number };
  outcomes: CandidateOutcome[];
};
/** Deterministic accounting: outcomes are in manifest order and the counts always add up. */
export function summarizeRun(manifest: BackfillManifest, runToken: string, outcomes: readonly CandidateOutcome[]): RunResult {
  const counts = { candidates: manifest.candidates.length, committed: 0, replayed: 0, stopped: 0, notAttempted: 0 };
  for (const outcome of outcomes) {
    if (outcome.status === "COMMITTED") counts.committed += 1;
    else if (outcome.status === "COMMITTED_REPLAY") counts.replayed += 1;
    else if (outcome.status === "STOPPED") counts.stopped += 1;
    else counts.notAttempted += 1;
  }
  const consistent = outcomes.length === counts.candidates && outcomes.every((outcome, index) => outcome.datasetId === manifest.candidates[index]?.datasetId);
  if (!consistent || counts.committed + counts.replayed + counts.stopped + counts.notAttempted !== counts.candidates || counts.stopped > 1) throw new Error("ACCOUNTING_INCONSISTENT");
  return { status: counts.stopped === 0 && counts.notAttempted === 0 ? "COMPLETED" : "STOPPED", runToken, manifestSha256: manifest.manifestSha256, counts, outcomes: [...outcomes] };
}
