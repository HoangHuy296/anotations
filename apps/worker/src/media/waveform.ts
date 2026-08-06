import { gzipSync } from "node:zlib";

import { defaultMediaProcessingPolicy } from "./policy.js";

export const AUDIO_WAVEFORM_FORMAT = "fieldframe.audio-waveform.v1" as const;

export type AudioWaveform = {
  format: typeof AUDIO_WAVEFORM_FORMAT;
  sampleRate: number;
  channels: 1;
  peaks: number[];
};

export type AudioMetadata = {
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  codec: string | null;
  bitRate: number | null;
};

/** Parse only bounded, non-secret ffprobe fields needed by AudioAsset. */
export function parseFfprobeAudioMetadata(raw: Buffer, maxDurationMs = defaultMediaProcessingPolicy.maxDurationMs): AudioMetadata | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as { format?: Record<string, unknown>; streams?: unknown };
  const stream = Array.isArray(root.streams)
    ? root.streams.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).codec_type === "audio")
    : null;
  if (!stream) return null;
  const durationValue = root.format?.duration;
  const seconds = typeof durationValue === "string" || typeof durationValue === "number" ? Number(durationValue) : NaN;
  const durationMs = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  if (durationMs !== null && durationMs > maxDurationMs) return null;
  const numberField = (value: unknown, max: number) => {
    const parsedNumber = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
    return Number.isInteger(parsedNumber) && parsedNumber > 0 && parsedNumber <= max ? parsedNumber : null;
  };
  const codec = typeof stream.codec_name === "string" && /^[a-z0-9._-]{1,120}$/i.test(stream.codec_name) ? stream.codec_name : null;
  return {
    durationMs,
    sampleRate: numberField(stream.sample_rate, 384_000),
    channels: numberField(stream.channels, 64),
    codec,
    bitRate: numberField(stream.bit_rate ?? root.format?.bit_rate, 1_000_000_000),
  };
}

/**
 * Converts bounded mono signed-16 PCM into normalized peak buckets. The
 * worker decodes media with ffmpeg; this pure helper deliberately accepts
 * only PCM and never persists raw samples or tool output.
 */
export function buildAudioWaveform(input: {
  pcm: Buffer;
  sampleRate: number;
  bucketCount?: number;
  maxPeaks?: number;
}): AudioWaveform | null {
  if (!Number.isInteger(input.sampleRate) || input.sampleRate < 1 || input.sampleRate > 384_000) return null;
  if (input.pcm.length === 0 || input.pcm.length % 2 !== 0) return null;
  const maxPeaks = input.maxPeaks ?? defaultMediaProcessingPolicy.maxWaveformPeaks;
  const bucketCount = Math.max(1, Math.min(maxPeaks, input.bucketCount ?? Math.ceil(input.pcm.length / 2)));
  const samples = input.pcm.length / 2;
  const peaks = new Array<number>(Math.min(bucketCount, samples)).fill(0);
  for (let index = 0; index < samples; index += 1) {
    const bucket = Math.min(peaks.length - 1, Math.floor(index * peaks.length / samples));
    const amplitude = Math.abs(input.pcm.readInt16LE(index * 2)) / 32_768;
    if (amplitude > peaks[bucket]) peaks[bucket] = Number(amplitude.toFixed(6));
  }
  return { format: AUDIO_WAVEFORM_FORMAT, sampleRate: input.sampleRate, channels: 1, peaks };
}

/** Stable, bounded derivative bytes for private MinIO storage. */
export function serializeAudioWaveform(waveform: AudioWaveform): Buffer {
  return gzipSync(JSON.stringify(waveform), { level: 6 });
}

/** Deterministic safe artifact used by the first audio processor slice. */
export function buildWaveformArtifact(metadata: AudioMetadata): Buffer {
  const waveform: AudioWaveform = {
    format: AUDIO_WAVEFORM_FORMAT,
    sampleRate: metadata.sampleRate ?? 0,
    channels: 1,
    peaks: [],
  };
  return serializeAudioWaveform(waveform);
}

export function buildWaveformArtifactFromPcm(input: { pcm: Buffer; sampleRate: number; maxPeaks?: number }): Buffer | null {
  const waveform = buildAudioWaveform(input);
  return waveform ? serializeAudioWaveform(waveform) : null;
}
