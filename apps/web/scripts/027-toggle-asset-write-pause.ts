import "../../../scripts/db-safety/deny-entry.cjs"; // G1: this writer has no approved operation scope.
/**
 * specs/027-coco-dataset-export §10 -- operator tool for the ENFORCE
 * cutover's writer-quiescence window. Toggles the shared Redis flag every
 * Asset-creating write path checks (once Step C wires that check in --
 * currently unwired, see the spec's "how Asset-creating writers are paused"
 * section). Annotation-only operations never check this flag and are
 * unaffected -- they cannot create an Asset.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/027-toggle-asset-write-pause.ts on
 *   npx tsx scripts/027-toggle-asset-write-pause.ts off
 *   npx tsx scripts/027-toggle-asset-write-pause.ts status
 *
 * Real Redis, real key, but a single, brand-new, namespaced key
 * (`settings:asset-writes-paused`) unrelated to any BullMQ queue data --
 * this script never touches queue state.
 */
import { Redis } from "ioredis";
import { config as loadEnvironment } from "dotenv";

import { ASSET_WRITE_QUIESCENCE_REDIS_KEY, ASSET_WRITE_QUIESCENCE_TTL_SECONDS, isAssetWriteQuiescenceValue } from "@annotationplatform/domain/asset-write-quiescence";

loadEnvironment({ path: "../../.env", override: true, quiet: true });
loadEnvironment({ path: "../../.env.local", override: false, quiet: true });

const action = process.argv[2];
if (!action || !["on", "off", "status"].includes(action)) {
  console.error("Usage: tsx scripts/027-toggle-asset-write-pause.ts <on|off|status>");
  process.exit(1);
}

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  db: Number(process.env.REDIS_DB ?? 0),
  maxRetriesPerRequest: 1,
});

async function main() {
  if (action === "on") {
    await redis.set(ASSET_WRITE_QUIESCENCE_REDIS_KEY, "1", "EX", ASSET_WRITE_QUIESCENCE_TTL_SECONDS);
    console.log(`Asset writes PAUSED. Auto-expires in ${ASSET_WRITE_QUIESCENCE_TTL_SECONDS}s if not explicitly resumed.`);
  } else if (action === "off") {
    await redis.del(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
    console.log("Asset writes RESUMED.");
  } else {
    const raw = await redis.get(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
    const ttl = await redis.ttl(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
    console.log(`Paused: ${isAssetWriteQuiescenceValue(raw)}${ttl > 0 ? ` (auto-resumes in ${ttl}s)` : ""}`);
  }
  redis.disconnect();
}

main().catch((error) => {
  console.error(error);
  redis.disconnect();
  process.exitCode = 1;
});
