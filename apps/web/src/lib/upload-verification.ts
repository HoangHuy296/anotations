import "server-only";

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { Readable } from "node:stream";

import { Modality } from "@internal/db";
import type { Client as MinioClient } from "minio";

import { MAX_DIRECT_UPLOAD_BYTES } from "@/lib/validation/upload";

const INSPECTION_BYTES = 64 * 1024;

export type VerifiedUpload = {
  modality: Modality;
  mimeType: string;
  sizeBytes: bigint;
  sourceFingerprint: string;
  width?: number;
  height?: number;
  textLength?: number;
};

export type UploadVerificationError = "UPLOAD_NOT_READY" | "UNSUPPORTED_MEDIA" | "INVALID_MEDIA";

export class UploadVerificationFailure extends Error {
  constructor(readonly code: UploadVerificationError) {
    super(code);
    this.name = "UploadVerificationFailure";
  }
}

async function readStream(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) break;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function startsWith(bytes: Buffer, signature: readonly number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function imageMetadata(bytes: Buffer) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { mimeType: "image/webp" };
  return null;
}

function mediaMetadata(bytes: Buffer) {
  const image = imageMetadata(bytes);
  if (image) return { modality: Modality.IMAGE, ...image };
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return { modality: Modality.VIDEO, mimeType: "video/mp4" };
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { modality: Modality.VIDEO, mimeType: "video/webm" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return { modality: Modality.AUDIO, mimeType: "audio/wav" };
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)) return { modality: Modality.AUDIO, mimeType: "audio/mpeg" };
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") return { modality: Modality.AUDIO, mimeType: "audio/ogg" };
  return null;
}

function verifiedText(bytes: Buffer, candidateContentType: string) {
  if (!new Set(["text/plain", "text/csv", "application/json"]).has(candidateContentType)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text || text.includes("\u0000")) return null;
    // Only a bounded prefix is inspected; full text length is deliberately not guessed.
    return { modality: Modality.TEXT, mimeType: "text/plain" };
  } catch {
    return null;
  }
}

export async function verifyUploadedObject(
  minio: MinioClient,
  bucket: string,
  objectKey: string,
  expectedSize: number,
  candidateContentType: string,
): Promise<VerifiedUpload> {
  let stat;
  try {
    stat = await minio.statObject(bucket, objectKey);
  } catch {
    throw new UploadVerificationFailure("UPLOAD_NOT_READY");
  }
  if (!stat.size || stat.size !== expectedSize || stat.size > MAX_DIRECT_UPLOAD_BYTES) {
    throw new UploadVerificationFailure("UPLOAD_NOT_READY");
  }

  let bytes: Buffer;
  try {
    bytes = await readStream(await minio.getPartialObject(bucket, objectKey, 0, Math.min(stat.size, INSPECTION_BYTES)), INSPECTION_BYTES);
  } catch {
    throw new UploadVerificationFailure("UPLOAD_NOT_READY");
  }
  if (bytes.length === 0) throw new UploadVerificationFailure("INVALID_MEDIA");

  const media = mediaMetadata(bytes) ?? verifiedText(bytes, candidateContentType);
  if (!media) throw new UploadVerificationFailure("UNSUPPORTED_MEDIA");

  const fingerprint = createHash("sha256")
    .update(`${objectKey}:${stat.etag ?? ""}:${stat.size}`)
    .digest("hex");
  return {
    ...media,
    sizeBytes: BigInt(stat.size),
    sourceFingerprint: fingerprint,
  };
}
