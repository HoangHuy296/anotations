import type { Client as MinioClient } from "minio";

import { logStorageEvent } from "@annotationplatform/domain";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { GC_LOCK_KEYS, withAdvisoryLock } from "./gc-coordination.js";

/**
 * Shared storage garbage-collection primitive
 * (021-production-hardening-garbage-collection, User Story 4).
 *
 * Generalizes the "list a prefix → check DB reference → delete if none"
 * shape already used by `apps/web/src/lib/imports/import-cleanup.ts`
 * (`cleanupPreparedImportOrphans`) into one reusable, prefix-parameterized,
 * dry-run-capable, grace-period-gated sweep. Powers the MinIO orphan
 * scanner, deleted-asset cleanup, deleted-dataset cleanup, and temp-upload
 * cleanup — one tested primitive instead of four bespoke implementations.
 *
 * Does NOT replace `apps/worker/src/media/minio-compensation.ts`
 * (`cleanupUnreferencedMediaDerivative`), which already correctly handles
 * the narrower `media-derivatives/{assetId}/` scope with its own
 * asset-scoped guard — that mechanism is reused as-is, not duplicated here.
 */

export type ReferenceChecker = (input: { db: PrismaClient; bucket: string; key: string }) => Promise<boolean>;

/**
 * Every storage-key-bearing table in the schema, not just `Asset`. A scanner
 * that only checked `Asset.storageKey` would risk deleting a real export
 * artifact (`Job.resultStorageKey`), an AI task result
 * (`AiTask.resultStorageKey`), a historical version snapshot or its cache
 * mirror (`AssetVersion.storageKey`/`cacheKey`), a generated waveform
 * (`AudioAsset.waveformKey`), a cached mirror of the live asset
 * (`Asset.cacheKey`), or an in-progress import item
 * (`PreparedImportItem.storageKey`) — each is checked independently so the
 * scanner is safe to run across the whole bucket, not just one known
 * prefix. `deletedAt: null` is applied only where the schema defines that
 * field (`Asset`) — a soft-deleted Asset must NOT protect its own object,
 * that is exactly what makes it eligible for cleanup.
 */
export const defaultReferenceCheckers: ReferenceChecker[] = [
  async ({ db, bucket, key }) => Boolean(await db.asset.findFirst({ where: { storageBucket: bucket, storageKey: key, deletedAt: null }, select: { id: true } })),
  async ({ db, bucket, key }) => Boolean(await db.asset.findFirst({ where: { cacheBucket: bucket, cacheKey: key, deletedAt: null }, select: { id: true } })),
  async ({ db, bucket, key }) => Boolean(await db.assetVersion.findFirst({ where: { storageBucket: bucket, storageKey: key }, select: { id: true } })),
  async ({ db, bucket, key }) => Boolean(await db.assetVersion.findFirst({ where: { cacheBucket: bucket, cacheKey: key }, select: { id: true } })),
  // AudioAsset has no independent bucket field — it shares its parent
  // Asset's bucket, matching minio-compensation.ts's existing check.
  async ({ db, key }) => Boolean(await db.audioAsset.findFirst({ where: { waveformKey: key }, select: { id: true } })),
  async ({ db, key }) => Boolean(await db.job.findFirst({ where: { resultStorageKey: key }, select: { id: true } })),
  async ({ db, key }) => Boolean(await db.aiTask.findFirst({ where: { resultStorageKey: key }, select: { id: true } })),
  // Deliberately narrower than "any PreparedImportItem row with this key":
  // a completed item (assetId set) is already covered by the Asset check
  // above — publishing never renames the key — and is kept here only for
  // defense-in-depth. An *incomplete* item only protects its object while
  // its PreparedImport is still genuinely active (PREPARING, deadline not
  // yet passed). Without this narrowing, an abandoned/expired import's
  // leftover item rows — which nothing ever deletes — would protect their
  // objects forever, defeating temp-upload cleanup (FR-030) entirely.
  async ({ db, key }) => Boolean(await db.preparedImportItem.findFirst({
    where: {
      storageKey: key,
      OR: [
        { assetId: { not: null } },
        { preparedImport: { status: "PREPARING", deadlineAt: { gt: new Date() } } },
      ],
    },
    select: { id: true },
  })),
];

