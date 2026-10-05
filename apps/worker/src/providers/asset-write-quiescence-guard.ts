import { Redis } from "ioredis";

import { logRedisEvent } from "@annotationplatform/domain";
import { ASSET_WRITE_QUIESCENCE_REDIS_KEY, AssetWritesQuiescedError, isAssetWriteQuiescenceValue } from "@annotationplatform/domain/asset-write-quiescence";

import { getWorkerConfig } from "../config.js";

/**
 * Worker-side counterpart to apps/web/src/lib/asset-write-quiescence-guard.ts
 * -- see its docstring for the full rationale (specs/027-coco-dataset-export
 * §10). Checked at the top of `upsertMirroredRepositoryAsset`, the only
 * Asset-creating write path on the worker side (the exhaustive writer
 * inventory). Fails open on a Redis outage, same posture as the web guard.
 *
 * Deliberately a fresh, short-lived connection per check, closed in a
 * `finally` -- NOT a persistent shared singleton like the web guard.
 * Reasoning, found empirically: the web guard's connection lives inside the
 * spawned `next start` child process its own HTTP-based tests talk to, so
 * that process's own teardown closes it; this function instead runs
 * in-process inside whatever calls it directly (a worker job processor, or
 * a `node --test` script that calls `upsertMirroredRepositoryAsset`
 * directly with no spawned child process) -- a persistent unclosed
 * connection there left `node --test` hanging indefinitely after every
 * assertion had already passed (reproduced with
 * tests/repository-import/asset-upsert.test.ts: "ok 1" in 380ms, then the
 * process never exited). Asset creation is not a per-request hot path on
 * the worker side, so the extra per-call handshake is an acceptable,
 * disclosed trade-off for zero lingering-handle risk.
 */
export async function assertAssetWritesNotQuiesced(): Promise<void> {
  const config = getWorkerConfig();
  const connection = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    db: config.REDIS_DB,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  connection.on("error", (error) => {
    logRedisEvent("CONNECTION_ERROR", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
  });
  try {
    const raw = await connection.get(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
    if (isAssetWriteQuiescenceValue(raw)) throw new AssetWritesQuiescedError();
  } catch (error) {
    if (error instanceof AssetWritesQuiescedError) throw error;
    // A Redis outage during the check fails open -- see the module docstring.
    logRedisEvent("CONNECTION_ERROR", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
  } finally {
    connection.disconnect();
  }
}
