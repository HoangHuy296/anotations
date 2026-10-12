import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database, network or process is used).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifyProbeOutput } from "../../src/jobs/repository-media-classification.js";
import {
  ALLOWED_CONTAINERS, ALLOWED_VIDEO_CODECS, FFPROBE_INVALID_MARKERS, PROBE_LIMITS, buildPremediaProbeArgs, classOfPremedia, classifyPremedia, interpretProbeCompletion, isPictureStream,
  type ProbeCompletionInput, type ProbeDocument,
} from "../../src/media/classification-policy.js";

// A2.3 foundation, offline. `premedia-verify.v2` (frozen contract section 6) is exercised as a PURE function over (a) synthetic documents, one per gate, and (b) a corpus of REAL ffprobe
// output generated inside the pinned worker image with the fixed section 6.1 invocation (scripts/db-safety/a2-probe-corpus.mjs). It is not wired into any ingestion path.
const corpus = JSON.parse(readFileSync(new URL("./fixtures/premedia-corpus.json", import.meta.url), "utf8")) as { ffprobeVersion: string; fixtures: Array<{ file: string; sha256: string; bytes: number; ffprobeExit: number; document: ProbeDocument | null }> };
const fixture = (file: string) => { const found = corpus.fixtures.find(entry => entry.file === file); assert.ok(found, file); return found!; };
const decide = (file: string, sizeBytes?: number) => { const f = fixture(file); assert.ok(f.document, `${file} has a completed probe`); return classifyPremedia({ document: f.document!, sizeBytes: sizeBytes ?? f.bytes, ffprobeVersion: corpus.ffprobeVersion, boundModality: "VIDEO" }); };
const rejection = (file: string) => { const d = decide(file); assert.equal(d.outcome, "REJECTED", file); return d.outcome === "REJECTED" ? `${d.code}/${d.reason}` : ""; };

