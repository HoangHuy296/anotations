import {
  MEDIA_VERIFICATION_MAX_STREAMS, MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_PROBE_OUTPUT_CAP_BYTES, MEDIA_VERIFICATION_PROBE_TIMEOUT_MS, MEDIA_VERIFICATION_SOURCE_CAP_BYTES,
} from "@annotationplatform/domain/media-verification";

/**
 * `premedia-verify.v2` — PURE classification policy foundation (frozen contract section 6). It interprets one COMPLETED ffprobe document; it performs no I/O, runs no
 * process and is NOT yet wired into either ingestion path (the repository path keeps `classifyProbeOutput` until the D7 characterize-change-diff protocol is run).
 *
 * D7 CHARACTERIZATION ONLY — the legacy classifier's treatment of cover-art M4A, picture-bearing FLAC and AVIF as VIDEO is defect evidence (F6) and is deliberately NOT
 * reproduced here: picture streams are never video tracks, and still-image brands are negative evidence only.
 *
 * Gate precedence when several gates would fail: container, limits, still-image brand, then stream analysis (class), then bound-modality equality.
 */
export const POLICY_VERSION = MEDIA_VERIFICATION_POLICY_VERSION;
export const ALLOWED_CONTAINERS = ["mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"] as const;
export const ALLOWED_VIDEO_CODECS = ["h264", "vp8", "vp9", "av1"] as const; // HEVC and everything else is refused; a codec alone is never sufficient
export const STILL_IMAGE_BRANDS = ["heic", "heix", "mif1", "msf1", "avif", "avis"] as const;
const IMAGE_CODECS = new Set(["mjpeg", "png", "bmp", "gif", "webp", "tiff", "jpeg2000", "jpegls"]);
const DIMENSION = { min: 16, max: 8192 } as const;
const USABLE = { minFrames: 2, minDurationSeconds: 0.1 } as const;

/** Fixed, bounded invocation (section 6.1). No user-controlled argument; the caller passes only the private temp file. */
export function buildPremediaProbeArgs(filePath: string): string[] {
  return ["-v", "error", "-hide_banner", "-probesize", "10000000", "-analyzeduration", "5000000", "-show_entries",
    "format=format_name,duration,size,nb_streams:format_tags=major_brand,compatible_brands:stream=index,codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration:stream_disposition=default,attached_pic,still_image,timed_thumbnails",
    "-of", "json", filePath];
}
export const PROBE_LIMITS = Object.freeze({ timeoutMs: MEDIA_VERIFICATION_PROBE_TIMEOUT_MS, outputCapBytes: MEDIA_VERIFICATION_PROBE_OUTPUT_CAP_BYTES, sourceCapBytes: MEDIA_VERIFICATION_SOURCE_CAP_BYTES });

export type ProbeStream = { index?: number; codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; nb_frames?: string | number; duration?: string | number; disposition?: Record<string, number | undefined> };
export type ProbeDocument = { format?: { format_name?: string; duration?: string | number; size?: string | number; nb_streams?: number; tags?: { major_brand?: string; compatible_brands?: string } }; streams?: ProbeStream[] };

export type PersistedProbe = {
  formatName: string | null; durationMs: number | null; sizeBytes: number | null;
  streams: Array<{ index: number; type: string; codec: string | null; width: number | null; height: number | null; picture: boolean }>;
  negativeBrandHit: boolean; ffprobeVersion: string;
};
export type PolicyResultCode = "UNSUPPORTED_MEDIA" | "INVALID_MEDIA" | "ASSET_MODALITY_MISMATCH";
export type PolicyDecision =
  | { outcome: "CLASSIFIED"; class: "VIDEO" | "AUDIO"; probe: PersistedProbe; policyVersion: typeof POLICY_VERSION }
  | { outcome: "REJECTED"; code: PolicyResultCode; reason: "CONTAINER_UNSUPPORTED" | "CODEC_UNSUPPORTED" | "STILL_OR_COVER_ART" | "MEDIA_POLICY_REJECTED" | "CLASS_MISMATCH"; probe: PersistedProbe; policyVersion: typeof POLICY_VERSION };

const num = (value: unknown): number | null => { const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN; return Number.isFinite(n) ? n : null; };

export function isPictureStream(stream: ProbeStream): boolean {
  const d = stream.disposition ?? {};
  if (d.attached_pic === 1 || d.still_image === 1 || d.timed_thumbnails === 1) return true;
  const frames = num(stream.nb_frames);
  return stream.codec_type === "video" && IMAGE_CODECS.has(stream.codec_name ?? "") && frames !== null && frames <= 1;
}

