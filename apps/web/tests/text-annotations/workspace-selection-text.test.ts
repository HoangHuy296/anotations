import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AssetStatus, Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { readWorkspaceSelection } from "../../src/lib/workspace/workspace-read.js";
import { createLabelWithTextEligibility } from "../../src/lib/workspace/label-management.js";
import { createWorkspaceUser, createWorkspaceDataset, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T048: the generic WorkspaceSelection DTO's TEXT variant now carries real
 * source readiness, revision, capability, and annotation context instead of
 * bare metadata. `readWorkspaceSelection` must use the *cheap* T027
 * readiness derivation here (DB-only), never T028's expensive full source
 * re-verification -- this selection loads on every workspace navigation.
 */

test("readWorkspaceSelection: an unprepared TEXT asset reports UNPREPARED readiness and no earned write capability", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("selection-unprepared");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from("not yet prepared", "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker },
    select: { id: true },
  });

  try {
    const selection = await readWorkspaceSelection(owner, dataset.id, asset.id);
    assert.ok(selection && selection.engine === "TEXT");
    if (!selection || selection.engine !== "TEXT") return;
    assert.deepEqual(selection.source, { readiness: "UNPREPARED" });
    assert.deepEqual(selection.annotations, []);
    assert.equal(selection.capabilities.read, true);
    assert.equal(selection.capabilities.select, true);
    assert.equal(selection.capabilities.span, false);
    assert.equal(selection.capabilities.classification, false);
    assert.equal(selection.capabilities.relation, false);
    assert.match(selection.capabilities.reasons.span ?? "", /prepared/i);
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("readWorkspaceSelection: a READY TEXT asset with an eligible ENTITY label and annotation.create grants span, reports the exact verified source context and current revision", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("selection-ready");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const text = "OpenAI builds AI.";
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
    select: { id: true, revision: true },
  });
  const entityLabel = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: workspaceUnique("Person"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
  assert.equal(entityLabel.ok, true);

  try {
    const selection = await readWorkspaceSelection(owner, dataset.id, asset.id);
    assert.ok(selection && selection.engine === "TEXT");
    if (!selection || selection.engine !== "TEXT") return;
    assert.deepEqual(selection.source, { readiness: "READY", sourceIdentity, offsetUnit: "UTF16_CODE_UNIT", sourceCodeUnitLength: text.length, sourceByteLength: bytes.length });
    assert.equal(selection.asset.revision, asset.revision);
    assert.equal(selection.asset.status, AssetStatus.NEW);
    assert.equal(selection.capabilities.span, true);
    assert.equal(selection.capabilities.classification, false, "no classification taxonomy is configured");
    assert.equal(selection.capabilities.reasons.span, null);
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await minio.removeObject(config.MINIO_BUCKET, boundaryArtifactKey).catch(() => undefined);
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("readWorkspaceSelection: a frozen workflow state (NEEDS_REVIEW) blocks every write capability even when otherwise eligible", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("selection-frozen");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const text = "frozen fixture";
  const bytes = Buffer.from(text, "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const sourceIdentity = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const boundaryProfile = { schemaVersion: 1, algorithm: "EXTENDED_GRAPHEME_CLUSTER", nodeVersion: process.versions.node, icuVersion: process.versions.icu ?? "unknown", unicodeVersion: process.versions.unicode ?? "unknown" };
  const boundaryArtifactKey = `text-boundaries/__test-fixtures__/${marker}/artifact.json`;
  const artifact = { schemaVersion: 1, profile: boundaryProfile, sourceIdentity, offsetUnit: "UTF16_CODE_UNIT", sourceCodeUnitLength: text.length, boundaryOffsets: [0, text.length] };
  const artifactBytes = Buffer.from(JSON.stringify(artifact), "utf8");
  await minio.putObject(config.MINIO_BUCKET, boundaryArtifactKey, artifactBytes, artifactBytes.length, { "Content-Type": "application/json" });
  const boundaryArtifactDigest = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;

  const asset = await db.asset.create({
    data: {
      datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", status: AssetStatus.NEEDS_REVIEW,
      storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker,
      textAsset: { create: { sourceIdentity, sourceEncoding: "UTF8", offsetUnit: "UTF16_CODE_UNIT", sourceByteLength: bytes.length, sourceCodeUnitLength: text.length, boundaryArtifactKey, boundaryArtifactDigest, boundaryProfile, preparedSourceFingerprint: marker, preparedAt: new Date() } },
    },
    select: { id: true },
  });
  const entityLabel = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: workspaceUnique("Org"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
  assert.equal(entityLabel.ok, true);

  try {
    const selection = await readWorkspaceSelection(owner, dataset.id, asset.id);
    assert.ok(selection && selection.engine === "TEXT");
    if (!selection || selection.engine !== "TEXT") return;
    assert.equal(selection.source.readiness, "READY", "the source itself is still ready");
    assert.equal(selection.capabilities.span, false, "but the frozen workflow state blocks the write capability");
    assert.match(selection.capabilities.reasons.span ?? "", /review state/i);
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await minio.removeObject(config.MINIO_BUCKET, boundaryArtifactKey).catch(() => undefined);
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("readWorkspaceSelection: existing TEXT annotation rows are projected through the shared safe serializer, and a non-member is concealed as null", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("selection-annotations");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from("OpenAI builds AI.", "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const sourceIdentity = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker },
    select: { id: true },
  });
  const entityLabel = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: workspaceUnique("Company"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
  assert.equal(entityLabel.ok, true);
  if (!entityLabel.ok) return;
  await db.annotation.create({
    data: {
      datasetId: dataset.id, assetId: asset.id, createdById: owner.id, modality: Modality.TEXT, type: "NAMED_ENTITY_RECOGNITION", labelId: entityLabel.label.id,
      geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity, offsetUnit: "UTF16_CODE_UNIT", startOffset: 0, endOffset: 6 }, properties: { custom: {} },
    },
  });

  try {
    const selection = await readWorkspaceSelection(owner, dataset.id, asset.id);
    assert.ok(selection && selection.engine === "TEXT");
    if (!selection || selection.engine !== "TEXT") return;
    assert.equal(selection.annotations.length, 1);
    assert.equal(selection.annotations[0]?.geometry.kind, "text-span");
    assert.equal(selection.annotations[0]?.labelId, entityLabel.label.id);
    if (selection.annotations[0]?.geometry.kind === "text-span") {
      assert.equal(selection.annotations[0].geometry.startOffset, 0);
      assert.equal(selection.annotations[0].geometry.endOffset, 6);
    }

    assert.equal(await readWorkspaceSelection(outsider, dataset.id, asset.id), null);
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await cleanupWorkspaceFixture([owner.id, outsider.id], [dataset.id]);
  }
});
