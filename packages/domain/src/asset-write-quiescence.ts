/**
 * specs/027-coco-dataset-export §10 -- the writer-quiescence window used
 * once, briefly, during the real ENFORCE cutover (BACKFILL final pass ->
 * install trigger -> verify -> resume). NOT wired into any real write path
 * yet (that happens as part of the already-deferred Step C wiring, so it
 * ships in the same deploy as the relativePath-writing code, always
 * present but a no-op unless the flag is set).
 *
 * Deliberately a plain, ephemeral, auto-expiring Redis key -- the same
 * "Redis is not authoritative for this" posture as
 * apps/web/src/lib/rate-limit/fixed-window.ts's rate-limit counter. Its
 * absence or a Redis outage during the check means "not paused" (fails
 * open), which is an accepted, disclosed limitation for a short, humanly
 * supervised maintenance window, not a hard guarantee substituting for the
 * final pre-ENFORCE verification query (§10a) that would still catch a
 * stray write that slipped through.
 */
export const ASSET_WRITE_QUIESCENCE_REDIS_KEY = "settings:asset-writes-paused";

/** Auto-expiry for the pause flag: an operator who forgets to resume does
 * not leave writes paused indefinitely. Chosen generously longer than any
 * expected cutover window (§10's whole quiesced sequence is "short"). */
export const ASSET_WRITE_QUIESCENCE_TTL_SECONDS = 1800;

export function isAssetWriteQuiescenceValue(raw: string | null | undefined): boolean {
  return raw === "1";
}

/**
 * Thrown by every real Asset-creating write path (specs/027 §10's writer
 * inventory: `publishUploadedAsset` in apps/web, `upsertMirroredRepositoryAsset`
 * in apps/worker -- the complete, exhaustively-verified set) when the
 * quiescence flag is set. One shared type so both apps' callers can catch it
 * identically.
 */
export class AssetWritesQuiescedError extends Error {
  constructor() {
    super("ASSET_WRITES_PAUSED_FOR_MIGRATION");
    this.name = "AssetWritesQuiescedError";
  }
}
