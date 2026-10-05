import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { replaceClassification } from "../../src/lib/annotations/text-classification-service.js";
import { createLabelWithTextEligibility } from "../../src/lib/workspace/label-management.js";
import { writeTextPolicy } from "../../src/lib/annotations/text-policy-write-service.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/** Mirrors `text-span-command-races.test.ts`'s (T072) own barrier helper. */
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

async function makeGroupFixture(owner: Awaited<ReturnType<typeof createWorkspaceUser>>, datasetId: string, cardinality: "SINGLE" | "MULTI") {
  const positive = await createLabelWithTextEligibility(owner, { datasetId, name: workspaceUnique("Positive"), color: "#22C55E", description: null, hotkey: null, textEligibility: "SENTIMENT" });
  const negative = await createLabelWithTextEligibility(owner, { datasetId, name: workspaceUnique("Negative"), color: "#EF4444", description: null, hotkey: null, textEligibility: "SENTIMENT" });
  assert.equal(positive.ok, true); assert.equal(negative.ok, true);
  if (!positive.ok || !negative.ok) throw new Error("label creation failed");

  const groupId = "sentiment";
  const expectedRevision = await currentPolicyRevision(datasetId);
  const policyWrite = await writeTextPolicy(owner, datasetId, {
    expectedRevision,
    policy: { schemaVersion: 1, classificationGroups: [{ id: groupId, name: "Sentiment", cardinality, memberLabelIds: [positive.label.id, negative.label.id] }], relationTypes: [] },
  });
  assert.equal(policyWrite.ok, true);
  if (!policyWrite.ok) throw new Error("policy write failed");
  return { groupId, positiveId: positive.label.id, negativeId: negative.label.id, expectedPolicyRevision: policyWrite.revision };
}

test("replaceClassification: a same-operationId replay returns the committed result without a second row", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("classification-replay"), "This product is great.");
  try {
    const { groupId, positiveId, expectedPolicyRevision } = await makeGroupFixture(fixture.owner, fixture.dataset.id, "SINGLE");
    const envelope = { operationId: "op-select", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision, command: { kind: "replaceClassification" as const, groupId, memberLabelIds: [positiveId], expectedMembers: [] } };

    const first = await replaceClassification(fixture.owner, fixture.asset.id, envelope);
    assert.equal(first.ok, true);
    if (!first.ok || first.replayed) return;

    const replay = await replaceClassification(fixture.owner, fixture.asset.id, envelope);
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.replayed, true);

    const count = await db.annotation.count({ where: { assetId: fixture.asset.id, type: "SENTIMENT" } });
    assert.equal(count, 1, "replay must not create a second row");
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});

test("replaceClassification: two simultaneous replacements from the same starting membership -- exactly one wins, the other REVISION_STALE, real Postgres Serializable isolation", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await makeReadyTextAsset(workspaceUnique("classification-race"), "This product is great.");
  try {
    const { groupId, positiveId, negativeId, expectedPolicyRevision } = await makeGroupFixture(fixture.owner, fixture.dataset.id, "SINGLE");

    const gate = barrier(2);
    const selectPositive = (async () => {
      await gate();
      return replaceClassification(fixture.owner, fixture.asset.id, {
        operationId: "op-race-positive", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
        command: { kind: "replaceClassification", groupId, memberLabelIds: [positiveId], expectedMembers: [] },
      });
    })();
    const selectNegative = (async () => {
      await gate();
      return replaceClassification(fixture.owner, fixture.asset.id, {
        operationId: "op-race-negative", sourceIdentity: fixture.sourceIdentity, expectedPolicyRevision,
        command: { kind: "replaceClassification", groupId, memberLabelIds: [negativeId], expectedMembers: [] },
      });
    })();
    const [positiveResult, negativeResult] = await Promise.all([selectPositive, selectNegative]);
    const results = [positiveResult, negativeResult];
    assert.equal(results.filter((result) => result.ok).length, 1, "exactly one of the two racing replacements wins");
    assert.equal(results.filter((result) => !result.ok && result.reason === "REVISION_STALE").length, 1);

    const persisted = await db.annotation.findMany({ where: { assetId: fixture.asset.id, type: "SENTIMENT" }, select: { labelId: true } });
    assert.equal(persisted.length, 1, "exactly one classification row exists -- never both, never zero");
    const winnerLabelId = positiveResult.ok ? positiveId : negativeId;
    assert.equal(persisted[0]?.labelId, winnerLabelId);
  } finally {
    await fixture.cleanup();
    await cleanupWorkspaceFixture([fixture.owner.id], [fixture.dataset.id]);
  }
});
