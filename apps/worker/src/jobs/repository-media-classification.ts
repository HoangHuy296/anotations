import { TextDecoder } from "node:util";

import { defaultMediaProcessingPolicy } from "../media/policy.js";
import { runBoundedMediaProcess } from "../media/subprocess.js";
import { materializePrivateSource } from "../media/source-materialization.js";
import { withJobTempWorkspace } from "../media/temp-workspace.js";
import { createWorkerMinio } from "../providers/minio.js";
import { getWorkerConfig, getRepositoryImportPolicy } from "../config.js";

export type VerifiedRepositoryModality = "IMAGE" | "VIDEO" | "AUDIO" | "TEXT";

/**
 * Repository MIME contract: the stored Content-Type and `Asset.mimeType` are what the BYTES prove, never the file extension.
 * - Header-definitive formats: PNG -> image/png, JPEG -> image/jpeg, WebP -> image/webp, WAV -> audio/wav, MP3 (ID3/frame sync) -> audio/mpeg.
 * - TEXT: valid UTF-8 without control characters proves text only, so the verified type is text/plain (csv/json subtypes are declarations the bytes cannot prove;
 *   this is the same rule as direct upload, `apps/web/src/lib/upload-verification.ts`).
 * - Containers (ffprobe `format_name`): `mov,mp4,m4a,3gp,3g2,mj2` + video -> video/mp4, `matroska,webm` + video -> video/webm, `ogg` -> audio/ogg, `mp3` -> audio/mpeg,
 *   `wav` -> audio/wav. Any other container/stream combination keeps its modality but has an UNVERIFIED subtype: application/octet-stream.
 * The extension only ever decides which files are candidates; it never decides the stored type.
 */
export const UNVERIFIED_CONTENT_TYPE = "application/octet-stream";
export type VerifiedRepositoryObject = { modality: VerifiedRepositoryModality; mimeType: string };

async function readPrefix(client: ReturnType<typeof createWorkerMinio>, bucket: string, key: string) {
  const stream = await client.getPartialObject(bucket, key, 0, 64 * 1024);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 64 * 1024) throw new Error("SOURCE_CONTENT_UNVERIFIED");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function classifyDefinitiveHeaderDetailed(bytes: Buffer): VerifiedRepositoryObject | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { modality: "IMAGE", mimeType: "image/png" } : null;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { modality: "IMAGE", mimeType: "image/jpeg" };
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { modality: "IMAGE", mimeType: "image/webp" };
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return { modality: "AUDIO", mimeType: "audio/wav" };
  if (bytes.subarray(0, 3).equals(Buffer.from("ID3")) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return { modality: "AUDIO", mimeType: "audio/mpeg" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return { modality: "TEXT", mimeType: "text/plain" };
  } catch { /* Binary/ambiguous prefix; ffprobe or rejection below. */ }
  return null;
}

export function classifyDefinitiveHeader(bytes: Buffer): VerifiedRepositoryModality | null {
  return classifyDefinitiveHeaderDetailed(bytes)?.modality ?? null;
}

/**
 * Interprets bounded ffprobe stream JSON. Anything that is not a clearly identified
 * video or audio stream (including unparseable output and data/subtitle-only
 * containers) fails closed; a container with both video and audio is VIDEO.
 */
export function classifyProbeOutput(stdout: string): VerifiedRepositoryModality {
  return classifyProbeDetailed(stdout).modality;
}

/** Same fail-closed interpretation as `classifyProbeOutput`, plus the content-verified subtype from the container's `format_name`. */
export function classifyProbeDetailed(stdout: string): VerifiedRepositoryObject {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("SOURCE_CONTENT_UNVERIFIED"); }
  const document = parsed && typeof parsed === "object" ? parsed as { streams?: unknown; format?: { format_name?: unknown } } : {};
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const kinds = streams.flatMap((stream) => stream && typeof stream === "object" && typeof (stream as { codec_type?: unknown }).codec_type === "string"
    ? [(stream as { codec_type: string }).codec_type] : []);
  const formatName = typeof document.format?.format_name === "string" ? document.format.format_name : "";
  if (kinds.includes("video")) return { modality: "VIDEO", mimeType: formatName === "mov,mp4,m4a,3gp,3g2,mj2" ? "video/mp4" : formatName === "matroska,webm" ? "video/webm" : UNVERIFIED_CONTENT_TYPE };
  if (kinds.includes("audio")) return { modality: "AUDIO", mimeType: formatName === "ogg" ? "audio/ogg" : formatName === "mp3" ? "audio/mpeg" : formatName === "wav" ? "audio/wav" : UNVERIFIED_CONTENT_TYPE };
  throw new Error("SOURCE_CONTENT_UNSUPPORTED");
}

/**
 * The path/extension/MIME mapping in the provider listing is a discovery hint
 * only. This function classifies uploaded bytes; container formats are
 * inspected with the existing bounded ffprobe tool and ambiguous data fails
 * closed before an Asset row is written.
 */
export async function verifyRepositoryObjectModality(input: { jobId: string; bucket: string; objectKey: string; expectedSizeBytes: number }): Promise<VerifiedRepositoryModality> {
  return (await verifyRepositoryObject(input)).modality;
}

export async function verifyRepositoryObject(input: {
  jobId: string;
  bucket: string;
  objectKey: string;
  expectedSizeBytes: number;
}): Promise<VerifiedRepositoryObject> {
  const config = getWorkerConfig();
  const minio = createWorkerMinio(config);
  const prefix = await readPrefix(minio, input.bucket, input.objectKey);
  const headerClass = classifyDefinitiveHeaderDetailed(prefix);
  if (headerClass) return headerClass;

  return withJobTempWorkspace(input.jobId, async (workspace) => {
    const materialized = await materializePrivateSource({
      minio,
      bucket: input.bucket,
      objectKey: input.objectKey,
      destinationPath: `${workspace.path}/candidate`,
      expectedSizeBytes: BigInt(input.expectedSizeBytes),
      maxSourceBytes: BigInt(getRepositoryImportPolicy().REPOSITORY_IMPORT_MAX_FILE_BYTES),
    });
    if (materialized.kind !== "materialized") throw new Error("SOURCE_CONTENT_UNVERIFIED");
    const probe = await runBoundedMediaProcess({
      command: "ffprobe",
      args: ["-v", "error", "-show_entries", "stream=codec_type:format=format_name", "-of", "json", materialized.path],
      cwd: workspace.path,
      timeoutMs: defaultMediaProcessingPolicy.maxProcessMs,
      maxOutputBytes: defaultMediaProcessingPolicy.maxProcessOutputBytes,
    });
    if (probe.kind !== "completed") throw new Error("SOURCE_CONTENT_UNVERIFIED");
    return classifyProbeDetailed(probe.stdout.toString("utf8"));
  });
}