export type PolicyInput = { document: ProbeDocument; sizeBytes: number; ffprobeVersion: string; boundModality: "VIDEO"; maxDurationSeconds?: number };

/** Class the bytes belong to, then equality with the bound Dataset modality. Never accepts on a container, extension, MIME or brand alone. */
export function classifyPremedia(input: PolicyInput): PolicyDecision {
  const { document, ffprobeVersion } = input;
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const brands = `${document.format?.tags?.major_brand ?? ""},${document.format?.tags?.compatible_brands ?? ""}`.toLowerCase();
  const negativeBrandHit = STILL_IMAGE_BRANDS.some(brand => brands.includes(brand));
  const probe: PersistedProbe = {
    formatName: document.format?.format_name ?? null,
    durationMs: num(document.format?.duration) === null ? null : Math.round(num(document.format?.duration)! * 1000),
    sizeBytes: input.sizeBytes,
    streams: streams.slice(0, MEDIA_VERIFICATION_MAX_STREAMS).map((stream, index) => ({ index: stream.index ?? index, type: stream.codec_type ?? "unknown", codec: stream.codec_name ?? null, width: num(stream.width), height: num(stream.height), picture: isPictureStream(stream) })),
    negativeBrandHit, ffprobeVersion,
  };
  const reject = (code: PolicyResultCode, reason: Extract<PolicyDecision, { outcome: "REJECTED" }>["reason"]): PolicyDecision => ({ outcome: "REJECTED", code, reason, probe, policyVersion: POLICY_VERSION });

  // 1. container
  if (!(ALLOWED_CONTAINERS as readonly string[]).includes(document.format?.format_name ?? "")) return reject("UNSUPPORTED_MEDIA", "CONTAINER_UNSUPPORTED");
  // 8. limits (size, stream count, duration policy)
  if (input.sizeBytes > MEDIA_VERIFICATION_SOURCE_CAP_BYTES || streams.length > MEDIA_VERIFICATION_MAX_STREAMS) return reject("INVALID_MEDIA", "MEDIA_POLICY_REJECTED");
  const seconds = num(document.format?.duration);
  if (input.maxDurationSeconds !== undefined && seconds !== null && seconds > input.maxDurationSeconds) return reject("INVALID_MEDIA", "MEDIA_POLICY_REJECTED");
  // 5. still-image brands are NEGATIVE evidence only
  if (negativeBrandHit) return reject("UNSUPPORTED_MEDIA", "STILL_OR_COVER_ART");

  // 2-3. picture streams are never video tracks
  const videoTracks = streams.filter(stream => stream.codec_type === "video" && !isPictureStream(stream));
  const audio = streams.filter(stream => stream.codec_type === "audio");
  const pictures = streams.filter(stream => stream.codec_type === "video" && isPictureStream(stream));
  if (videoTracks.length >= 1) {
    const usable = videoTracks.filter(stream => {
      const w = num(stream.width), h = num(stream.height), frames = num(stream.nb_frames), duration = num(stream.duration) ?? seconds;
      return w !== null && h !== null && w >= DIMENSION.min && w <= DIMENSION.max && h >= DIMENSION.min && h <= DIMENSION.max && ((frames !== null && frames >= USABLE.minFrames) || (duration !== null && duration >= USABLE.minDurationSeconds));
    });
    if (usable.length === 0) return reject("INVALID_MEDIA", "MEDIA_POLICY_REJECTED");
    // 4. every counted video track must carry an allowed codec
    if (videoTracks.some(stream => !(ALLOWED_VIDEO_CODECS as readonly string[]).includes(stream.codec_name ?? ""))) return reject("UNSUPPORTED_MEDIA", "CODEC_UNSUPPORTED");
    return { outcome: "CLASSIFIED", class: "VIDEO", probe, policyVersion: POLICY_VERSION };
  }
  // 6(b). audio without a usable video track is AUDIO (picture streams ignored); 7: AUDIO never publishes into the VIDEO bound modality
  if (audio.length >= 1) return reject("ASSET_MODALITY_MISMATCH", "CLASS_MISMATCH");
  // 6(c) only pictures; 6(d) nothing usable
  if (pictures.length >= 1) return reject("UNSUPPORTED_MEDIA", "STILL_OR_COVER_ART");
  return reject("UNSUPPORTED_MEDIA", "CONTAINER_UNSUPPORTED");
}

