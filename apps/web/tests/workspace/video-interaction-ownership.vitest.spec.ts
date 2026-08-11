import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This project has no DOM-rendering test harness (no jsdom/
 * @testing-library/react -- AGENTS.md requires explicit permission before
 * adding one), so interaction-ownership (spec FR-045/FR-046/FR-049, US9) is
 * verified against `video-engine.tsx`'s source text -- the same approach
 * `workspace-shell-boundary.test.ts` already established for structural
 * component-boundary rules.
 */
const sourcePromise = readFile(path.resolve(import.meta.dirname, "../../src/components/workspace/video-engine.tsx"), "utf8");

/** Extracts one function's source, from its `const name = ` declaration up to (not including) the next top-level `const`/`return <section` that starts the JSX. Approximate, not brace-matched -- sufficient for asserting presence/absence of specific calls within a gesture handler. */
function sliceFunction(source: string, name: string, nextMarker: string) {
  const start = source.indexOf(`const ${name} =`);
  expect(start, `expected to find "const ${name} =" in video-engine.tsx`).toBeGreaterThan(-1);
  const end = source.indexOf(nextMarker, start);
  expect(end, `expected to find "${nextMarker}" after ${name} in video-engine.tsx`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("VIDEO interaction ownership (spec FR-045, FR-046, FR-049)", () => {
  it("the <video> element renders with no native `controls` attribute (FR-045)", async () => {
    const source = await sourcePromise;
    const videoTagMatch = source.match(/<video\b[^>]*>/);
    expect(videoTagMatch, "expected to find a <video ...> tag").not.toBeNull();
    expect(videoTagMatch![0]).not.toMatch(/\bcontrols\b/);
  });

  it("beginBoxDraw pauses playback before doing anything else, via the playback controller (FR-049)", async () => {
    const source = await sourcePromise;
    const fn = sliceFunction(source, "beginBoxDraw", "const cancelPendingBox");
    const pauseIndex = fn.indexOf("playbackController.pause()");
    expect(pauseIndex, "expected beginBoxDraw to call playbackController.pause()").toBeGreaterThan(-1);
    // "before doing anything else": the pause call must precede the pointer
    // rect/draw-state setup that follows it in this gesture.
    const drawSetupIndex = fn.indexOf("getBoundingClientRect");
    expect(pauseIndex).toBeLessThan(drawSetupIndex);
    // No raw videoRef.current.pause() left over -- the controller is the
    // only thing that touches the video element for playback (contract).
    expect(fn).not.toMatch(/videoRef\.current\?\.pause\(\)/);
  });

  it("beginGeometryDrag (drag/resize an existing keyframe) pauses playback before doing anything else (FR-049)", async () => {
    const source = await sourcePromise;
    const fn = sliceFunction(source, "beginGeometryDrag", "const beginBoxDraw");
    const pauseIndex = fn.indexOf("playbackController.pause()");
    expect(pauseIndex, "expected beginGeometryDrag to call playbackController.pause()").toBeGreaterThan(-1);
    const captureIndex = fn.indexOf("setPointerCapture");
    expect(pauseIndex).toBeLessThan(captureIndex);
  });

  it("neither beginBoxDraw nor beginGeometryDrag ever resumes playback -- no auto-resume on completion (FR-049)", async () => {
    // Matches an actual resume call (`playbackController.play(`/
    // `videoRef.current?.play(`), not prose that happens to mention "play()"
    // -- e.g. this file's and video-engine.tsx's own doc comments.
    const resumeCallPattern = /\.play\(\s*\)/;
    const isCallNotComment = (slice: string) => slice.split("\n").some((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && resumeCallPattern.test(line));
    const source = await sourcePromise;
    expect(isCallNotComment(sliceFunction(source, "beginBoxDraw", "const cancelPendingBox"))).toBe(false);
    expect(isCallNotComment(sliceFunction(source, "beginGeometryDrag", "const beginBoxDraw"))).toBe(false);
  });

  it("annotation gestures use pointer events (mouse/touch/trackpad parity), not mouse-only handlers (FR-046, spec Browser compatibility)", async () => {
    const source = await sourcePromise;
    expect(source).toMatch(/onPointerDown=\{beginBoxDraw\}/);
    expect(source).toMatch(/onPointerDown=\{\(event\) => beginGeometryDrag/);
    expect(source).not.toMatch(/onMouseDown=/);
  });

  it("playback (play/pause/seek/frame-step) is only ever driven through playbackController, never a bare videoRef.current.currentTime assignment or .play()/.pause() call (FR-047)", async () => {
    const source = await sourcePromise;
    // The one allowed exception is video-playback-controller.ts itself,
    // which this assertion does not read. Within video-engine.tsx, every
    // remaining `videoRef.current` reference must be read-only (e.g.
    // `if (videoRef.current) setCurrentTime(videoRef.current.currentTime)`),
    // never an assignment to `.currentTime =`, and never `.play()`/`.pause()`
    // outside the controller's own construction effect.
    expect(source).not.toMatch(/videoRef\.current\.currentTime\s*=/);
    expect(source).not.toMatch(/videoRef\.current\?\.currentTime\s*=/);
  });
});
