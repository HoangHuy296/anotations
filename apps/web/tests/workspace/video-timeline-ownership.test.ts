import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Structural/source-text assertions -- this repo has no jsdom/testing-library
// (AGENTS.md requires explicit permission before adding one), matching the
// existing `workspace-shell-boundary.test.ts` precedent for component
// boundary rules. Covers spec FR-047/FR-050 (US9): the timeline/toolbar own
// playback exclusively through `video-playback-controller.ts`, never touch
// the video element directly, and the timeline never creates or modifies an
// annotation as a side effect of a playback action -- plus FR-051/FR-008's
// existing-track "Add keyframe here" invariant, reaffirmed unchanged.
//
// `video-toolbar.tsx` now contains both what used to be two files: the
// transport/track-lifecycle controls, and (as an internal, non-exported
// `TimelineTrack` component) the annotation-tick/playhead visualization
// formerly in a standalone `video-timeline.tsx`. The whole-file checks below
// cover both; the `TimelineTrack`-scoped check narrows to just the
// visualization, since the merged file legitimately contains track-lifecycle
// callbacks (`onCreateTrack`/`onDeleteTrack`/etc.) elsewhere by design.

const workspaceDir = path.resolve(import.meta.dirname, "../../src/components/workspace");

async function readSource(file: string) {
  return readFile(path.join(workspaceDir, file), "utf8");
}

test("video-toolbar.tsx never touches the video element directly (no videoRef, currentTime, play(), or pause())", async () => {
  const source = await readSource("video-toolbar.tsx");
  assert.doesNotMatch(source, /videoRef/, "must not reference videoRef");
  assert.doesNotMatch(source, /\.currentTime\s*=/, "must not assign .currentTime");
  assert.doesNotMatch(source, /\.play\(\s*\)/, "must not call .play()");
  assert.doesNotMatch(source, /\.pause\(\s*\)/, "must not call .pause()");
});

test("video-toolbar.tsx's TimelineTrack (the merged former video-timeline.tsx) only exposes seek/select callbacks, never an annotation-mutation callback", async () => {
  const source = await readSource("video-toolbar.tsx");
  const start = source.indexOf("function TimelineTrack");
  assert.ok(start > -1, "expected to find TimelineTrack in video-toolbar.tsx");
  const fn = source.slice(start);
  // Its prop contract is playback/selection only (onSelectKeyframe/
  // onSelectDerived/onSeek) -- no create/delete/update annotation callback
  // exists for the timeline to invoke.
  assert.doesNotMatch(fn, /onCreate|onDelete|onUpdate/, "must not expose an annotation-mutation callback");
});

test("video-engine.tsx's seekTo (the only function VideoTimeline's onSeek/onSelectKeyframe/onSelectDerived ultimately call) goes through playbackController, not a raw videoRef assignment", async () => {
  const source = await readSource("video-engine.tsx");
  const start = source.indexOf("const seekTo =");
  assert.ok(start > -1, "expected to find seekTo in video-engine.tsx");
  const end = source.indexOf("const chooseKeyframe", start);
  const fn = source.slice(start, end);
  assert.match(fn, /playbackController\.seekToTime/, "seekTo must call playbackController.seekToTime");
  assert.doesNotMatch(fn, /videoRef\.current\.currentTime\s*=/, "seekTo must not assign videoRef.current.currentTime directly");
});

test("\"Existing track → Add keyframe here\" (addKeyframe) never creates a new VideoObjectTrack -- reaffirms FR-008/FR-022/FR-051 unchanged by this phase", async () => {
  const source = await readSource("video-engine.tsx");
  const start = source.indexOf("const addKeyframe =");
  assert.ok(start > -1, "expected to find addKeyframe in video-engine.tsx");
  const end = source.indexOf("const updateTrack =", start);
  const fn = source.slice(start, end);
  assert.doesNotMatch(fn, /createVideoTrack/, "addKeyframe must not call createVideoTrack -- it must only ever add a keyframe to the already-selected track");
  assert.match(fn, /if \(!selectedTrack\) return;/, "addKeyframe must require an existing selected track");
});
