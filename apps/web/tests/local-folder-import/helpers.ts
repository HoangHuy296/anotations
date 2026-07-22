import { createHash } from "node:crypto";

import { DatasetSourceMode, JobStatus, JobType, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";

/** Never guess a database/MinIO target from a developer's default .env. */
export const hasImportIntegration = process.env.LOCAL_IMPORT_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/** Host-runner integration tests talk to the loopback-published MinIO port.
 * Compose services themselves retain `minio:9000` as their internal endpoint. */
export function configureLocalImportHostMinio() {
  if (!hasImportIntegration) return;
  process.env.MINIO_ENDPOINT = "http://localhost:9000";
  process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
}

export function safeManifestItem(logicalPath: string, contentType = "text/plain", body = "fixture") {
  return { logicalPath, contentType, sizeBytes: Buffer.byteLength(body), fingerprint: createHash("sha256").update(body).digest("hex") };
}

export function noSensitiveImportFields(value: unknown) {
  const text = JSON.stringify(value);
  return !/(storageKey|objectKey|secret|password|credential|absolutePath)/i.test(text);
}

export function buildSafeManifest(items: Array<{ logicalPath: string; contentType?: string; body?: string }> = [{ logicalPath: "folder/readme.txt" }]) {
  return items.map((item) => safeManifestItem(item.logicalPath, item.contentType, item.body));
}

export async function createPreparedImportFixture(options: { expectedItemCount?: number; status?: JobStatus; deadlineAt?: Date } = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const owner = await db.user.create({ data: { email: `import-${suffix}@test.local`, role: UserRole.MANAGER }, select: { id: true, role: true, email: true, name: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `Import ${suffix}`, sourceMode: DatasetSourceMode.UPLOAD }, select: { id: true } });
  const job = await db.job.create({ data: { datasetId: dataset.id, createdById: owner.id, type: JobType.IMPORT_DATASET, status: options.status ?? JobStatus.RUNNING, totalItems: options.expectedItemCount ?? 1, input: {} }, select: { id: true } });
  const preparedImport = await db.preparedImport.create({ data: { datasetId: dataset.id, jobId: job.id, createdById: owner.id, expectedItemCount: options.expectedItemCount ?? 1, deadlineAt: options.deadlineAt ?? new Date(Date.now() + 60_000), idempotencyKey: `test-${suffix}` }, select: { id: true, datasetId: true, jobId: true } });
  return { owner: { ...owner, name: owner.name ?? owner.email }, dataset, job, preparedImport, cleanup: async () => { await db.dataset.delete({ where: { id: dataset.id } }); await db.user.delete({ where: { id: owner.id } }); } };
}

export async function createPreparedImportItemFixture(preparedImportId: string, input: { position?: number; key?: string; mimeType?: string; sizeBytes?: number; logicalPath?: string } = {}) {
  const position = input.position ?? 0;
  const logicalPath = input.logicalPath ?? `folder/item-${position}.txt`;
  return db.preparedImportItem.create({ data: { preparedImportId, position, logicalPath, normalizedPath: logicalPath.toLowerCase(), filename: logicalPath.split("/").at(-1)!, mimeType: input.mimeType ?? "text/plain", sizeBytes: BigInt(input.sizeBytes ?? 7), modality: "TEXT", fingerprint: createHash("sha256").update(logicalPath).digest("hex"), storageKey: input.key ?? `uploads/import-${preparedImportId}/fixture-${position}` }, select: { id: true, storageKey: true } });
}

export async function uploadTestObject(key: string, body = Buffer.from("fixture"), contentType = "text/plain") {
  const { config, minio } = getDirectUploadProviders();
  await minio.putObject(config.MINIO_BUCKET, key, body, body.length, { "Content-Type": contentType });
}

export async function listObjectsUnderPrefix(prefix: string) {
  const { config, minio } = getDirectUploadProviders();
  return new Promise<string[]>((resolve, reject) => { const keys: string[] = []; const stream = minio.listObjects(config.MINIO_BUCKET, prefix, true); stream.on("data", (entry) => { if (entry.name) keys.push(entry.name); }); stream.once("error", reject); stream.once("end", () => resolve(keys)); });
}

export async function objectExists(key: string) { const { config, minio } = getDirectUploadProviders(); try { await minio.statObject(config.MINIO_BUCKET, key); return true; } catch { return false; } }
export async function readObjectMetadata(key: string) { const { config, minio } = getDirectUploadProviders(); return minio.statObject(config.MINIO_BUCKET, key); }
export async function clearImportPrefix(preparedImportId: string) { const { config, minio } = getDirectUploadProviders(); const keys = await listObjectsUnderPrefix(`prepared-imports/${preparedImportId}/`); if (keys.length) await minio.removeObjects(config.MINIO_BUCKET, keys); }
