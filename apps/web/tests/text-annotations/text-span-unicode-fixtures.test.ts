import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { createTextSpan } from "../../src/lib/annotations/text-span-service.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T066: the full Unicode fixture matrix from research.md D1 -- every row of
 * that table, not just the ASCII case `text-span-commands.test.ts` already
 * covers. For each fixture: the table's own "required example" range
 * produces the exact original substring (create -> save -> a fresh DB read,
 * standing in for "reload" since there is no export/reader round-trip to
 * exercise yet -- see the note at the bottom of this file), and the table's
 * own adjacent invalid (mid-grapheme/mid-sequence) endpoint is rejected as
 * INVALID_RANGE with no row written. Boundary offsets are taken directly
 * from research.md's table, not recomputed here -- this file proves the
 * command layer honors *given* boundaries correctly (T070/T071's job);
 * proving the boundaries themselves are correct is `text-boundary.test.ts`'s
 * job (T020, `apps/worker`), and importing worker code into a web test would
 * cross the app boundary this repo deliberately keeps closed.
 */

async function makeReadyTextAssetWithBoundaries(marker: string, text: string, boundaryOffsets: readonly number[]) {
  const { config, minio } = getWebProviders();
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from(text, "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const sourceIdentity = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const boundaryArtifactKey = `text-boundaries/__test-fixtures__/${marker}/artifact.json`;
  const boundaryProfile = { schemaVersion: 1, algorithm: "EXTENDED_GRAPHEME_CLUSTER", nodeVersion: process.versions.node, icuVersion: process.versions.icu ?? "unknown", unicodeVersion: process.versions.unicode ?? "unknown" };
  const artifact = { schemaVersion: 1, profile: boundaryProfile, sourceIdentity, offsetUnit: "UTF16_CODE_UNIT", sourceCodeUnitLength: text.length, boundaryOffsets: [...boundaryOffsets] };
  const artifactBytes = Buffer.from(JSON.stringify(artifact), "utf8");
  await minio.putObject(config.MINIO_BUCKET, boundaryArtifactKey, artifactBytes, artifactBytes.length, { "Content-Type": "application/json" });
  const boundaryArtifactDigest = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
  const asset = await db.asset.create({
    data: {
      datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain",
      storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker,
      textAsset: { create: { sourceIdentity, sourceEncoding: "UTF8", offsetUnit: "UTF16_CODE_UNIT", sourceByteLength: bytes.length, sourceCodeUnitLength: text.length, boundaryArtifactKey, boundaryArtifactDigest, boundaryProfile, preparedSourceFingerprint: marker, preparedAt: new Date() } },
    },
    select: { id: true },
  });
  return { owner, dataset, asset, sourceIdentity, cleanup: async () => { await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined); await minio.removeObject(config.MINIO_BUCKET, boundaryArtifactKey).catch(() => undefined); } };
}

async function currentPolicyRevision(datasetId: string) {
  const dataset = await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { textPolicyRevision: true } });
  return dataset.textPolicyRevision;
}

type UnicodeFixture = {
  name: string;
  marker: string;
  text: string;
  boundaryOffsets: number[];
  example: { start: number; end: number };
  /** An interior offset adjacent to `example` that is deliberately NOT a boundary; omit when every offset in range is already a valid boundary (no fractional case exists). */
  rejectedInteriorEndOffset?: number;
};

const FIXTURES: UnicodeFixture[] = [
  { name: "OpenAI builds AI. (ASCII baseline)", marker: "uni-ascii", text: "OpenAI builds AI.", boundaryOffsets: Array.from({ length: 18 }, (_, i) => i), example: { start: 0, end: 6 } },
  { name: "A😀B (surrogate-pair emoji)", marker: "uni-emoji-surrogate", text: "A😀B", boundaryOffsets: [0, 1, 3, 4], example: { start: 1, end: 3 }, rejectedInteriorEndOffset: 2 },
  { name: "e + combining acute accent (U+0301)", marker: "uni-combining", text: "é", boundaryOffsets: [0, 2], example: { start: 0, end: 2 }, rejectedInteriorEndOffset: 1 },
  { name: "é (precomposed accented character)", marker: "uni-precomposed", text: "é", boundaryOffsets: [0, 1], example: { start: 0, end: 1 } },
  { name: "👩‍💻 (ZWJ emoji sequence)", marker: "uni-zwj", text: "👩‍💻", boundaryOffsets: [0, 5], example: { start: 0, end: 5 }, rejectedInteriorEndOffset: 2 },
  { name: "中文 (CJK)", marker: "uni-cjk", text: "中文", boundaryOffsets: [0, 1, 2], example: { start: 0, end: 1 } },
  { name: "BOM + A + CRLF + B + CR + C + LF", marker: "uni-bom-crlf", text: "﻿A\r\nB\rC\n", boundaryOffsets: [0, 1, 2, 4, 5, 6, 7, 8], example: { start: 2, end: 4 }, rejectedInteriorEndOffset: 3 },
];

