import { createHash } from "node:crypto";
import { decodeUtf8SourceBytes, TextSourceDecodeError } from "@annotationplatform/domain/text-source-decode";
import { readTextSourceLimits, type TextSourceLimits } from "@annotationplatform/domain/text-source-limits";

/**
 * Full-bounded verification of a source object's raw bytes: computes the
 * raw-byte SHA-256 identity, decodes with the shared fatal UTF-8 rules (T007)
 * and enforces the shared size policy (T008). This is the single place the
 * worker turns "bytes we fetched from MinIO" into "a verified TEXT source" —
 * no numeric literal here duplicates a limit already defined in the domain
 * package.
 */

/**
 * Reads a stream into memory, stopping as soon as it is provably over
 * `maxBytes` instead of buffering an attacker-controlled amount. Unlike a
 * bounded-prefix inspection read, this never returns a truncated buffer as if
 * it were complete — a stream that is too long is reported as oversized, not
 * silently cut.
 */
export async function readBoundedStreamToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<{ kind: "complete"; bytes: Buffer } | { kind: "oversized" }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      const destroyable = stream as Partial<{ destroy: (error?: Error) => void }>;
      destroyable.destroy?.();
      return { kind: "oversized" };
    }
    chunks.push(bytes);
  }
  return { kind: "complete", bytes: Buffer.concat(chunks) };
}

export type VerifyTextSourceBytesResult =
  | {
      kind: "verified";
      sourceIdentity: string;
      text: string;
      byteLength: number;
      codeUnitLength: number;
    }
  | { kind: "oversized_bytes" }
  | { kind: "oversized_code_units" }
  | { kind: "invalid_encoding" };

export function verifyTextSourceBytes(
  bytes: Uint8Array,
  limits: TextSourceLimits = readTextSourceLimits(process.env),
): VerifyTextSourceBytesResult {
  if (bytes.byteLength > limits.maxSourceBytes) return { kind: "oversized_bytes" };

  let decoded: ReturnType<typeof decodeUtf8SourceBytes>;
  try {
    decoded = decodeUtf8SourceBytes(bytes);
  } catch (error) {
    if (error instanceof TextSourceDecodeError) return { kind: "invalid_encoding" };
    throw error;
  }

  if (decoded.codeUnitLength > limits.maxCodeUnits) return { kind: "oversized_code_units" };

  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    kind: "verified",
    sourceIdentity: `sha256:${digest}`,
    text: decoded.text,
    byteLength: decoded.byteLength,
    codeUnitLength: decoded.codeUnitLength,
  };
}