async function isReferenced(db: PrismaClient, bucket: string, key: string, checkers: ReferenceChecker[]): Promise<boolean> {
  for (const check of checkers) {
    if (await check({ db, bucket, key })) return true;
  }
  return false;
}

function listObjectsUnderPrefix(minio: MinioClient, bucket: string, prefix: string) {
  return new Promise<Array<{ name: string; lastModified: Date }>>((resolve, reject) => {
    const entries: Array<{ name: string; lastModified: Date }> = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (entry) => { if (entry.name && entry.lastModified) entries.push({ name: entry.name, lastModified: entry.lastModified }); });
    stream.once("error", reject);
    stream.once("end", () => resolve(entries));
  });
}

export type SweepOutcome = {
  scanned: number;
  orphans: string[];
  deleted: string[];
  tooYoung: string[];
  failed: Array<{ key: string; reason: string }>;
};

export type SweepInput = {
  db: PrismaClient;
  minio: MinioClient;
  bucket: string;
  /** Every object whose key starts with this prefix is examined. */
  prefix: string;
  /** true (the safe default everywhere this primitive is called from): detect and report, never delete. */
  dryRun: boolean;
  /** An object younger than this is never deleted, regardless of reference state (FR-024, FR-032). */
  gracePeriodMs: number;
  now?: Date;
  /** Defaults to `defaultReferenceCheckers` — override only for a narrower, already-proven-safe scope. */
  referenceCheckers?: ReferenceChecker[];
  /**
   * An additional, prefix-specific "still active, don't touch it" guard —
   * e.g. temp-upload cleanup uses this to skip an object under an
   * unexpired `PreparedImport` session regardless of its age. Returning
   * `true` skips the object exactly like an unreferenced-but-too-young one
   * (reported, never deleted in this pass).
   */
  isStillActive?: (key: string) => Promise<boolean>;
};

/**
 * One sweep pass. Idempotent by construction (FR-031): an object already
 * deleted is simply absent from the next listing; an object that is
 * referenced or too young is left untouched and reported the same way
 * every time. Safe to run concurrently — deletion is a single MinIO
 * `removeObject` call per key with no shared mutable state between callers,
 * so two overlapping passes only ever perform redundant work, never
 * conflicting or duplicate-erroring work (Invariant 6/7).
 */
export async function sweepUnreferencedObjects(input: SweepInput): Promise<SweepOutcome> {
  const now = input.now ?? new Date();
  const checkers = input.referenceCheckers ?? defaultReferenceCheckers;
  const entries = await listObjectsUnderPrefix(input.minio, input.bucket, input.prefix);

  const outcome: SweepOutcome = { scanned: entries.length, orphans: [], deleted: [], tooYoung: [], failed: [] };
  for (const entry of entries) {
    const key = entry.name;
    if (!key.startsWith(input.prefix)) continue;
    if (await isReferenced(input.db, input.bucket, key, checkers)) continue;
    if (input.isStillActive && await input.isStillActive(key)) continue;

    outcome.orphans.push(key);
    logStorageEvent("MINIO_ORPHAN_DETECTED", { bucket: input.bucket, key });

    const ageMs = now.getTime() - entry.lastModified.getTime();
    if (ageMs < input.gracePeriodMs) {
      outcome.tooYoung.push(key);
      continue;
    }
    if (input.dryRun) continue;

    try {
      await input.minio.removeObject(input.bucket, key);
      outcome.deleted.push(key);
      logStorageEvent("MINIO_ORPHAN_DELETED", { bucket: input.bucket, key });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      outcome.failed.push({ key, reason });
      logStorageEvent("MINIO_OBJECT_DELETE_FAILED", { bucket: input.bucket, key, reason }, "error");
    }
  }
  return outcome;
}

