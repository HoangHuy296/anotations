import "server-only";
import { createHash } from "node:crypto";
import { projectAnnotation } from "@/lib/visualization/annotation-adapter";
import { db } from "@/lib/db";
import { getWebProviders } from "@/lib/providers";
import { VISUALIZATION_CAPTURE_ALGORITHM, VISUALIZATION_PREVIEW_ALGORITHM, VISUALIZATION_PROFILE_ALGORITHM, snapshotDescriptorSchema, visualizationProfileSchema } from "@annotationplatform/domain/visualization-processing";
import { VisualizationReadError } from "@/lib/visualization/dataset-read";

export async function artifactBytes(artifact: { bucket: string; key: string; sha256: string; sizeBytes: bigint }, maxBytes = 32 * 1024 * 1024) {
  if (artifact.sizeBytes > BigInt(maxBytes)) throw new VisualizationReadError(409, "ASSET_UNAVAILABLE", "Artifact unavailable.");
  const { minio } = getWebProviders();
  const stream = await minio.getObject(artifact.bucket, artifact.key);
  const parts: Buffer[] = []; let size = 0;
  try { for await (const part of stream) { size += part.length; if (size > maxBytes) throw new Error("Artifact exceeds limit"); parts.push(Buffer.from(part)); } }
  finally { stream.destroy(); }
  const bytes = Buffer.concat(parts);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Artifact checksum mismatch");
  return bytes;
}
export async function readVersions(datasetId: string, page: number, pageSize: number) {
  const [rows, total, state] = await Promise.all([
    db.datasetSnapshot.findMany({ where: { datasetId }, orderBy: { ordinal: "desc" }, skip: (page - 1) * pageSize, take: pageSize, select: { id: true, ordinal: true, generation: true, assetCount: true, annotationCount: true, publishedAt: true } }),
    db.datasetSnapshot.count({ where: { datasetId } }), readDerivedState(datasetId),
  ]);
  return { items: rows.map(row => ({ ...row, generation: row.generation.toString(), publishedAt: row.publishedAt.toISOString() })), total, page, pageSize, state };
}
export async function readDerivedState(datasetId: string) {
  const dataset = await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { visualizationGeneration: true, visualizationCurrentSnapshotId: true } });
  const snapshot = dataset.visualizationCurrentSnapshotId ? await db.datasetSnapshot.findFirst({ where: { id: dataset.visualizationCurrentSnapshotId, datasetId }, select: { id: true, generation: true } }) : null;
  const current = snapshot?.generation === dataset.visualizationGeneration;
  const job = await db.job.findFirst({ where: { datasetId, type: { in: ["VISUALIZATION_CAPTURE", "VISUALIZATION_DERIVE"] }, input: { path: ["generation"], equals: dataset.visualizationGeneration.toString() } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { status: true } });
  const profile = current ? await db.visualizationArtifact.findFirst({ where: { datasetId, snapshotId: snapshot!.id, kind: "PROFILE", algorithm: VISUALIZATION_PROFILE_ALGORITHM }, select: { id: true } }) : null;
  const sourceCount = current ? await db.visualizationArtifact.count({ where: { datasetId, snapshotId: snapshot!.id, kind: "SOURCE_IMAGE", algorithm: VISUALIZATION_CAPTURE_ALGORITHM } }) : 0;
  const previewCount = current ? await db.visualizationArtifact.count({ where: { datasetId, snapshotId: snapshot!.id, kind: { in: ["THUMBNAIL", "PREVIEW"] }, algorithm: VISUALIZATION_PREVIEW_ALGORITHM } }) : 0;
  const status = profile && previewCount === sourceCount * 2 ? "ready" : job?.status === "RUNNING" ? "processing" : job?.status === "FAILED" || job?.status === "CANCELED" ? "failed" : "pending";
  return { status, generation: dataset.visualizationGeneration.toString(), snapshotId: snapshot?.id ?? null, current: Boolean(current) };
}
export async function currentPreview(datasetId: string, assetId: string, kind: "THUMBNAIL" | "PREVIEW") {
  const dataset = await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { visualizationGeneration: true, visualizationCurrentSnapshotId: true } });
  if (!dataset.visualizationCurrentSnapshotId) return null;
  return db.visualizationArtifact.findFirst({ where: { datasetId, snapshotId: dataset.visualizationCurrentSnapshotId, kind, scope: assetId, algorithm: VISUALIZATION_PREVIEW_ALGORITHM, snapshot: { generation: dataset.visualizationGeneration } } });
}
export async function readPublishedProfile(datasetId: string) {
  const state = await readDerivedState(datasetId);
  // A new capture without ready derivations must not hide the previous valid profile.
  const artifact = await db.visualizationArtifact.findFirst({ where: { datasetId, kind: "PROFILE", algorithm: VISUALIZATION_PROFILE_ALGORITHM }, orderBy: [{ snapshot: { ordinal: "desc" } }, { id: "asc" }] });
  if (!artifact) return { state, profile: null, profileSnapshotId: null, profileCurrent: false };
  const bytes = await artifactBytes(artifact, 2 * 1024 * 1024);
  const profile = visualizationProfileSchema.parse(JSON.parse(bytes.toString()));
  return { state, profile: { ...profile, labels: profile.labels.slice(0, 50), labelsTruncated: profile.labels.length > 50 }, profileSnapshotId: artifact.snapshotId, profileCurrent: state.current && state.snapshotId === artifact.snapshotId };
}
export async function readSnapshotContent(datasetId: string, snapshotId: string, page: number, pageSize: number) {
  const artifact = await db.visualizationArtifact.findFirst({ where: { datasetId, snapshotId, kind: "CAPTURE", algorithm: VISUALIZATION_CAPTURE_ALGORITHM } });
  if (!artifact) throw new VisualizationReadError(404, "DATASET_NOT_FOUND", "Snapshot not found.");
  const descriptor = snapshotDescriptorSchema.parse(JSON.parse((await artifactBytes(artifact)).toString()));
  const assets = descriptor.content.assets.slice((page - 1) * pageSize, page * pageSize);
  const ids = new Set(assets.map(a => a.id));
  const annotations = descriptor.content.annotations.filter(a => ids.has(a.assetId));
  const media = await db.visualizationArtifact.findMany({ where: { datasetId, snapshotId, scope: { in: [...ids] }, kind: "SOURCE_IMAGE", algorithm: VISUALIZATION_CAPTURE_ALGORITHM }, select: { id: true, scope: true, kind: true } });
  return { id: snapshotId, generation: descriptor.generation, dataset: descriptor.content.dataset, items: assets.map(asset => ({ id: asset.id, filename: asset.filename, modality: asset.modality, mimeType: asset.mimeType, width: asset.width, height: asset.height, imageArtifactId: media.find(m => m.scope === asset.id)?.id ?? null })), total: descriptor.content.assets.length, page, pageSize,
    annotations: annotations.slice(0, 500).map(annotation => { const asset = assets.find(a => a.id === annotation.assetId)!; const label = descriptor.content.labels.find(l => l.id === annotation.labelId); return { assetId: annotation.assetId, ...projectAnnotation({ ...annotation, label: label ? { id: label.id, name: label.name, color: /^#[0-9a-f]{6}$/i.test(label.color) ? label.color : "#64748b" } : null }, asset.width, asset.height) }; }), annotationsTruncated: annotations.length > 500,
    labels: descriptor.content.labels.slice(0, 500), labelsTruncated: descriptor.content.labels.length > 500 };
}
export async function readSnapshotArtifact(datasetId: string, artifactId: string) {
  const artifact = await db.visualizationArtifact.findFirst({ where: { datasetId, id: artifactId, kind: { in: ["THUMBNAIL", "PREVIEW", "SOURCE_IMAGE"] } } });
  if (!artifact) throw new VisualizationReadError(404, "ASSET_NOT_IN_DATASET", "Artifact not found.");
  return new Response(new Uint8Array(await artifactBytes(artifact)), { headers: { "Content-Type": artifact.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Visualization-Preview": artifact.kind === "SOURCE_IMAGE" ? "original" : "ready" } });
}
