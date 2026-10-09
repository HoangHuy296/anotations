import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { Modality, StorageProvider, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { updateAudioDescription } from "@/lib/workspace/audio-mutations";
import { updateVideoDescription } from "@/lib/workspace/video-mutations";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "./helpers";

// Contract: the AUDIO workspace's properties come from AUDIO data and its description is saved by an AUDIO-scoped, revision-guarded mutation. (The panel used to be a copy of the VIDEO one:
// it read the module-level VIDEO annotation store and called the VIDEO-scoped description mutation, whose `modality: VIDEO` predicate matched no AUDIO row, so a description never saved.)
const enabled = Boolean(process.env.DATABASE_URL);
const users: string[] = [];
const datasets: string[] = [];
after(async () => { if (users.length || datasets.length) await cleanupWorkspaceFixture(users, datasets); });
const source = readFileSync(new URL("../../src/components/workspace/audio-properties-tabs.tsx", import.meta.url), "utf8");

const mediaAsset = (datasetId: string, modality: Modality, mimeType: string) => db.asset.create({
  data: { datasetId, modality, filename: `${workspaceUnique(modality)}.bin`, mimeType, sourceFingerprint: `audio-props:${randomUUID()}`, sizeBytes: BigInt(1234), storageProvider: StorageProvider.MINIO,
    ...(modality === Modality.AUDIO ? { audioAsset: { create: { metadata: {} } } } : { videoAsset: { create: { metadata: {} } } }) },
  select: { id: true, revision: true },
});

test("AUDIO description: saved through the AUDIO-scoped mutation, revision-guarded, persisted across a reload; the VIDEO-scoped mutation cannot touch an AUDIO asset", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER); users.push(owner.id);
  const actor = { id: owner.id, role: owner.role, email: owner.email, name: owner.name };
  const audioDataset = await createWorkspaceDataset(owner.id, Modality.AUDIO); datasets.push(audioDataset.id);
  const videoDataset = await createWorkspaceDataset(owner.id, Modality.VIDEO); datasets.push(videoDataset.id);
  const audio = await mediaAsset(audioDataset.id, Modality.AUDIO, "audio/wav");
  const video = await mediaAsset(videoDataset.id, Modality.VIDEO, "video/mp4");

  const saved = await updateAudioDescription(actor, { datasetId: audioDataset.id, assetId: audio.id, version: audio.revision, description: "speaker A, intro" });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.value.description, "speaker A, intro"); assert.equal(saved.value.version, audio.revision + 1);
  assert.equal((await db.asset.findUniqueOrThrow({ where: { id: audio.id }, select: { description: true } })).description, "speaker A, intro", "durable after a reload");

  const stale = await updateAudioDescription(actor, { datasetId: audioDataset.id, assetId: audio.id, version: audio.revision, description: "stale overwrite" });
  assert.deepEqual(stale, { ok: false, status: 409 }, "a stale revision cannot overwrite");
  assert.equal((await db.asset.findUniqueOrThrow({ where: { id: audio.id }, select: { description: true } })).description, "speaker A, intro");

  const cleared = await updateAudioDescription(actor, { datasetId: audioDataset.id, assetId: audio.id, version: saved.value.version, description: null });
  assert.equal(cleared.ok, true); assert.equal(cleared.ok && cleared.value.description, null);

  assert.deepEqual(await updateVideoDescription(actor, { datasetId: audioDataset.id, assetId: audio.id, version: saved.value.version + 1, description: "via the VIDEO mutation" }), { ok: false, status: 404 }, "the VIDEO-scoped mutation matches no AUDIO asset");
  assert.deepEqual(await updateAudioDescription(actor, { datasetId: videoDataset.id, assetId: video.id, version: video.revision, description: "wrong engine" }), { ok: false, status: 404 }, "the AUDIO mutation never writes a VIDEO asset");
  assert.deepEqual(await updateAudioDescription(actor, { datasetId: videoDataset.id, assetId: audio.id, version: 0, description: "wrong dataset" }), { ok: false, status: 404 }, "an asset is only reachable through its own Dataset");
  const outsider = await createWorkspaceUser(UserRole.LABELER); users.push(outsider.id);
  const denied = await updateAudioDescription({ id: outsider.id, role: outsider.role, email: outsider.email, name: outsider.name }, { datasetId: audioDataset.id, assetId: audio.id, version: 0, description: "no access" });
  assert.equal(denied.ok, false); assert.ok(!denied.ok && [403, 404].includes(denied.status), "a non-member cannot write");
});

test("AUDIO properties panel contract: derived from AUDIO data only - no VIDEO store, VIDEO action, tracks, keyframes or interpolation", () => {
  for (const forbidden of ["useVideoAnnotationStore", "video-annotation-store", "video-annotation-client", "SafeVideoTrack", "updateVideoDescriptionAction", "Video details", "VIDEO\"", "trackList", "keyframeList", "Interpolation", "Object ID"]) assert.ok(!source.includes(forbidden), `must not contain ${forbidden}`);
  assert.ok(source.includes("updateAudioDescriptionAction") && source.includes("audio-description:") && source.includes("Audio details") && source.includes('<Badge variant="info">AUDIO</Badge>'));
  for (const fact of ["durationMs", "sampleRate", "channels", "codec", "waveformReady"]) assert.ok(source.includes(`audio?.${fact}`) || source.includes(`audio.${fact}`), `shows ${fact} from the AUDIO readiness`);
  assert.ok(source.includes("selection.readiness.audio"));
  assert.match(source, /\(\["description", "labels", "assets"\] as const\)/, "no tracks tab: there is no AUDIO annotation model in this phase");
});
