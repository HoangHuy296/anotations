import { createDecipheriv } from "node:crypto";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { normalizeSourceRootPath, validateSourceBaseUrl, validateSourceImportLimits } from "@fieldframe/domain";

export type SourceAccessResolution =
  | { kind: "not-applicable" }
  | { kind: "ready"; sourceConnectionId: string; baseUrl: string; token: string; rootPath: string }
  | { kind: "refused"; errorCode: "SOURCE_TOKEN_EXPIRED" | "SOURCE_CONNECTION_NOT_FOUND" | "SOURCE_URL_UNSAFE" | "SOURCE_ROOT_PATH_UNSAFE" | "SOURCE_TOKEN_INVALID" | "SOURCE_IMPORT_LIMIT_EXCEEDED" };

function decryptToken(value: string) {
  const encoded = process.env.SOURCE_CONNECTION_ENCRYPTION_KEY;
  if (!encoded) return null;
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) return null;
  const [version, ivValue, tagValue, cipherValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !cipherValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(cipherValue, "base64url")), decipher.final()]).toString("utf8");
  } catch { return null; }
}

/** Re-resolves authoritative state; it never consumes queue payload configuration. */
export async function resolveSourceAccessForJob(db: PrismaClient, jobId: string): Promise<SourceAccessResolution> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { sourceConnectionId: true, input: true, createdById: true, createdBy: { select: { role: true } } },
  });
  if (!job?.sourceConnectionId) return { kind: "not-applicable" };
  const connection = await db.sourceConnection.findUnique({
    where: { id: job.sourceConnectionId },
    select: { id: true, userId: true, baseUrl: true, tokenEncrypted: true, tokenExpiresAt: true, status: true, revokedAt: true },
  });
  if (!connection || connection.revokedAt || connection.status !== "ACTIVE" || (!connection.tokenEncrypted)) return { kind: "refused", errorCode: "SOURCE_CONNECTION_NOT_FOUND" };
  if (connection.tokenExpiresAt && connection.tokenExpiresAt <= new Date()) {
    await db.sourceConnection.updateMany({ where: { id: connection.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
    return { kind: "refused", errorCode: "SOURCE_TOKEN_EXPIRED" };
  }
  if (job.createdById !== connection.userId && job.createdBy.role !== "ADMIN") return { kind: "refused", errorCode: "SOURCE_CONNECTION_NOT_FOUND" };
  const address = await validateSourceBaseUrl(connection.baseUrl);
  if (!address.ok) return { kind: "refused", errorCode: "SOURCE_URL_UNSAFE" };
  const source = job.input && typeof job.input === "object" && !Array.isArray(job.input)
    ? (job.input as Record<string, unknown>).source
    : undefined;
  const sourceRecord = source && typeof source === "object" && !Array.isArray(source)
    ? source as Record<string, unknown>
    : null;
  const repository = sourceRecord?.repository && typeof sourceRecord.repository === "object" && !Array.isArray(sourceRecord.repository)
    ? sourceRecord.repository as Record<string, unknown>
    : null;
  const rawRoot = typeof repository?.normalizedRootPath === "string" ? repository.normalizedRootPath : "";
  const rootPath = normalizeSourceRootPath(rawRoot);
  if (!rootPath.ok) return { kind: "refused", errorCode: "SOURCE_ROOT_PATH_UNSAFE" };
  const manifest = sourceRecord?.manifest && typeof sourceRecord.manifest === "object" && !Array.isArray(sourceRecord.manifest) ? sourceRecord.manifest as Record<string, unknown> : null;
  const limitResult = validateSourceImportLimits({ itemCount: typeof manifest?.itemCount === "number" ? manifest.itemCount : 0, declaredBytes: typeof manifest?.declaredBytes === "number" ? manifest.declaredBytes : 0, ...(typeof manifest?.durationMs === "number" ? { durationMs: manifest.durationMs } : {}) });
  if (!limitResult.ok) return { kind: "refused", errorCode: "SOURCE_IMPORT_LIMIT_EXCEEDED" };
  const token = decryptToken(connection.tokenEncrypted);
  return token ? { kind: "ready", sourceConnectionId: connection.id, baseUrl: address.value.toString(), token, rootPath: rootPath.value } : { kind: "refused", errorCode: "SOURCE_TOKEN_INVALID" };
}