/** Class of an AUDIO/VIDEO document ignoring the bound modality (used to show the class the bytes belong to, e.g. for the D7 characterization diff). */
export function classOfPremedia(document: ProbeDocument): "VIDEO" | "AUDIO" | "STILL" | "NONE" {
  const streams = Array.isArray(document.streams) ? document.streams : [];
  if (streams.some(stream => stream.codec_type === "video" && !isPictureStream(stream))) return "VIDEO";
  if (streams.some(stream => stream.codec_type === "audio")) return "AUDIO";
  if (streams.some(stream => stream.codec_type === "video")) return "STILL";
  return "NONE";
}

// ---- Probe completion (section 6.2 step 9, R5): only a COMPLETED probe may classify; everything else is operational and is never a REJECTED verdict.
/**
 * Frozen, version-keyed demuxer-invalid markers (G-PROBE, contract section 6.2 step 9). A version absent from this table has NO markers: every non-zero exit is operational.
 *
 * `5.1.9-0+deb12u1` (the pinned worker image): exit status 1 with the final line `<path>: Invalid data found when processing input`, which the demuxer emits when the container
 * header of a fully readable file cannot be parsed (forged/random/empty/text content, mp4 without moov, Matroska without a valid EBML header). Characterization on the pinned image
 * (scripts/db-safety/a2-probe-markers.mjs -> tests/media/fixtures/probe-characterization.json) shows this exact pair does NOT occur for a read I/O error, permission denied, missing
 * file, directory, dangling link, memory exhaustion, SIGKILL or a timeout, and that a Matroska file truncated by content ends in `Input/output error` / `End of file` (kept operational,
 * never a marker). The marker also matches a file truncated by INFRASTRUCTURE: that overlap is excluded by construction because the verifier only invokes ffprobe on a temp file
 * whose byte count equals the recorded sealed size and whose sealed identity was re-checked around the read (a short read is an operational storage failure and never reaches ffprobe).
 */
export const FFPROBE_INVALID_MARKERS: Readonly<Record<string, readonly { exitCode: number; stderr: RegExp }[]>> = Object.freeze({
  "5.1.9-0+deb12u1": Object.freeze([Object.freeze({ exitCode: 1, stderr: /: Invalid data found when processing input\s*$/m })]),
});

/** `ffprobe version 5.1.9-0+deb12u1 Copyright ...` -> `5.1.9-0+deb12u1`; anything else -> `unknown` (which has no markers). */
export function parseFfprobeVersion(banner: string): string {
  return /^ffprobe version (\S+)/.exec(banner.trim())?.[1] ?? "unknown";
}

export type ProbeCompletionInput = { ffprobeVersion: string; spawnError: boolean; timedOut: boolean; signal: string | null; exitCode: number | null; stdoutTruncated: boolean; stdout: string; stderr: string };
export type ProbeCompletion =
  | { kind: "COMPLETED"; document: ProbeDocument }
  | { kind: "COMPLETED_INVALID"; marker: string }
  | { kind: "NOT_COMPLETED"; reason: "UPLOAD_VERIFICATION_PROBE_TIMEOUT" | "UPLOAD_VERIFICATION_PROBE_FAILED" };

export function interpretProbeCompletion(input: ProbeCompletionInput): ProbeCompletion {
  if (input.timedOut) return { kind: "NOT_COMPLETED", reason: "UPLOAD_VERIFICATION_PROBE_TIMEOUT" };
  if (input.spawnError || input.signal !== null || input.exitCode === null || input.stdoutTruncated) return { kind: "NOT_COMPLETED", reason: "UPLOAD_VERIFICATION_PROBE_FAILED" };
  if (input.exitCode === 0) {
    try {
      const parsed: unknown = JSON.parse(input.stdout);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { kind: "COMPLETED", document: parsed as ProbeDocument };
    } catch { /* unparseable output of a zero exit is operational */ }
    return { kind: "NOT_COMPLETED", reason: "UPLOAD_VERIFICATION_PROBE_FAILED" };
  }
  const markers = FFPROBE_INVALID_MARKERS[input.ffprobeVersion] ?? [];
  const hit = markers.find(marker => marker.exitCode === input.exitCode && marker.stderr.test(input.stderr));
  return hit ? { kind: "COMPLETED_INVALID", marker: hit.stderr.source } : { kind: "NOT_COMPLETED", reason: "UPLOAD_VERIFICATION_PROBE_FAILED" };
}
