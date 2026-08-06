"use client";

import type { SafeVideoTemporalLabel, SafeVideoTrack } from "@/types/video-annotation";
import { updateVideoTemporalLabel, updateVideoTrack } from "@/lib/workspace/video-annotation-client";

export type VideoSaveState = "clean" | "dirty" | "saving" | "saved" | "error" | "conflict";
type StateListener = (state: VideoSaveState) => void;
type FlushableCoordinator = { flush: () => Promise<unknown>; getState: () => VideoSaveState };
const activeVideoCoordinators = new Set<FlushableCoordinator>();

/** Used by workspace navigation to flush both Track and temporal authorities. */
export async function flushVideoAutosaves() { await Promise.all([...activeVideoCoordinators].map((coordinator) => coordinator.flush().catch(() => undefined))); }
export function hasVideoAutosaveConflict() { return [...activeVideoCoordinators].some((coordinator) => coordinator.getState() === "conflict" || coordinator.getState() === "error"); }

/**
 * One serial coordinator per VideoObjectTrack. All Track metadata and every
 * keyframe operation must pass through this authority; it never creates a
 * separate keyframe revision stream. Operations receive the latest confirmed
 * revision, so an edit queued during an in-flight request cannot reuse a stale
 * revision after that request succeeds.
 */
export class TrackAutosaveCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<unknown> | null = null;
  private pending: ((revision: number) => Promise<SafeVideoTrack>) | null = null;
  private revision: number;
  private state: VideoSaveState = "clean";
  constructor(private readonly trackId: string, revision: number, private readonly onState?: StateListener, private readonly onSaved?: (track: SafeVideoTrack) => void, private readonly delayMs = 1500) {
    this.revision = revision;
    activeVideoCoordinators.add(this);
  }
  private setState(next: VideoSaveState) { this.state = next; this.onState?.(next); }
  getState() { return this.state; }
  getRevision() { return this.revision; }
  setRevision(revision: number) { this.revision = Math.max(this.revision, revision); }
  schedule(operation: (revision: number) => Promise<SafeVideoTrack>) {
    this.pending = operation;
    this.setState("dirty");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, this.delayMs);
  }
  scheduleTrackUpdate(changes: Omit<Parameters<typeof updateVideoTrack>[1], "expectedTrackRevision">) {
    this.schedule((revision) => updateVideoTrack(this.trackId, { ...changes, expectedTrackRevision: revision }).then((result) => result.track));
  }
  async flush() {
    if (this.inFlight) return this.inFlight;
    if (!this.pending) return null;
    const operation = this.pending;
    this.pending = null;
    this.setState("saving");
    this.inFlight = operation(this.revision).then((track) => {
      this.revision = track.revision;
      this.onSaved?.(track);
      this.setState(this.pending ? "dirty" : "saved");
      return track;
    }).catch((error) => {
      this.setState((error as { code?: string }).code === "VIDEO_TRACK_REVISION_CONFLICT" ? "conflict" : "error");
      throw error;
    }).finally(() => {
      this.inFlight = null;
      if (this.pending) void this.flush().catch(() => undefined);
    });
    return this.inFlight;
  }
  async dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null; await this.flush(); activeVideoCoordinators.delete(this); }
}

/** A standalone temporal Annotation has its own Annotation.revision authority. */
export class TemporalLabelAutosaveCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<unknown> | null = null;
  private pending: ((revision: number) => Promise<SafeVideoTemporalLabel>) | null = null;
  private revision: number;
  private state: VideoSaveState = "clean";
  constructor(private readonly id: string, revision: number, private readonly onState?: StateListener, private readonly onSaved?: (label: SafeVideoTemporalLabel) => void, private readonly delayMs = 1500) { this.revision = revision; activeVideoCoordinators.add(this); }
  private setState(next: VideoSaveState) { this.state = next; this.onState?.(next); }
  getState() { return this.state; }
  getRevision() { return this.revision; }
  setRevision(revision: number) { this.revision = Math.max(this.revision, revision); }
  schedule(changes: Omit<Parameters<typeof updateVideoTemporalLabel>[1], "expectedRevision">) {
    this.pending = (revision) => updateVideoTemporalLabel(this.id, { ...changes, expectedRevision: revision }).then((result) => result.temporalLabel);
    this.setState("dirty");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, this.delayMs);
  }
  async flush() {
    if (this.inFlight) return this.inFlight;
    if (!this.pending) return null;
    const operation = this.pending;
    this.pending = null;
    this.setState("saving");
    this.inFlight = operation(this.revision).then((label) => {
      this.revision = label.revision;
      this.onSaved?.(label);
      this.setState(this.pending ? "dirty" : "saved");
      return label;
    }).catch((error) => {
      this.setState((error as { code?: string }).code === "ANNOTATION_REVISION_CONFLICT" ? "conflict" : "error");
      throw error;
    }).finally(() => {
      this.inFlight = null;
      if (this.pending) void this.flush().catch(() => undefined);
    });
    return this.inFlight;
  }
  async dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null; await this.flush(); activeVideoCoordinators.delete(this); }
}