const video = (extra: Record<string, unknown> = {}) => ({ index: 0, codec_type: "video", codec_name: "h264", width: 128, height: 96, nb_frames: "20", duration: "2.0", disposition: {}, ...extra });
const mp4 = (streams: object[], tags: Record<string, string> = {}): ProbeDocument => ({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.0", tags }, streams: streams as never });

test("the probe invocation is fixed and bounded; the only variable argument is the private file path", () => {
  const args = buildPremediaProbeArgs("/tmp/candidate");
  assert.deepEqual(args.slice(0, 7), ["-v", "error", "-hide_banner", "-probesize", "10000000", "-analyzeduration", "5000000"]);
  assert.equal(args.at(-1), "/tmp/candidate");
  assert.deepEqual(buildPremediaProbeArgs("/x").slice(0, -1), args.slice(0, -1), "nothing but the path varies");
  assert.deepEqual({ ...PROBE_LIMITS }, { timeoutMs: 120_000, outputCapBytes: 65_536, sourceCapBytes: 104_857_600 });
});

test("gate by gate: container, picture streams, usable video track, codec, still-image brand, class, bound modality, limits", () => {
  const ok = classifyPremedia({ document: mp4([video()]), sizeBytes: 1000, ffprobeVersion: "t", boundModality: "VIDEO" });
  assert.equal(ok.outcome === "CLASSIFIED" && ok.class, "VIDEO");
  const code = (document: ProbeDocument, sizeBytes = 1000) => { const d = classifyPremedia({ document, sizeBytes, ffprobeVersion: "t", boundModality: "VIDEO" }); return d.outcome === "REJECTED" ? `${d.code}/${d.reason}` : `OK:${d.class}`; };
  assert.equal(code({ ...mp4([video()]), format: { format_name: "ogg" } }), "UNSUPPORTED_MEDIA/CONTAINER_UNSUPPORTED");
  for (const name of ["avi", "mpegts", "image2", "gif", "flac"]) assert.equal(code({ ...mp4([video()]), format: { format_name: name } }), "UNSUPPORTED_MEDIA/CONTAINER_UNSUPPORTED", name);
  assert.equal(code(mp4([video({ codec_name: "hevc" })])), "UNSUPPORTED_MEDIA/CODEC_UNSUPPORTED");
  assert.equal(code(mp4([video({ codec_name: "mpeg4" })])), "UNSUPPORTED_MEDIA/CODEC_UNSUPPORTED");
  for (const codec of ALLOWED_VIDEO_CODECS) assert.equal(code(mp4([video({ codec_name: codec })])), "OK:VIDEO", codec);
  assert.equal(code(mp4([video({ width: 8, height: 8 })])), "INVALID_MEDIA/MEDIA_POLICY_REJECTED", "dimension floor");
  assert.equal(code(mp4([video({ width: 9000 })])), "INVALID_MEDIA/MEDIA_POLICY_REJECTED", "dimension ceiling");
  assert.equal(code(mp4([video({ nb_frames: "1", duration: "0.04" })])), "INVALID_MEDIA/MEDIA_POLICY_REJECTED", "a single frame is not a usable video");
  assert.equal(code(mp4([video({ nb_frames: "1", duration: "0.5" })])), "OK:VIDEO", "duration alone also qualifies");
  assert.equal(code(mp4([video()], { major_brand: "avif" })), "UNSUPPORTED_MEDIA/STILL_OR_COVER_ART", "a still-image brand is negative evidence");
  assert.equal(code(mp4([video()], { compatible_brands: "isom,heic" })), "UNSUPPORTED_MEDIA/STILL_OR_COVER_ART");
  assert.equal(code(mp4([video()], { major_brand: "isom", compatible_brands: "isomiso2avc1mp41" })), "OK:VIDEO", "a brand never ACCEPTS anything and ordinary brands do not reject");
  assert.equal(code(mp4([video()]), 101 * 1024 * 1024), "INVALID_MEDIA/MEDIA_POLICY_REJECTED", "over the 100 MiB cap");
  assert.equal(code(mp4(Array.from({ length: 17 }, (_, index) => video({ index })))), "INVALID_MEDIA/MEDIA_POLICY_REJECTED", "more than 16 streams");
  assert.equal(code(mp4([{ index: 0, codec_type: "audio", codec_name: "aac", disposition: {} }])), "ASSET_MODALITY_MISMATCH/CLASS_MISMATCH", "audio-only never publishes into a VIDEO Dataset");
  assert.equal(code(mp4([])), "UNSUPPORTED_MEDIA/CONTAINER_UNSUPPORTED", "nothing usable");
  const long = { ...mp4([video({ duration: "9999" })]), format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "9999" } };
  assert.equal(classifyPremedia({ document: long, sizeBytes: 1, ffprobeVersion: "t", boundModality: "VIDEO", maxDurationSeconds: 60 }).outcome, "REJECTED", "an explicit duration policy is honored (the maximum itself is an open decision)");
  assert.equal(classifyPremedia({ document: long, sizeBytes: 1, ffprobeVersion: "t", boundModality: "VIDEO" }).outcome, "CLASSIFIED", "no maximum is frozen, so none is enforced by default");
});

test("picture streams are never video tracks (cover art, still_image, timed_thumbnails, single-frame image codecs); genuine video plus a cover still qualifies", () => {
  const cover = { index: 1, codec_type: "video", codec_name: "mjpeg", width: 64, height: 64, nb_frames: "1", disposition: { attached_pic: 1 } };
  assert.equal(isPictureStream(cover), true);
  assert.equal(isPictureStream({ ...cover, disposition: { still_image: 1 } }), true);
  assert.equal(isPictureStream({ ...cover, disposition: { timed_thumbnails: 1 } }), true);
  assert.equal(isPictureStream({ ...cover, disposition: {} }), true, "an image codec with at most one frame is a picture even without a disposition");
  assert.equal(isPictureStream(video()), false);
  assert.equal(classOfPremedia(mp4([video(), cover])), "VIDEO");
  assert.equal(classOfPremedia(mp4([{ index: 0, codec_type: "audio" }, cover])), "AUDIO");
  assert.equal(classOfPremedia(mp4([cover])), "STILL");
  assert.equal(classOfPremedia(mp4([])), "NONE");
  const decision = classifyPremedia({ document: mp4([video(), { index: 2, codec_type: "audio", codec_name: "aac", disposition: {} }, cover]), sizeBytes: 1, ffprobeVersion: "t", boundModality: "VIDEO" });
  assert.equal(decision.outcome === "CLASSIFIED" && decision.probe.streams.filter(stream => stream.picture).length, 1, "the cover is recorded as a picture, not a video track");
});

test("REAL ffprobe corpus (pinned worker image): VIDEO is accepted only when every gate passes; cover art, stills, audio, other containers and HEVC are not VIDEO", () => {
  assert.match(corpus.ffprobeVersion, /ffprobe version 5\.1\.9/);
  for (const file of ["mp4_h264_video_audio.mp4", "mp4_h264_with_cover.mp4", "webm_vp8.webm", "webm_vp9.webm", "webm_av1.webm"]) { const d = decide(file); assert.equal(d.outcome === "CLASSIFIED" && d.class, "VIDEO", file); }
  assert.equal(rejection("mp4_hevc.mp4"), "UNSUPPORTED_MEDIA/CODEC_UNSUPPORTED");
  assert.equal(rejection("mp4_audio_only.m4a"), "ASSET_MODALITY_MISMATCH/CLASS_MISMATCH");
  assert.equal(rejection("m4a_cover_art.m4a"), "ASSET_MODALITY_MISMATCH/CLASS_MISMATCH", "9b: a cover-art M4A is AUDIO, never VIDEO");
  assert.equal(rejection("flac_picture.flac"), "UNSUPPORTED_MEDIA/CONTAINER_UNSUPPORTED");
  assert.equal(rejection("avif_still.avif"), "UNSUPPORTED_MEDIA/STILL_OR_COVER_ART", "a still image brand is never VIDEO");
  assert.equal(rejection("ogg_vorbis.ogg"), "UNSUPPORTED_MEDIA/CONTAINER_UNSUPPORTED");
  assert.equal(rejection("avi_mpeg4.avi"), "UNSUPPORTED_MEDIA/CONTAINER_UNSUPPORTED");
  assert.equal(rejection("mp4_tiny_8x8.mp4"), "INVALID_MEDIA/MEDIA_POLICY_REJECTED");
  assert.equal(rejection("mp4_single_frame.mp4"), "INVALID_MEDIA/MEDIA_POLICY_REJECTED");
  // A non-zero exit prints an empty document; classifying that would be wrong, so the probe-completion gate (not the policy) decides these: they are operational, never a verdict.
  for (const file of ["mp4_truncated.mp4", "data_only.mp4"]) { const f = fixture(file); assert.notEqual(f.ffprobeExit, 0, file); assert.deepEqual(f.document?.streams ?? [], [], file); }
  assert.ok(ALLOWED_CONTAINERS.includes("matroska,webm"));
});

test("[OPEN DECISION A2-D12] the frozen algorithm cannot tell Matroska from WebM by format_name, so an H.264 .mkv is accepted by the algorithm as written while contract test row 8 says MKV is rejected", () => {
  const d = decide("mkv_h264.mkv");
  assert.equal(d.outcome === "CLASSIFIED" && d.class, "VIDEO", "characterization of the frozen algorithm, NOT an endorsement; the contract needs a decision (for example: WebM-compatible codecs only inside matroska,webm)");
});

test("D7 characterization-diff: the legacy classifier calls cover-art M4A, picture FLAC and AVIF VIDEO (defect F6); the shared policy never does", () => {
  const legacy = (file: string) => { const f = fixture(file); const kinds = (f.document?.streams ?? []).map(stream => ({ codec_type: stream.codec_type })); try { return classifyProbeOutput(JSON.stringify({ streams: kinds })); } catch { return "THROWS"; } };
  for (const file of ["m4a_cover_art.m4a", "flac_picture.flac", "avif_still.avif"]) assert.equal(legacy(file), "VIDEO", `${file}: the legacy defect is characterized and must not become policy`);
  for (const file of ["m4a_cover_art.m4a", "flac_picture.flac"]) assert.notEqual(classOfPremedia(fixture(file).document!), "VIDEO", `${file}: the shared policy does not call it VIDEO`);
  // AVIF carries a plain av1 stream; only the still-image BRAND (negative evidence) separates it, so the brand-aware decision is what must refuse it.
  const avif = decide("avif_still.avif"); assert.equal(avif.outcome, "REJECTED"); assert.equal(avif.outcome === "REJECTED" && avif.reason, "STILL_OR_COVER_ART");
  for (const file of ["mp4_h264_video_audio.mp4", "webm_vp9.webm", "mp4_audio_only.m4a"]) assert.equal(legacy(file) === "VIDEO", classOfPremedia(fixture(file).document!) === "VIDEO", `${file}: unchanged where the legacy result was correct`);
});

test("probe completion (R5): only a completed probe may classify; timeout, signal, spawn failure, truncated or unparseable output and unmarked non-zero exits are operational and never a verdict", () => {
  const base: ProbeCompletionInput = { ffprobeVersion: corpus.ffprobeVersion, spawnError: false, timedOut: false, signal: null, exitCode: 0, stdoutTruncated: false, stdout: JSON.stringify({ streams: [] }), stderr: "" };
  assert.equal(interpretProbeCompletion(base).kind, "COMPLETED");
  const operational = (patch: Partial<ProbeCompletionInput>) => { const r = interpretProbeCompletion({ ...base, ...patch }); return r.kind === "NOT_COMPLETED" ? r.reason : r.kind; };
  assert.equal(operational({ timedOut: true }), "UPLOAD_VERIFICATION_PROBE_TIMEOUT");
  assert.equal(operational({ timedOut: true, exitCode: 1, signal: "SIGKILL" }), "UPLOAD_VERIFICATION_PROBE_TIMEOUT");
  for (const patch of [{ signal: "SIGKILL" }, { spawnError: true }, { exitCode: null }, { stdoutTruncated: true }, { stdout: "not json" }, { stdout: "[]" }, { exitCode: 1, stderr: "Invalid data found when processing input" }, { exitCode: 69, stderr: "moov atom not found" }]) {
    assert.equal(operational(patch as Partial<ProbeCompletionInput>), "UPLOAD_VERIFICATION_PROBE_FAILED", JSON.stringify(patch));
  }
  assert.deepEqual(Object.keys(FFPROBE_INVALID_MARKERS), ["5.1.9-0+deb12u1"], "a marker exists only for a version whose non-overlap G-PROBE has proved (probe-markers.test.ts); any other ffprobe version stays operational rather than guessed");
  assert.deepEqual(FFPROBE_INVALID_MARKERS["5.1.9-0+deb12u1"].map(m => [m.exitCode, m.stderr.source]), [[1, ": Invalid data found when processing input\\s*$"]]);
  assert.equal(interpretProbeCompletion({ ...base, ffprobeVersion: "5.1.9-0+deb12u1", exitCode: 1, stderr: "x.mp4: Invalid data found when processing input\n", stdout: "" }).kind, "COMPLETED_INVALID");
  assert.equal(interpretProbeCompletion({ ...base, ffprobeVersion: "6.0", exitCode: 1, stderr: "x.mp4: Invalid data found when processing input\n", stdout: "" }).kind, "NOT_COMPLETED", "an unpinned ffprobe version never produces an authoritative verdict");
  for (const file of ["mp4_truncated.mp4", "data_only.mp4"]) assert.equal(operational({ exitCode: fixture(file).ffprobeExit, stdout: "", stderr: "x" }), "UPLOAD_VERIFICATION_PROBE_FAILED", file);
});
