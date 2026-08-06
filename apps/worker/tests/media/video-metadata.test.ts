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
