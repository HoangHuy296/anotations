/**
 * specs/027-coco-dataset-export §10 (corrected): after ENFORCE, a live Asset
 * may never have relativePath = NULL -- not even historically, and not as
 * a permanent exception for an unreconstructable row. Historical
 * deleted/archived rows may keep relativePath = NULL indefinitely (they are
 * not live), but any transition INTO the live state (deletedAt clearing to
 * NULL) must carry a valid, already-normalized relativePath or be rejected
 * outright -- never invented.
 *
 * FORWARD-LOOKING, NOT YET WIRED: the repository-wide writer inventory
 * (specs/027 §10's report) found there is no Asset revival/undelete feature
 * anywhere in the codebase today -- `deletedAt` is only ever set to a
 * timestamp (soft-delete), never cleared back to null. This guard exists so
 * that IF such a feature is added, it is correct from the day it ships,
 * without needing this invariant re-derived.
 *
 * The database's own CHECK constraint
 * (specs/proposals/asset-relative-path/step-b-trigger.sql,
 * `asset_live_requires_relative_path`) is the authoritative backstop for
 * this same rule -- but it is explicitly a backstop, not the primary
 * mechanism: this function is what a future revival code path must call
 * BEFORE ever issuing the database write, so the caller gets a clean,
 * explicit, application-level error instead of relying on the database
 * constraint's own error shape, which is deliberately not made pretty (see
 * `isLikelyLiveRequiresRelativePathViolation` below).
 */
export class AssetRevivalRequiresRelativePathError extends Error {
  constructor(readonly assetId: string) {
    super("ASSET_REVIVAL_REQUIRES_RELATIVE_PATH");
    this.name = "AssetRevivalRequiresRelativePathError";
  }
}

/**
 * Call before writing `deletedAt: null` (or otherwise transitioning an
 * Asset into the live state) on any Asset. `candidateRelativePath` is
 * whatever the row already has, or whatever the caller is about to supply
 * in the same write -- never something this function invents.
 */
export function assertRevivalHasCanonicalRelativePath(assetId: string, candidateRelativePath: string | null | undefined): void {
  if (!candidateRelativePath) throw new AssetRevivalRequiresRelativePathError(assetId);
}

/**
 * Best-effort, NOT authoritative: a genuine violation of the DB's
 * `asset_live_requires_relative_path` CHECK constraint surfaces via a typed
 * Prisma call as `PrismaClientUnknownRequestError` with `code: undefined`
 * and `meta: undefined` -- verified by spike; Prisma cannot resolve a
 * structured signal for a constraint it doesn't know from schema
 * introspection (the same limitation found for the identity-conflict
 * trigger before its P2002+target-null marker was established). Since this
 * constraint should be unreachable in normal operation (the application
 * guard above is the primary mechanism), this detector exists only for
 * logging/diagnostics if it is ever hit -- never for deciding how to
 * respond to a user, and never combined with `isAssetRelativePathConflict`
 * (packages/domain/src/asset-identity-conflict.ts), which is a different,
 * routine, cleanly-marked condition.
 */
export function isLikelyLiveRequiresRelativePathViolation(error: unknown): boolean {
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" && message.includes("asset_live_requires_relative_path");
}
