"use client";

import { useVideoAnnotationStore } from "@/stores/video-annotation-store";

export type VideoPlaybackController = {
  play: () => void;
  pause: () => void;
  seekToTime: (ms: number) => void;
  seekToFrame: (frame: number) => void;
  nextFrame: () => void;
  previousFrame: () => void;
};

/** Used only when `fps` is missing/unreliable -- the existing fallback this interaction layer used before fps-derived stepping existed (spec FR-016's fallback rule). */
const FALLBACK_FPS = 30;

/**
 * The single authority for VIDEO playback (spec FR-047, US9). Bound to
 * `video-engine.tsx`'s `videoRef` via a getter (`() => getVideo()`),
 * not the ref object itself -- accessing `.current` only inside these
 * methods (never while `getVideo` is constructed) is what keeps this ref
 * access outside of render, per React's rules of refs. This is the only
 * code that reads or writes the video element's `play()/pause()/currentTime`.
 * Every call mirrors its result into `useVideoAnnotationStore`'s playback
 * slice (`currentTimeMs`/`currentFrame`/`fps`/`durationMs`), so
 * `video-toolbar.tsx`/any future consumer read from the store instead of
 * touching the video element themselves. `playbackState`
 * itself is mirrored separately, from the `<video>` element's own
 * `play`/`pause` events in `video-engine.tsx` -- the single source for
 * whether playback is actually active, rather than assumed from which
 * method was last called.
 */
export function createVideoPlaybackController(getVideo: () => HTMLVideoElement | null): VideoPlaybackController {
  const currentFps = () => {
    const fps = useVideoAnnotationStore.getState().fps;
    return fps && fps > 0 ? fps : FALLBACK_FPS;
  };
  const syncTime = () => {
    const video = getVideo();
    if (!video) return;
    const currentTimeMs = video.currentTime * 1000;
    useVideoAnnotationStore.getState().setPlaybackSnapshot({
      currentTimeMs,
      currentFrame: Math.round(currentTimeMs / (1000 / currentFps())),
    });
  };
  return {
    play: () => { getVideo()?.play().catch(() => undefined); },
    pause: () => { getVideo()?.pause(); },
    seekToTime: (ms) => {
      const video = getVideo();
      if (!video) return;
      video.currentTime = Math.max(0, ms / 1000);
      syncTime();
    },
    seekToFrame: (frame) => {
      const stepMs = 1000 / currentFps();
      const video = getVideo();
      if (!video) return;
      video.currentTime = Math.max(0, (frame * stepMs) / 1000);
      syncTime();
    },
    // Deterministic one-frame stepping (spec FR-048): pause if playing, step
    // by exactly `1 / fps` seconds -- never an arbitrary fixed millisecond
    // increment -- then sync the store so the timeline playhead and derived
    // interpolation/visible-annotation recomputation (already driven by
    // `video-engine.tsx`'s existing `currentTime`-keyed calculations) follow.
    nextFrame: () => {
      const video = getVideo();
      if (!video) return;
      if (!video.paused) video.pause();
      const stepMs = 1000 / currentFps();
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + stepMs / 1000);
      syncTime();
    },
    previousFrame: () => {
      const video = getVideo();
      if (!video) return;
      if (!video.paused) video.pause();
      const stepMs = 1000 / currentFps();
      video.currentTime = Math.max(0, video.currentTime - stepMs / 1000);
      syncTime();
    },
  };
}
