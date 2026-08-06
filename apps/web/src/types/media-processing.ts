import type { SafeJobStage } from "@/lib/jobs/safe-job-stage";

export type SafeMediaReadiness = {
  assetId: string;
  modality: "VIDEO" | "AUDIO";
  state: "NOT_REQUESTED" | "QUEUED" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED" | "CANCELING" | "CANCELED";
  stage: SafeJobStage | null;
  progress: number | null;
  counters: { total: number | null; processed: number | null; succeeded: number | null; failed: number | null; skipped: number | null };
  outcome: { code: string | null; message: string | null } | null;
  video?: { durationMs: number | null; fps: number | null; totalFrames: number | null; codec: string | null };
  audio?: { durationMs: number | null; sampleRate: number | null; channels: number | null; codec: string | null; bitRate: number | null; waveformReady: boolean };
};
