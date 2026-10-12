import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { parseFfprobeVideoMetadata } from "../../src/jobs/video-metadata.js";

test("ffprobe video projection accepts only bounded, validated metadata", () => {
  const metadata = parseFfprobeVideoMetadata(Buffer.from(JSON.stringify({
    format: { duration: "1.25" },
    streams: [{ codec_name: "h264", avg_frame_rate: "30000/1001", nb_frames: "37" }],
  })));
  assert.deepEqual(metadata, { durationMs: 1250, fps: 30000 / 1001, totalFrames: 37, codec: "h264" });
});

test("ffprobe video projection rejects malformed or unbounded output", () => {
  assert.equal(parseFfprobeVideoMetadata(Buffer.from("not-json")), null);
  assert.equal(parseFfprobeVideoMetadata(Buffer.from(JSON.stringify({ format: { duration: "999999" }, streams: [{}] }))), null);
});

test("Matroska/WebM carries no stream frame count: totalFrames stays null (never fabricated) while fps and duration persist", () => {
  // Shape captured from real ffprobe 5.1.9 on a libvpx-vp9 WebM: no nb_frames key, DURATION only as a tag.
  const metadata = parseFfprobeVideoMetadata(Buffer.from(JSON.stringify({
    format: { duration: "3.000000", format_name: "matroska,webm" },
    streams: [{ codec_name: "vp9", avg_frame_rate: "15/1", r_frame_rate: "15/1", tags: { DURATION: "00:00:03.000000000" } }],
  })));
  assert.deepEqual(metadata, { durationMs: 3000, fps: 15, totalFrames: null, codec: "vp9" });
});
