import assert from "node:assert/strict";
import test from "node:test";

import { buildAudioWaveform, parseFfprobeAudioMetadata, serializeAudioWaveform } from "../../src/media/waveform.js";

test("audio waveform parser accepts only bounded audio metadata", () => {
  const metadata = parseFfprobeAudioMetadata(Buffer.from(JSON.stringify({
    format: { duration: "2.5", bit_rate: "128000" },
    streams: [{ codec_type: "audio", codec_name: "opus", sample_rate: "48000", channels: 2 }],
  })));
  assert.deepEqual(metadata, { durationMs: 2500, sampleRate: 48000, channels: 2, codec: "opus", bitRate: 128000 });
  assert.equal(parseFfprobeAudioMetadata(Buffer.from("not-json")), null);
  assert.equal(parseFfprobeAudioMetadata(Buffer.from(JSON.stringify({ format: { duration: "999999" }, streams: [{ codec_type: "audio" }] })), 1000), null);
});

test("audio waveform buckets are normalized and serialized as a versioned private artifact", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(32767, 0);
  pcm.writeInt16LE(-16384, 2);
  pcm.writeInt16LE(0, 4);
  pcm.writeInt16LE(8192, 6);
  const waveform = buildAudioWaveform({ pcm, sampleRate: 48000, bucketCount: 2 });
  assert.ok(waveform);
  assert.equal(waveform.format, "fieldframe.audio-waveform.v1");
  assert.equal(waveform.channels, 1);
  assert.deepEqual(waveform.peaks, [0.999969, 0.25]);
  assert.ok(serializeAudioWaveform(waveform).length > 0);
  assert.equal(buildAudioWaveform({ pcm: Buffer.from([1]), sampleRate: 48000 }), null);
});
