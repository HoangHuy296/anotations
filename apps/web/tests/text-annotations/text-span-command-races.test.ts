import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { createTextSpan, updateTextSpan, deleteTextAnnotation } from "../../src/lib/annotations/text-span-service.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T072: real PostgreSQL races for span commands -- simultaneous
 * update/update, update/delete, and creates competing for the last
 * count-admission slot. Every case asserts exactly one winner via Prisma
 * Serializable transaction + revision check, never two, never zero
 * (data-model.md "Atomic command algorithm").
 */

function barrier(count: number) {
  let arrived = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === count) release?.();
    await gate;
  };
}

async function makeReadyTextAsset(marker: string, text: string) {
  const { config, minio } = getWebProviders();
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from(text, "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const sourceIdentity = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const boundaryArtifactKey = `text-boundaries/__test-fixtures__/${marker}/artifact.json`;
  const boundaryProfile = { schemaVersion: 1, algorithm: "EXTENDED_GRAPHEME_CLUSTER", nodeVersion: process.versions.node, icuVersion: process.versions.icu ?? "unknown", unicodeVersion: process.versions.unicode ?? "unknown" };
  const artifact = { schemaVersion: 1, profile: boundaryProfile, sourceIdentity, offsetUnit: "UTF16_CODE_UNIT", sourceCodeUnitLength: text.length, boundaryOffsets: Array.from({ length: text.length + 1 }, (_, i) => i) };
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
  return (await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { textPolicyRevision: true } })).textPolicyRevision;
}

test("two simultaneous updates on the same span at the same expectedRevision: exactly one winner, one REVISION_STALE", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-race-update"), "OpenAI builds AI.");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;

    const gate = barrier(2);
    const raceUpdate = (endOffset: number, operationId: string) => (async () => {
      await gate();
      return updateTextSpan(fixture.owner, fixture.asset.id, {
        operationId, sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
        command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, endOffset },
      });
    })();
    const [first, second] = await Promise.all([raceUpdate(10, "op-race-a"), raceUpdate(14, "op-race-b")]);
    const results = [first, second];
    assert.equal(results.filter((result) => result.ok).length, 1, "exactly one update wins");
    assert.equal(results.filter((result) => !result.ok && result.reason === "REVISION_STALE").length, 1, "the other loses to a stale revision, not a crash");

    const final = await db.annotation.findUniqueOrThrow({ where: { id: created.result.id }, select: { revision: true } });
    assert.equal(final.revision, created.result.revision + 1, "exactly one revision bump, not two");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("simultaneous update and delete on the same span: exactly one winner, no resurrection", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-race-update-delete"), "OpenAI builds AI.");
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const created = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: "op-create", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", startOffset: 0, endOffset: 6, labelId: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok || created.replayed) return;

    const gate = barrier(2);
    const update = (async () => {
      await gate();
      return updateTextSpan(fixture.owner, fixture.asset.id, {
        operationId: "op-race-update", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
        command: { kind: "updateSpan", annotationId: created.result.id, expectedRevision: created.result.revision, endOffset: 10 },
      });
    })();
    const remove = (async () => {
      await gate();
      return deleteTextAnnotation(fixture.owner, fixture.asset.id, {
        operationId: "op-race-delete", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
        command: { kind: "deleteAnnotation", annotationId: created.result.id, expectedRevision: created.result.revision },
      });
    })();
    const [updateResult, deleteResult] = await Promise.all([update, remove]);
    const results = [updateResult, deleteResult];
    assert.equal(results.filter((result) => result.ok).length, 1, "exactly one of update/delete wins");

    const survives = await db.annotation.count({ where: { id: created.result.id } });
    assert.equal(survives, updateResult.ok ? 1 : 0, "the row exists iff the update won -- never resurrected after a winning delete");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("two simultaneous creates competing for the last admission slot: exactly one succeeds, one LIMIT_EXCEEDED, and replaying the winner's operationId still succeeds at the limit", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("span-race-limit"), "one two three four five");
  const previousLimit = process.env.TEXT_WORKSPACE_MAX_ANNOTATIONS;
  process.env.TEXT_WORKSPACE_MAX_ANNOTATIONS = "1";
  try {
    const expectedPolicyRevision = await currentPolicyRevision(fixture.dataset.id);
    const gate = barrier(2);
    const race = (startOffset: number, endOffset: number, operationId: string) => (async () => {
      await gate();
      return createTextSpan(fixture.owner, fixture.asset.id, {
        operationId, sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
        command: { kind: "createSpan", startOffset, endOffset, labelId: null },
      });
    })();
    const [first, second] = await Promise.all([race(0, 3, "op-limit-a"), race(4, 7, "op-limit-b")]);
    const results = [first, second];
    assert.equal(results.filter((result) => result.ok).length, 1, "exactly one create wins the last slot");
    assert.equal(results.filter((result) => !result.ok && result.reason === "LIMIT_EXCEEDED").length, 1);

    const count = await db.annotation.count({ where: { assetId: fixture.asset.id } });
    assert.equal(count, 1, "the limit is truly enforced, not just reported");

    const winner = results.find((result) => result.ok);
    assert.ok(winner && winner.ok);
    if (!winner || !winner.ok) return;
    const winningOperationId = winner === first ? "op-limit-a" : "op-limit-b";
    const winningRange = winner === first ? { startOffset: 0, endOffset: 3 } : { startOffset: 4, endOffset: 7 };

    // Replaying the winner's own operationId at the same (now-at-limit)
    // count must still succeed -- replay never consumes fresh admission
    // capacity (contracts/workspace.md "Source byte/code-unit limits").
    const replay = await createTextSpan(fixture.owner, fixture.asset.id, {
      operationId: winningOperationId, sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
      command: { kind: "createSpan", ...winningRange, labelId: null },
    });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.replayed, true);
    assert.equal(await db.annotation.count({ where: { assetId: fixture.asset.id } }), 1, "replay never creates a second row even at the limit");
  } finally {
    if (previousLimit === undefined) delete process.env.TEXT_WORKSPACE_MAX_ANNOTATIONS;
    else process.env.TEXT_WORKSPACE_MAX_ANNOTATIONS = previousLimit;
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});
