import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Shared, Prisma-free, network-free contracts for one AI pre-annotation
 * operation over one or many Assets (feature 026). Everything here is a
 * pure function or schema so web, worker and tests share one definition.
 */

export const AI_BATCH_SCHEMA_VERSION = 1 as const;

/**
 * Largest batch size actually exercised against the deployed AI Service
 * (verification/provider-contract.md). It is NOT a provider guarantee; it
 * changes only in the same commit as a recorded real run (research.md D-LIM).
 * The effective limit is min(platform selection ceiling, this value).
 */
export const AI_BATCH_VERIFIED_MAX_ASSETS = 3;

/** Phase 022 synchronous selection ceiling; an input-shape ceiling, never a provider claim. */
export const AI_BATCH_PLATFORM_SELECTION_CEILING = 200;

export function effectiveAiBatchLimit(platformCeiling: number = AI_BATCH_PLATFORM_SELECTION_CEILING, verified: number = AI_BATCH_VERIFIED_MAX_ASSETS): number {
  return Math.min(platformCeiling, verified);
}

/* ----------------------------- source identity ----------------------------- */

export type AiSourceIdentityParts = {
  sourceFingerprint: string;
  currentVersionId: string | null;
  sourceRevision: string | null;
  sizeBytes: bigint | number | string | null;
  checksum: string | null;
  cacheChecksum: string | null;
  /** Bucket and key of the object that will be signed; hashed, never stored raw. */
  objectLocator: { bucket: string; key: string } | null;
};

export class AiSourceIdentityUnavailableError extends Error {
  constructor(readonly reason: "FINGERPRINT_MISSING" | "SIZE_MISSING" | "LOCATOR_MISSING") {
    super(`AI_SOURCE_IDENTITY_${reason}`);
    this.name = "AiSourceIdentityUnavailableError";
  }
}

/**
 * Decision D-U1: identity is a digest of stable source metadata. Eligibility
 * needs a fingerprint, a size and a storage locator; a checksum is optional.
 * The digest contains no raw locator, URL or credential.
 */