for (const fixture of FIXTURES) {
  test(`text span Unicode fixture matrix: ${fixture.name} -- exact substring on create/save/reload${fixture.rejectedInteriorEndOffset !== undefined ? ", rejects the fractional interior boundary with no partial write" : ""}`, { skip: !hasIntegrationDatabase }, async () => {
    const asset = await makeReadyTextAssetWithBoundaries(workspaceUnique(fixture.marker), fixture.text, fixture.boundaryOffsets);
    try {
      const expectedPolicyRevision = await currentPolicyRevision(asset.dataset.id);
      const expectedSubstring = fixture.text.slice(fixture.example.start, fixture.example.end);

      const created = await createTextSpan(asset.owner, asset.asset.id, {
        operationId: "op-example", sourceIdentity: asset.sourceIdentity, expectedPolicyRevision,
        command: { kind: "createSpan", startOffset: fixture.example.start, endOffset: fixture.example.end, labelId: null },
      });
      assert.equal(created.ok, true, "the table's required example range must be accepted");
      if (!created.ok || created.replayed) return;
      assert.equal(created.result.geometry.kind, "text-span");
      if (created.result.geometry.kind === "text-span") {
        assert.equal(created.result.geometry.startOffset, fixture.example.start);
        assert.equal(created.result.geometry.endOffset, fixture.example.end);
      }

      // "Reload": a fresh read of the durable row (not the in-memory result
      // just returned) must reproduce the exact original substring -- the
      // same invariant a real reload's GET would depend on.
      const reloaded = await db.annotation.findUniqueOrThrow({ where: { id: created.result.id } });
      const reloadedGeometry = reloaded.geometry as unknown as { startOffset: number; endOffset: number };
      assert.equal(fixture.text.slice(reloadedGeometry.startOffset, reloadedGeometry.endOffset), expectedSubstring);

      if (fixture.rejectedInteriorEndOffset !== undefined) {
        const rejected = await createTextSpan(asset.owner, asset.asset.id, {
          operationId: "op-fractional", sourceIdentity: asset.sourceIdentity, expectedPolicyRevision,
          command: { kind: "createSpan", startOffset: fixture.example.start, endOffset: fixture.rejectedInteriorEndOffset, labelId: null },
        });
        assert.deepEqual(rejected, { ok: false, reason: "INVALID_RANGE" });
      }

      // No partial write from the rejection above -- exactly the one
      // successful example span exists.
      const count = await db.annotation.count({ where: { assetId: asset.asset.id } });
      assert.equal(count, 1);
    } finally {
      await asset.cleanup();
      await cleanupWorkspaceFixture([asset.owner.id], [asset.dataset.id]);
    }
  });
}

test("text span Unicode fixture matrix: empty document -- no span is possible; reversed and out-of-bounds ranges are rejected on a non-ASCII fixture too", { skip: !hasIntegrationDatabase }, async () => {
  const empty = await makeReadyTextAssetWithBoundaries(workspaceUnique("uni-empty"), "", [0]);
  const cjk = await makeReadyTextAssetWithBoundaries(workspaceUnique("uni-cjk-generic"), "中文", [0, 1, 2]);
  try {
    const emptyPolicyRevision = await currentPolicyRevision(empty.dataset.id);
    // `endOffset` is `.positive()` at the schema layer (a span can never
    // have zero length), so the smallest schema-valid attempt on an empty
    // document is [0,1) -- this exercises the service's own out-of-bounds/
    // boundary check (`sourceCodeUnitLength` is 0, `boundaryOffsets` is
    // only `[0]`) rather than the unrelated schema-level positivity guard.
    const outOfBoundsOnEmpty = await createTextSpan(empty.owner, empty.asset.id, {
      operationId: "op-empty", sourceIdentity: empty.sourceIdentity, expectedPolicyRevision: emptyPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 1, labelId: null },
    });
    assert.deepEqual(outOfBoundsOnEmpty, { ok: false, reason: "INVALID_RANGE" });
    assert.equal(await db.annotation.count({ where: { assetId: empty.asset.id } }), 0);

    const cjkPolicyRevision = await currentPolicyRevision(cjk.dataset.id);
    const reversed = await createTextSpan(cjk.owner, cjk.asset.id, {
      operationId: "op-reversed", sourceIdentity: cjk.sourceIdentity, expectedPolicyRevision: cjkPolicyRevision,
      command: { kind: "createSpan", startOffset: 2, endOffset: 1, labelId: null },
    });
    assert.deepEqual(reversed, { ok: false, reason: "INVALID_RANGE" });
    const outOfBounds = await createTextSpan(cjk.owner, cjk.asset.id, {
      operationId: "op-out-of-bounds", sourceIdentity: cjk.sourceIdentity, expectedPolicyRevision: cjkPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 999, labelId: null },
    });
    assert.deepEqual(outOfBounds, { ok: false, reason: "INVALID_RANGE" });
    assert.equal(await db.annotation.count({ where: { assetId: cjk.asset.id } }), 0, "no partial write from either rejection");
  } finally {
    await empty.cleanup(); await cjk.cleanup();
    await cleanupWorkspaceFixture([empty.owner.id, cjk.owner.id], [empty.dataset.id, cjk.dataset.id]);
  }
});

// Export is intentionally not exercised here: `apps/worker/src/jobs/
// text-export-serializer.ts` (T085) does not exist yet, so "create/save/
// reload/export" is covered through "reload" only until T085 lands. See
// tasks.md's 2026-09-23 status audit.