/**
 * Single-key convenience wrapper (deleted-asset cleanup's shape: one known
 * key, not a prefix listing) — still goes through the same reference check
 * and grace period, so it can never delete a key that is (still, or again)
 * referenced by the time it actually runs.
 */
export async function sweepSingleObject(input: Omit<SweepInput, "prefix"> & { key: string }): Promise<SweepOutcome> {
  const now = input.now ?? new Date();
  const checkers = input.referenceCheckers ?? defaultReferenceCheckers;
  const outcome: SweepOutcome = { scanned: 1, orphans: [], deleted: [], tooYoung: [], failed: [] };

  if (await isReferenced(input.db, input.bucket, input.key, checkers)) return outcome;
  if (input.isStillActive && await input.isStillActive(input.key)) return outcome;

  outcome.orphans.push(input.key);
  logStorageEvent("MINIO_ORPHAN_DETECTED", { bucket: input.bucket, key: input.key });

  let stat: { lastModified: Date } | null = null;
  try {
    stat = await input.minio.statObject(input.bucket, input.key);
  } catch {
    // Object is already gone (a previous pass already removed it, or it
    // never existed) — idempotent no-op, not a failure.
    return outcome;
  }
  const ageMs = now.getTime() - stat.lastModified.getTime();
  if (ageMs < input.gracePeriodMs) {
    outcome.tooYoung.push(input.key);
    return outcome;
  }
  if (input.dryRun) return outcome;

  try {
    await input.minio.removeObject(input.bucket, input.key);
    outcome.deleted.push(input.key);
    logStorageEvent("MINIO_ORPHAN_DELETED", { bucket: input.bucket, key: input.key });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    outcome.failed.push({ key: input.key, reason });
    logStorageEvent("MINIO_OBJECT_DELETE_FAILED", { bucket: input.bucket, key: input.key, reason }, "error");
  }
  return outcome;
}

/**
 * The scheduled, periodic full-bucket (or configured prefix list) orphan
 * scan (FR-053, `readiness.ts`'s scheduling seam). Guarded by
 * `GC_LOCK_KEYS.MINIO_ORPHAN_SCAN` so that when multiple worker replicas
 * are running, at most one actually performs the listing pass per tick —
 * the rest see `{ ran: false }` and simply wait for their next tick.
 * `dryRun` defaults come from `MINIO_ORPHAN_SCAN_DRY_RUN` (T003) at the
 * call site in `readiness.ts`, not hard-coded here.
 */
export async function runScheduledOrphanScan(input: {
  db: PrismaClient;
  minio: MinioClient;
  bucket: string;
  dryRun: boolean;
  gracePeriodMs: number;
  prefixes?: readonly string[];
}): Promise<{ ran: true; outcomes: Record<string, SweepOutcome> } | { ran: false }> {
  // Default: scan the whole bucket in one pass (empty prefix matches every
  // key) rather than requiring an exhaustive prefix list to stay safe —
  // defaultReferenceCheckers already covers every known key-bearing table,
  // so a bucket-wide scan is safe regardless of which prefix an object
  // lives under.
  const prefixes = input.prefixes ?? [""];
  const outcome = await withAdvisoryLock(input.db, GC_LOCK_KEYS.MINIO_ORPHAN_SCAN, async (tx) => {
    const outcomes: Record<string, SweepOutcome> = {};
    for (const prefix of prefixes) {
      outcomes[prefix] = await sweepUnreferencedObjects({
        db: tx, minio: input.minio, bucket: input.bucket, prefix,
        dryRun: input.dryRun, gracePeriodMs: input.gracePeriodMs,
      });
    }
    return outcomes;
  });
  return outcome.ran ? { ran: true, outcomes: outcome.result } : { ran: false };
}
