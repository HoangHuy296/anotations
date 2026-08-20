import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { DirectUploadConfig } from "@annotationplatform/domain";

export const UPLOAD_CAPABILITY_TTL_SECONDS = 10 * 60;
export const VIEW_CAPABILITY_TTL_SECONDS = 5 * 60;

export type UploadCapability = {
  purpose: "upload";
  actorId: string;
  datasetId: string;
  objectKey: string;
  filename: string;
  candidateContentType: string;
  sizeBytes: number;
  nonce: string;
  expiresAt: number;
  preparedImportId?: string;
  preparedImportItemId?: string;
};

function encryptionKey(secret: string) { return createHash("sha256").update(secret).digest(); }

function encrypt(value: unknown, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function createPreparedImportUploadCapability(
  config: Pick<DirectUploadConfig, "UPLOAD_CAPABILITY_SECRET">,
  input: Omit<UploadCapability, "purpose" | "objectKey" | "nonce" | "expiresAt" | "preparedImportId" | "preparedImportItemId"> & { objectKey: string; preparedImportId: string; preparedImportItemId: string; nowSeconds?: number },
) {
  const nonce = randomBytes(18).toString("base64url");
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: UploadCapability = {
    actorId: input.actorId, datasetId: input.datasetId, filename: safeFilename(input.filename), candidateContentType: input.candidateContentType,
    sizeBytes: input.sizeBytes, objectKey: input.objectKey, preparedImportId: input.preparedImportId, preparedImportItemId: input.preparedImportItemId,
    purpose: "upload", nonce, expiresAt: nowSeconds + UPLOAD_CAPABILITY_TTL_SECONDS,
  };
  return { payload, token: encrypt(payload, config.UPLOAD_CAPABILITY_SECRET) };
}

function decrypt(token: string, secret: string): unknown | null {
  const [encodedIv, encodedCiphertext, encodedTag, ...extra] = token.split(".");
  if (!encodedIv || !encodedCiphertext || !encodedTag || extra.length) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(encodedIv, "base64url"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, "base64url")), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

function safeFilename(filename: string) {
  const normalized = filename.normalize("NFKC").replace(/[\\/\u0000-\u001F]/g, "-").trim();
  return normalized || "upload";
}

export function createUploadCapability(
  config: Pick<DirectUploadConfig, "UPLOAD_CAPABILITY_SECRET">,
  input: Omit<UploadCapability, "purpose" | "objectKey" | "nonce" | "expiresAt">,
) {
  const nonce = randomBytes(18).toString("base64url");
  const filename = safeFilename(input.filename);
  const payload: UploadCapability = {
    ...input,
    purpose: "upload",
    filename,
    nonce,
    objectKey: `direct-uploads/${input.datasetId}/${input.actorId}/${nonce}/${filename}`,
    expiresAt: Math.floor(Date.now() / 1000) + UPLOAD_CAPABILITY_TTL_SECONDS,
  };
  return { payload, token: encrypt(payload, config.UPLOAD_CAPABILITY_SECRET) };
}

export function verifyUploadCapability(
  config: Pick<DirectUploadConfig, "UPLOAD_CAPABILITY_SECRET">,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): UploadCapability | null {
  const parsed = decrypt(token, config.UPLOAD_CAPABILITY_SECRET);
  if (!isUploadCapability(parsed) || parsed.expiresAt <= nowSeconds) return null;
  return parsed;
}

function isUploadCapability(value: unknown): value is UploadCapability {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.purpose === "upload"
    && typeof item.actorId === "string"
    && typeof item.datasetId === "string"
    && typeof item.objectKey === "string"
    && typeof item.filename === "string"
    && typeof item.candidateContentType === "string"
    && typeof item.sizeBytes === "number"
    && typeof item.nonce === "string"
    && typeof item.expiresAt === "number";
}
