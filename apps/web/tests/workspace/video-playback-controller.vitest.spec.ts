import { beforeEach, describe, expect, it, vi } from "vitest";

import { createVideoPlaybackController } from "@/lib/workspace/video-playback-controller";
import { useVideoAnnotationStore } from "@/stores/video-annotation-store";

/**
 * This project has no DOM-rendering test harness (no jsdom/
 * @testing-library/react -- AGENTS.md requires explicit permission before
 * adding one), matching every sibling `*.vitest.spec.ts` in this directory.
 * `createVideoPlaybackController` takes a plain getter function rather than
 * a real `<video>` element, so it can be exercised here against a minimal
 * fake that implements only the members the controller touches.
 */
function fakeVideo(overrides: Partial<{ currentTime: number; duration: number; paused: boolean }> = {}) {
  return {
    currentTime: overrides.currentTime ?? 0,
    duration: overrides.duration ?? 100,
    paused: overrides.paused ?? true,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(function (this: { paused: boolean }) { this.paused = true; }),
  };
}

describe("video-playback-controller", () => {
  beforeEach(() => {
    useVideoAnnotationStore.setState({ currentTimeMs: 0, currentFrame: 0, playbackState: "paused", fps: null, durationMs: null });
  });

  it("play()/pause() are the only calls that touch the video element's own play/pause", () => {
    const video = fakeVideo();
    const controller = createVideoPlaybackController(() => video as unknown as HTMLVideoElement);
    controller.play();
    expect(video.play).toHaveBeenCalledTimes(1);
    controller.pause();
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it("seekToTime sets currentTime and mirrors currentTimeMs/currentFrame into the store (single source of truth)", () => {
    useVideoAnnotationStore.setState({ fps: 25 });
    const video = fakeVideo();
    const controller = createVideoPlaybackController(() => video as unknown as HTMLVideoElement);
    controller.seekToTime(2000);
    expect(video.currentTime).toBe(2);
    expect(useVideoAnnotationStore.getState().currentTimeMs).toBe(2000);
    expect(useVideoAnnotationStore.getState().currentFrame).toBe(50); // 2s * 25fps
  });

  it("seekToTime never seeks before 0", () => {
    const video = fakeVideo();
    const controller = createVideoPlaybackController(() => video as unknown as HTMLVideoElement);
    controller.seekToTime(-500);
    expect(video.currentTime).toBe(0);
  });

  it("seekToFrame converts a frame number to the equivalent time using the store's fps", () => {
    useVideoAnnotationStore.setState({ fps: 10 });
    const video = fakeVideo();
    const controller = createVideoPlaybackController(() => video as unknown as HTMLVideoElement);
    controller.seekToFrame(30);
    expect(video.currentTime).toBe(3); // frame 30 at 10fps = 3s
  });

  it("nextFrame/previousFrame step by exactly 1/fps seconds -- not an arbitrary fixed millisecond increment (spec FR-048)", () => {
    useVideoAnnotationStore.setState({ fps: 25 });
    const video = fakeVideo({ currentTime: 1, paused: true });
    const controller = createVideoPlaybackController(() => video as unknown as HTMLVideoElement);
    controller.nextFrame();
    expect(video.currentTime).toBeCloseTo(1 + 1 / 25, 6);
    controller.previousFrame();
    expect(video.currentTime).toBeCloseTo(1, 6);
  });

  it("falls back to a default step when fps is missing/unreliable, rather than throwing or stalling", () => {
    useVideoAnnotationStore.setState({ fps: null });
    const video = fakeVideo({ currentTime: 1 });
    const controller = createVideoPlaybackController(() => video as unknown as HTMLVideoElement);
    controller.nextFrame();
    expect(video.currentTime).toBeGreaterThan(1);
    expect(video.currentTime).toBeCloseTo(1 + 1 / 30, 6);
  });

  it("nextFrame/previousFrame pause the video first if it is playing (spec FR-049 applies to frame-stepping too)", () => {
    const video = fakeVideo({ paused: false });
    const controller = createVideoPlaybackController(() => video as unknown as HTMLVideoElement);
    controller.nextFrame();
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it("nextFrame clamps to duration; previousFrame clamps to 0", () => {
    useVideoAnnotationStore.setState({ fps: 25 });
    const nearEnd = fakeVideo({ currentTime: 99.99, duration: 100 });
    createVideoPlaybackController(() => nearEnd as unknown as HTMLVideoElement).nextFrame();
    expect(nearEnd.currentTime).toBeLessThanOrEqual(100);

    const nearStart = fakeVideo({ currentTime: 0.001 });
    createVideoPlaybackController(() => nearStart as unknown as HTMLVideoElement).previousFrame();
    expect(nearStart.currentTime).toBe(0);
  });

  it("is a no-op (never throws) when the video element is not yet available", () => {
    const controller = createVideoPlaybackController(() => null);
    expect(() => { controller.play(); controller.pause(); controller.seekToTime(1000); controller.seekToFrame(5); controller.nextFrame(); controller.previousFrame(); }).not.toThrow();
  });
});