export function computeAiSourceIdentityDigest(parts: AiSourceIdentityParts): string {
  if (!parts.sourceFingerprint) throw new AiSourceIdentityUnavailableError("FINGERPRINT_MISSING");
  if (parts.sizeBytes === null || parts.sizeBytes === undefined) throw new AiSourceIdentityUnavailableError("SIZE_MISSING");
  if (!parts.objectLocator || !parts.objectLocator.bucket || !parts.objectLocator.key) throw new AiSourceIdentityUnavailableError("LOCATOR_MISSING");
  const canonical = JSON.stringify({
    v: 1,
    fp: parts.sourceFingerprint,
    ver: parts.currentVersionId,
    rev: parts.sourceRevision,
    size: String(parts.sizeBytes),
    sum: parts.checksum,
    csum: parts.cacheChecksum,
    loc: createHash("sha256").update(`${parts.objectLocator.bucket}\u0000${parts.objectLocator.key}`).digest("hex"),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export type AiSourceObjectFields = {
  storageProvider: string | null; storageBucket: string | null; storageKey: string | null;
  cacheProvider: string | null; cacheBucket: string | null; cacheKey: string | null;
  cacheStatus: string | null; cacheExpiresAt: Date | null;
};

/**
 * The single rule for which object is signed for the AI Service: the stored
 * MinIO object when present, otherwise an unexpired cached MinIO object. Web
 * (at acceptance) and worker (at dispatch) must both use this, so the
 * identity digest and the signed object can never disagree.
 */
export function selectAiSourceObject(asset: AiSourceObjectFields, now: Date = new Date()): { bucket: string; key: string } | null {
  if (asset.storageProvider === "MINIO" && asset.storageBucket && asset.storageKey) return { bucket: asset.storageBucket, key: asset.storageKey };
  const cached = asset.cacheProvider === "MINIO" && asset.cacheBucket && asset.cacheKey && asset.cacheStatus === "CACHED" && (!asset.cacheExpiresAt || asset.cacheExpiresAt > now);
  return cached ? { bucket: asset.cacheBucket!, key: asset.cacheKey! } : null;
}

/* ------------------------------- accepted input ------------------------------ */

export const aiTargetModeSchema = z.enum(["CURRENT_ASSET", "EXPLICIT", "FILTERED", "LEGACY_ASSET_IDS"]);
export type AiTargetMode = z.infer<typeof aiTargetModeSchema>;

const idSchema = z.string().min(1).max(128);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const aiBatchTargetSchema = z.object({
  assetId: idSchema,
  inputIndex: z.number().int().min(0),
  sourceIdentityDigest: digestSchema,
}).strict();
export type AiBatchTarget = z.infer<typeof aiBatchTargetSchema>;

/** Versioned, authoritative accepted target/configuration stored in `Job.input`. */
export const aiBatchJobInputV1Schema = z.object({
  schemaVersion: z.literal(AI_BATCH_SCHEMA_VERSION),
  targetMode: aiTargetModeSchema,
  datasetId: idSchema,
  modality: z.enum(["IMAGE", "VIDEO"]),
  modelId: idSchema,
  modelKey: idSchema,
  confidence_threshold: z.number().min(0).max(1),
  iou_threshold: z.number().min(0).max(1),
  classes: z.array(z.string().min(1).max(256)).min(1).max(10000).optional(),
  effectiveLimit: z.number().int().min(1),
  targets: z.array(aiBatchTargetSchema).min(1),
}).strict().superRefine((value, ctx) => {
  if (value.targets.length > value.effectiveLimit) ctx.addIssue({ code: "custom", path: ["targets"], message: "targets exceed the effective limit" });
  if (new Set(value.targets.map((target) => target.assetId)).size !== value.targets.length) ctx.addIssue({ code: "custom", path: ["targets"], message: "duplicate assetId" });
  value.targets.forEach((target, index) => {
    if (target.inputIndex !== index) ctx.addIssue({ code: "custom", path: ["targets", index, "inputIndex"], message: "inputIndex must equal the array position" });
  });
});
export type AiBatchJobInputV1 = z.infer<typeof aiBatchJobInputV1Schema>;

/* ---------------------------- per-Asset outcomes ----------------------------- */

export const aiAssetOutcomeKindSchema = z.enum(["SUCCEEDED", "FAILED", "SKIPPED", "MISSING_RESULT", "CANCELED"]);
export type AiAssetOutcomeKind = z.infer<typeof aiAssetOutcomeKindSchema>;

export const aiPerAssetOutcomeSchema = z.object({
  assetId: idSchema,
  inputIndex: z.number().int().min(0),
  outcome: aiAssetOutcomeKindSchema,
  /** 0 is meaningful: an explicit zero-detection success. */
  predictionCount: z.number().int().min(0),
  reason: z.string().max(64).regex(/^[A-Z][A-Z0-9_]*$/).optional(),
}).strict();
export type AiPerAssetOutcome = z.infer<typeof aiPerAssetOutcomeSchema>;

export type AiOutcomeSummary = {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  canceled: number;
  missing: number;
  /** Decision D-I2: any failed/skipped/missing target makes an uncanceled operation unsuccessful. */
  aggregate: "COMPLETED" | "FAILED" | "CANCELED" | "PENDING";
};

/**
 * Reconciles final outcomes against the accepted targets. Throws unless every
 * accepted target has exactly one outcome (never a silent gap or duplicate).
 */
export function reconcileAiOutcomes(targets: readonly AiBatchTarget[], outcomes: readonly AiPerAssetOutcome[], options: { operationCanceled?: boolean } = {}): AiOutcomeSummary {
  const expected = new Set(targets.map((target) => target.assetId));
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (!expected.has(outcome.assetId)) throw new Error("AI_OUTCOME_UNKNOWN_ASSET");
    if (seen.has(outcome.assetId)) throw new Error("AI_OUTCOME_DUPLICATE_ASSET");
    seen.add(outcome.assetId);
  }
  const count = (kind: AiAssetOutcomeKind) => outcomes.filter((outcome) => outcome.outcome === kind).length;
  const summary = {
    total: targets.length, processed: outcomes.length,
    succeeded: count("SUCCEEDED"), failed: count("FAILED"), skipped: count("SKIPPED"), canceled: count("CANCELED"), missing: count("MISSING_RESULT"),
  };
  if (outcomes.length < targets.length) return { ...summary, aggregate: "PENDING" };
  const aggregate = options.operationCanceled || summary.canceled > 0 ? "CANCELED"
    : summary.failed + summary.skipped + summary.missing > 0 ? "FAILED" : "COMPLETED";
  return { ...summary, aggregate };
}

/* ------------------- provider status and failure sanitization ------------------ */

export type AiProviderStatusClass = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "DEGRADED" | "UNKNOWN";

/**
 * Decision D-FS. An explicit allowlist: `failed_system` is observed as a
 * non-terminal intermediate status and is classified DEGRADED without
 * assuming it is terminal or recoverable; anything unlisted is UNKNOWN and
 * must fail closed.
 */
export function classifyAiProviderStatus(status: unknown): AiProviderStatusClass {
  switch (status) {
    case "create": case "pending": return "PENDING";
    case "inprocess": return "IN_PROGRESS";
    case "success": return "COMPLETED";
    case "failed": return "FAILED";
    case "failed_system": return "DEGRADED";
    default: return "UNKNOWN";
  }
}

/** Decision D-SAN: the only strings that may be persisted or shown for provider-originated failures. */
export const AI_PROVIDER_REASON_CODES = [
  "AI_PROVIDER_REJECTED",
  "AI_PROVIDER_FAILED",
  "AI_PROVIDER_SOURCE_UNREACHABLE",
  "AI_PROVIDER_FAILED_SYSTEM",
  "AI_PROVIDER_STATUS_UNKNOWN",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_SUBMISSION_AMBIGUOUS",
] as const;
export type AiProviderReasonCode = (typeof AI_PROVIDER_REASON_CODES)[number];

const SAFE_MESSAGES: Record<AiProviderReasonCode, string> = {
  AI_PROVIDER_REJECTED: "The AI service rejected the request.",
  AI_PROVIDER_FAILED: "The AI service could not complete the request.",
  AI_PROVIDER_SOURCE_UNREACHABLE: "The AI service could not read one of the source files.",
  AI_PROVIDER_FAILED_SYSTEM: "The AI service reported a system failure and did not recover in time.",
  AI_PROVIDER_STATUS_UNKNOWN: "The AI service returned an unrecognized status.",
  AI_PROVIDER_UNAVAILABLE: "The AI service is unavailable.",
  AI_SUBMISSION_AMBIGUOUS: "The submission outcome is unknown; work may already exist at the AI service.",
};

export function isAiProviderReasonCode(value: unknown): value is AiProviderReasonCode {
  return typeof value === "string" && (AI_PROVIDER_REASON_CODES as readonly string[]).includes(value);
}

export function safeAiProviderMessage(code: AiProviderReasonCode): string {
  return SAFE_MESSAGES[code];
}

/**
 * Maps a provider failure to an allowlisted code from structural facts only
 * (HTTP status, provider status). Error text is deliberately not an input:
 * provider errors can contain signed URLs and are never parsed or persisted.
 */
export function sanitizeAiProviderFailure(facts: { httpStatus?: number; providerStatus?: unknown; timedOut?: boolean; unreadable?: boolean }): AiProviderReasonCode {
  if (facts.providerStatus !== undefined) {
    const cls = classifyAiProviderStatus(facts.providerStatus);
    if (cls === "DEGRADED") return "AI_PROVIDER_FAILED_SYSTEM";
    if (cls === "UNKNOWN") return "AI_PROVIDER_STATUS_UNKNOWN";
    if (cls === "FAILED") return "AI_PROVIDER_FAILED";
  }
  if (facts.timedOut || facts.unreadable) return "AI_PROVIDER_UNAVAILABLE";
  if (typeof facts.httpStatus === "number" && facts.httpStatus >= 400 && facts.httpStatus < 500) return "AI_PROVIDER_REJECTED";
  return "AI_PROVIDER_UNAVAILABLE";
}

/**
 * Decision D-NI: the deployed provider is non-idempotent and offers no
 * lookup, so a failed operation may be retried only when it is *definitely*
 * known that no external task exists: no external id was recorded, and either
 * no submission reservation was ever written (a dispatch-time failure) or the
 * provider answered the create call with a 4xx refusal. Any other outcome
 * (timeout, reset, 5xx, unparseable body, crash after reservation) is
 * ambiguous, and an operation with a recorded external task is not a
 * resubmission candidate.
 */
export function isDefinitelyNotSubmitted(task: { externalTaskId: string | null; summary: unknown; errorCode: string | null }): boolean {
  if (task.externalTaskId) return false;
  const summary = task.summary && typeof task.summary === "object" && !Array.isArray(task.summary) ? (task.summary as Record<string, unknown>) : {};
  const reserved = summary.aiozSubmission !== undefined;
  return !reserved || task.errorCode === "AIOZ_HTTP_4XX";
}
