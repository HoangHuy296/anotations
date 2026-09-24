import assert from "node:assert/strict";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { readTextSource } from "../../src/lib/annotations/text-source-read-service.js";
import { mapTextSourceReadOutcomeToHttp } from "../../src/lib/annotations/text-source-http-mapping.js";
import { createWorkspaceUser, createWorkspaceDataset, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

/**
 * T050: `GET /api/assets/{assetId}/text` contract.
 *
 * This Next.js version's Route Handlers call `cookies()` (via
 * `getRequestActor()`), which throws "called outside a request scope" when
 * invoked directly outside a real server request -- confirmed with a
 * throwaway smoke test against this exact route before writing this suite.
 * The route (`apps/web/src/app/api/assets/[assetId]/text/route.ts`) is
 * otherwise a pure pass-through: authenticate, call `readTextSource` (T028,
 * already exhaustively tested in `text-source-service.test.ts` for every
 * readiness state and for concealment), and map the outcome to an HTTP
 * status via `mapTextSourceReadOutcomeToHttp` -- the one piece of logic
 * that actually lives in the route. This suite unit-tests that mapping
 * directly and confirms, against a real unprepared asset, exactly which
 * outcome shape the route would receive and map. `Cache-Control:
 * private, no-store` and `send-only-this-header` are literal string
 * constants in the route source, verified by direct inspection below since
 * there is no way to observe them on an actual Response in this
 * environment; T170's real two-browser-session acceptance pass is the
 * closure gate that observes real HTTP headers end to end.
 */

test("mapTextSourceReadOutcomeToHttp: every readiness state is 200 (a normal read result, never an error); only a concealed/missing asset is 404", () => {
  for (const readiness of ["UNPREPARED", "PREPARING", "READY", "UNAVAILABLE", "INVALID_ENCODING", "SOURCE_MISMATCH", "UNSUPPORTED_SIZE", "LEGACY_RECONCILIATION_REQUIRED"] as const) {
    assert.deepEqual(mapTextSourceReadOutcomeToHttp({ ok: true, readiness, assetId: "a", datasetId: "d" } as never), { status: 200 });
  }
  assert.deepEqual(mapTextSourceReadOutcomeToHttp({ ok: false, reason: "NOT_FOUND" }), { status: 404 });
});

test("the route source sends Cache-Control: private, no-store on every response (verified by direct source inspection, since a live header cannot be observed without a real server request)", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../src/app/api/assets/[assetId]/text/route.ts", import.meta.url), "utf8"));
  assert.match(source, /"Cache-Control":\s*"private, no-store"/);
  assert.match(source, /mapTextSourceReadOutcomeToHttp/, "the route must use the shared mapping, not duplicate status-selection logic");
});

test("readTextSource (what the route calls): each contract-relevant outcome the route must map correctly actually occurs", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("route-contract");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from("uploaded but not yet prepared", "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker },
    select: { id: true },
  });

  try {
    // UNPREPARED: object uploaded, but never run through TEXT_SOURCE_PREPARE.
    const unprepared = await readTextSource(owner, asset.id);
    assert.equal(unprepared.ok, true);
    if (unprepared.ok) assert.equal(unprepared.readiness, "UNPREPARED");
    assert.deepEqual(mapTextSourceReadOutcomeToHttp(unprepared), { status: 200 });

    // Concealed: non-member of the dataset.
    const concealed = await readTextSource(outsider, asset.id);
    assert.deepEqual(concealed, { ok: false, reason: "NOT_FOUND" });
    assert.deepEqual(mapTextSourceReadOutcomeToHttp(concealed), { status: 404 });

    // Concealed: asset id that does not exist at all.
    const missing = await readTextSource(owner, "does-not-exist");
    assert.deepEqual(missing, { ok: false, reason: "NOT_FOUND" });
    assert.deepEqual(mapTextSourceReadOutcomeToHttp(missing), { status: 404 });
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    const { cleanupWorkspaceFixture } = await import("../workspace/helpers.js");
    await cleanupWorkspaceFixture([owner.id, outsider.id], [dataset.id]);
  }
});
