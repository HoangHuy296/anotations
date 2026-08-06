import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateVideoTrack, updateVideoTemporalLabel } = vi.hoisted(() => ({ updateVideoTrack: vi.fn(), updateVideoTemporalLabel: vi.fn() }));

vi.mock("@/lib/workspace/video-annotation-client", () => ({ updateVideoTrack, updateVideoTemporalLabel }));

import { TemporalLabelAutosaveCoordinator, TrackAutosaveCoordinator } from "@/lib/workspace/video-autosave";

describe("video autosave coordinators", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });

  it("debounces a Track authority, preserves a later dirty edit, and advances its revision", async () => {
    let releaseFirst: ((value: { track: { id: string; revision: number } }) => void) | undefined;
    updateVideoTrack.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));
    updateVideoTrack.mockResolvedValueOnce({ track: { id: "track-a", revision: 3 } });
    const states: string[] = [];
    const coordinator = new TrackAutosaveCoordinator("track-a", 1, (state) => states.push(state), undefined, 1500);

    coordinator.scheduleTrackUpdate({ name: "first" });
    coordinator.scheduleTrackUpdate({ name: "latest" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(updateVideoTrack).toHaveBeenCalledTimes(1);
    expect(updateVideoTrack).toHaveBeenLastCalledWith("track-a", { expectedTrackRevision: 1, name: "latest" });

    coordinator.scheduleTrackUpdate({ interpolationMode: "NONE" });
    releaseFirst?.({ track: { id: "track-a", revision: 2 } });
    await vi.runAllTimersAsync();
    expect(updateVideoTrack).toHaveBeenCalledTimes(2);
    expect(updateVideoTrack).toHaveBeenLastCalledWith("track-a", { expectedTrackRevision: 2, interpolationMode: "NONE" });
    expect(coordinator.getRevision()).toBe(3);
    expect(states).toContain("dirty");
    expect(states.at(-1)).toBe("saved");
  });

  it("uses an independent temporal Annotation revision and never retries a conflict", async () => {
    updateVideoTemporalLabel.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "ANNOTATION_REVISION_CONFLICT" }));
    const coordinator = new TemporalLabelAutosaveCoordinator("annotation-a", 4, undefined, undefined, 1500);
    coordinator.schedule({ startMs: 100, endMs: 200, labelId: null });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.runAllTimersAsync();
    expect(updateVideoTemporalLabel).toHaveBeenCalledTimes(1);
    expect(updateVideoTemporalLabel).toHaveBeenCalledWith("annotation-a", { expectedRevision: 4, startMs: 100, endMs: 200, labelId: null });
    expect(coordinator.getState()).toBe("conflict");
  });
});
