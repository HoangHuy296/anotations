import { TextDecoder } from "node:util";

import { defaultMediaProcessingPolicy } from "../media/policy.js";
import { runBoundedMediaProcess } from "../media/subprocess.js";
import { materializePrivateSource } from "../media/source-materialization.js";
import { withJobTempWorkspace } from "../media/temp-workspace.js";
import { createWorkerMinio } from "../providers/minio.js";
import { getWorkerConfig, getRepositoryImportPolicy } from "../config.js";

export type VerifiedRepositoryModality = "IMAGE" | "VIDEO" | "AUDIO" | "TEXT";

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

function classifyDefinitiveHeader(bytes: Buffer): VerifiedRepositoryModality | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? "IMAGE" : null;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "IMAGE";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "IMAGE";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "AUDIO";
  if (bytes.subarray(0, 3).equals(Buffer.from("ID3")) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "AUDIO";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return "TEXT";
  } catch { /* Binary/ambiguous prefix; ffprobe or rejection below. */ }
  return null;
}

/**
 * The path/extension/MIME mapping in the provider listing is a discovery hint
 * only. This function classifies uploaded bytes; container formats are
 * inspected with the existing bounded ffprobe tool and ambiguous data fails
 * closed before an Asset row is written.
 */
export async function verifyRepositoryObjectModality(input: {
  jobId: string;
  bucket: string;
  objectKey: string;
  expectedSizeBytes: number;
}): Promise<VerifiedRepositoryModality> {
  const config = getWorkerConfig();
  const minio = createWorkerMinio(config);
  const prefix = await readPrefix(minio, input.bucket, input.objectKey);
  const headerClass = classifyDefinitiveHeader(prefix);
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
      args: ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", materialized.path],
      cwd: workspace.path,
      timeoutMs: defaultMediaProcessingPolicy.maxProcessMs,
      maxOutputBytes: defaultMediaProcessingPolicy.maxProcessOutputBytes,
    });
    if (probe.kind !== "completed") throw new Error("SOURCE_CONTENT_UNVERIFIED");
    let parsed: unknown;
    try { parsed = JSON.parse(probe.stdout.toString("utf8")); } catch { throw new Error("SOURCE_CONTENT_UNVERIFIED"); }
    const streams = parsed && typeof parsed === "object" && Array.isArray((parsed as { streams?: unknown }).streams)
      ? (parsed as { streams: unknown[] }).streams : [];
    const kinds = streams.flatMap((stream) => stream && typeof stream === "object" && typeof (stream as { codec_type?: unknown }).codec_type === "string"
      ? [(stream as { codec_type: string }).codec_type] : []);
    if (kinds.includes("video")) return "VIDEO";
    if (kinds.includes("audio")) return "AUDIO";
    throw new Error("SOURCE_CONTENT_UNSUPPORTED");
  });
}
