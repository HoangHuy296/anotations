import "server-only";

import { Redis } from "ioredis";

import { logRedisEvent, readProviderConfig } from "@annotationplatform/domain";
import { ASSET_WRITE_QUIESCENCE_REDIS_KEY, AssetWritesQuiescedError, isAssetWriteQuiescenceValue } from "@annotationplatform/domain/asset-write-quiescence";

/**
 * specs/027-coco-dataset-export §10 -- checked at the top of every real
 * Asset-creating write path (the exhaustive writer inventory, §10a: only
 * `publishUploadedAsset` on the apps/web side). Never checked by
 * annotation-only mutations, which cannot create an Asset.
 *
 * Deliberately a fresh, short-lived connection per check, closed in a
 * `finally` -- NOT the persistent shared-singleton pattern
 * apps/web/src/lib/rate-limit/fixed-window.ts uses. That pattern is right
 * for a genuinely hot path (a counter checked on every browser-facing
 * request); Asset creation is comparatively rare, and a persistent
 * unclosed handle here caused a real, reproduced defect: `node --test`
 * hung indefinitely after `tests/asset-write-quiescence/writer-boundaries
 * .test.ts`'s assertions had already passed, because that test calls
 * `publishUploadedAsset` directly, in-process, with no spawned Next.js
 * server to own the connection's lifecycle (unlike this app's HTTP-based
 * upload tests, which spawn `next start` and whose teardown kills the
 * whole child process). Fixed the same way as the identical defect found
 * on the apps/worker side for `upsertMirroredRepositoryAsset`.
 *
 * A Redis failure here fails OPEN (does not block a write) -- a short,
 * humanly-supervised maintenance-window aid, not a hard guarantee; the
 * §10 pre-ENFORCE verification is what actually gates the trigger
 * installation, and would still catch a stray write that slipped through.
 */
export async function assertAssetWritesNotQuiesced(input?: { connection?: Redis }): Promise<void> {
  const connection = input?.connection ?? new Redis({
    host: readProviderConfig().REDIS_HOST,
    port: readProviderConfig().REDIS_PORT,
    password: readProviderConfig().REDIS_PASSWORD,
    db: readProviderConfig().REDIS_DB,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  const ownsConnection = !input?.connection;
  if (ownsConnection) connection.on("error", (error) => {
    logRedisEvent("CONNECTION_ERROR", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
  });
  try {
    const raw = await connection.get(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
    if (isAssetWriteQuiescenceValue(raw)) throw new AssetWritesQuiescedError();
  } catch (error) {
    if (error instanceof AssetWritesQuiescedError) throw error;
    logRedisEvent("CONNECTION_ERROR", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
  } finally {
    if (ownsConnection) connection.disconnect();
  }
}
