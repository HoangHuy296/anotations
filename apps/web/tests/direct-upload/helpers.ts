import { randomBytes } from "node:crypto";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";

export const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

export function configureDirectUploadTestEnvironment() {
  if (!process.env.UPLOAD_CAPABILITY_SECRET) process.env.UPLOAD_CAPABILITY_SECRET = randomBytes(48).toString("base64");
  process.env.MINIO_PUBLIC_ENDPOINT = "http://minio:9000";
  process.env.MINIO_CORS_ALLOWED_ORIGIN = "http://localhost:3000";
}

export function pngFixture() {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
}

export function fixtureBytes(contentType: string) {
  if (contentType === "image/png") return pngFixture();
  if (contentType === "video/mp4") return Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  if (contentType === "text/plain") return Buffer.from("fieldframe direct upload", "utf8");
  if (contentType === "audio/wav") return Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  throw new Error(`Unsupported test type: ${contentType}`);
}

export async function createDirectUploadActors(password: string, suffix: string) {
  const passwordHash = await hashPassword(password);
  const [manager, outsider] = await Promise.all([
    db.user.create({ data: { email: `upload-manager-${suffix}@phase006.test`, passwordHash, role: UserRole.MANAGER }, select: { id: true, email: true } }),
    db.user.create({ data: { email: `upload-outsider-${suffix}@phase006.test`, passwordHash, role: UserRole.LABELER }, select: { id: true, email: true } }),
  ]);
  const dataset = await db.dataset.create({ data: { ownerId: manager.id, name: `Direct upload ${suffix}` }, select: { id: true } });
  return {
    manager,
    outsider,
    dataset,
    cleanup: async () => {
      const { config, minio } = getDirectUploadProviders();
      const keys = await new Promise<string[]>((resolve, reject) => {
        const found: string[] = [];
        const stream = minio.listObjects(config.MINIO_BUCKET, `direct-uploads/${dataset.id}/`, true);
        stream.on("data", (item) => { if (item.name) found.push(item.name); });
        stream.once("error", reject);
        stream.once("end", () => resolve(found));
      });
      if (keys.length) await minio.removeObjects(config.MINIO_BUCKET, keys);
      await db.dataset.deleteMany({ where: { id: dataset.id } });
      await db.user.deleteMany({ where: { id: { in: [manager.id, outsider.id] } } });
    },
  };
}

export async function addReadOnlyMember(datasetId: string, userId: string) {
  return db.datasetMember.create({ data: { datasetId, userId, role: DatasetMemberRole.LABELER } });
}
