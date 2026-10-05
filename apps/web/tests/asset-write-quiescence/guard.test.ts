import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { Redis } from "ioredis";

import { readProviderConfig } from "@annotationplatform/domain";
import { AssetWritesQuiescedError, ASSET_WRITE_QUIESCENCE_REDIS_KEY } from "@annotationplatform/domain/asset-write-quiescence";

import { assertAssetWritesNotQuiesced } from "@/lib/asset-write-quiescence-guard";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

// Own connection, injected -- never the shared production singleton --
// exercising the exact same key the real guard checks, on the real Redis
// instance, cleaned up after every test.
const connection = hasIntegrationDatabase ? new Redis({
  host: readProviderConfig().REDIS_HOST,
  port: readProviderConfig().REDIS_PORT,
  password: readProviderConfig().REDIS_PASSWORD,
  db: readProviderConfig().REDIS_DB,
  maxRetriesPerRequest: 1,
}) : undefined;

beforeEach(async () => { await connection?.del(ASSET_WRITE_QUIESCENCE_REDIS_KEY); });
after(async () => {
  await connection?.del(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
  await connection?.quit().catch(() => undefined);
});

test("resolves (does not throw) when the flag is unset", { skip: !hasIntegrationDatabase }, async () => {
  await assertAssetWritesNotQuiesced({ connection });
});

test("throws AssetWritesQuiescedError when the flag is '1'", { skip: !hasIntegrationDatabase }, async () => {
  await connection!.set(ASSET_WRITE_QUIESCENCE_REDIS_KEY, "1");
  await assert.rejects(() => assertAssetWritesNotQuiesced({ connection }), AssetWritesQuiescedError);
});

test("resolves for any value other than the exact literal '1'", { skip: !hasIntegrationDatabase }, async () => {
  await connection!.set(ASSET_WRITE_QUIESCENCE_REDIS_KEY, "true");
  await assertAssetWritesNotQuiesced({ connection });
});

test("resolves again once the flag is cleared", { skip: !hasIntegrationDatabase }, async () => {
  await connection!.set(ASSET_WRITE_QUIESCENCE_REDIS_KEY, "1");
  await assert.rejects(() => assertAssetWritesNotQuiesced({ connection }));
  await connection!.del(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
  await assertAssetWritesNotQuiesced({ connection });
});
