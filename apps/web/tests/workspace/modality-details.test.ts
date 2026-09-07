import assert from "node:assert/strict";
import test from "node:test";

import { Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { readWorkspaceSelection } from "@/lib/workspace/workspace-read";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/**
 * T013 (022) -- proves Audio/Text `{Modality} Details` now carry real,
 * asset-specific metadata (FR-031) rather than the pre-022 filename-only
 * placeholder, sourced from fields the schema already had
 * (`AudioAsset`/`TextAsset`/base `Asset` columns) with zero migration.
 */
test("AUDIO selection carries real AudioAsset metadata, not just a filename", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("audio-details");
    const asset = await db.asset.create({
      data: {
        datasetId: dataset.id, modality: Modality.AUDIO, filename: `${marker}.wav`, mimeType: "audio/wav",
        sourceFingerprint: marker, durationMs: 125_000,
        audioAsset: { create: { sampleRate: 48_000, channels: 2, codec: "pcm_s16le", bitRate: 192_000, waveformKey: `waveforms/${marker}.json` } },
      },
      select: { id: true },
    });
    const selection = await readWorkspaceSelection(owner, dataset.id, asset.id);
    assert.equal(selection?.engine, "AUDIO");
    if (selection?.engine !== "AUDIO") return;
    assert.equal(selection.readiness.audio?.durationMs, 125_000);
    assert.equal(selection.readiness.audio?.sampleRate, 48_000);
    assert.equal(selection.readiness.audio?.channels, 2);
    assert.equal(selection.readiness.audio?.codec, "pcm_s16le");
    assert.equal(selection.readiness.audio?.bitRate, 192_000);
    assert.equal(selection.readiness.audio?.waveformReady, true, "a stored waveformKey means the waveform is ready");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("AUDIO selection reports waveformReady=false when no waveform has been generated yet", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("audio-no-waveform");
    const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.AUDIO, filename: `${marker}.wav`, mimeType: "audio/wav", sourceFingerprint: marker, audioAsset: { create: {} } }, select: { id: true } });
    const selection = await readWorkspaceSelection(owner, dataset.id, asset.id);
    assert.equal(selection?.engine, "AUDIO");
    if (selection?.engine !== "AUDIO") return;
    assert.equal(selection.readiness.audio?.waveformReady, false);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("TEXT selection carries real TextAsset/Asset metadata, not just a filename", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("text-details");
    const asset = await db.asset.create({
      data: {
        datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain",
        sourceFingerprint: marker, textLength: 4_200,
        textAsset: { create: { language: "en", content: "irrelevant to this assertion" } },
      },
      select: { id: true },
    });
    const selection = await readWorkspaceSelection(owner, dataset.id, asset.id);
    assert.equal(selection?.engine, "TEXT");
    if (selection?.engine !== "TEXT") return;
    assert.equal(selection.asset.language, "en");
    assert.equal(selection.asset.textLength, 4_200);
    assert.equal(selection.asset.mimeType, "text/plain");
    assert.ok(selection.asset.createdAt, "createdAt must be populated");
    assert.ok(selection.asset.updatedAt, "updatedAt must be populated");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("TEXT selection reports Unknown-safe nulls when no TextAsset row exists yet", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("text-no-textasset");
    const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", sourceFingerprint: marker } }, );
    const selection = await readWorkspaceSelection(owner, dataset.id, asset.id);
    assert.equal(selection?.engine, "TEXT");
    if (selection?.engine !== "TEXT") return;
    assert.equal(selection.asset.language, null);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
