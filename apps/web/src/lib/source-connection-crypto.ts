import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function key() {
  const encoded = process.env.SOURCE_CONNECTION_ENCRYPTION_KEY;
  if (!encoded) throw new Error("Source connection encryption is not configured.");
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32) throw new Error("Source connection encryption key is invalid.");
  return value;
}

export function encryptSourceToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${VERSION}.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSourceToken(value: string) {
  const [version, ivValue, tagValue, cipherValue] = value.split(".");
  if (version !== VERSION || !ivValue || !tagValue || !cipherValue) throw new Error("Source connection token is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cipherValue, "base64url")), decipher.final()]).toString("utf8");
}
