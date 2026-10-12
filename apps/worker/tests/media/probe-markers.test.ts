import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database is touched).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FFPROBE_INVALID_MARKERS, interpretProbeCompletion, parseFfprobeVersion, type ProbeCompletionInput } from "../../src/media/classification-policy.js";

type Case = { class: "content" | "fault" | "control"; name: string; exitCode: number; stderr: string };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/probe-characterization.json", import.meta.url), "utf8")) as { ffprobeVersion: string; cases: Case[] };
const version = fixture.ffprobeVersion;
const input = (c: Case, over: Partial<ProbeCompletionInput> = {}): ProbeCompletionInput => ({ ffprobeVersion: version, spawnError: false, timedOut: false, signal: null, exitCode: c.exitCode, stdoutTruncated: false, stdout: "", stderr: c.stderr, ...over });
// Operational by design: a Matroska file truncated by content ends in an I/O-looking message, which is indistinguishable from a read fault, so it is NEVER a marker.
const OPERATIONAL_CONTENT = new Set(["content_truncated_webm_100", "content_truncated_webm_40"]);

test("G-PROBE: the characterization was run on the pinned ffprobe and the marker table is keyed by exactly that version", () => {
  assert.equal(parseFfprobeVersion(`ffprobe version ${version} Copyright (c) 2007-2026 the FFmpeg developers`), version);
  assert.deepEqual(Object.keys(FFPROBE_INVALID_MARKERS), [version]);
  assert.equal(FFPROBE_INVALID_MARKERS[version]!.length, 1);
  assert.deepEqual(fixture.cases.map(c => c.class).filter((v, i, a) => a.indexOf(v) === i).sort(), ["content", "control", "fault"]);
});

test("G-PROBE: every genuinely malformed/forged CONTENT fixture with a recorded marker is an authoritative invalid-media verdict", () => {
  const content = fixture.cases.filter(c => c.class === "content" && c.exitCode === 1 && !OPERATIONAL_CONTENT.has(c.name));
  assert.ok(content.length >= 6, "the corpus must cover mp4 and matroska forgeries");
  for (const c of content) assert.equal(interpretProbeCompletion(input(c)).kind, "COMPLETED_INVALID", c.name);
});

test("G-PROBE non-overlap: no injected FAULT (read EIO, permission denied, missing file, directory, dangling link, memory exhaustion, SIGKILL, timeout) can become a marker", () => {
  const faults = fixture.cases.filter(c => c.class === "fault");
  assert.ok(faults.length >= 8);
  for (const c of faults) {
    const out = interpretProbeCompletion(input(c, { signal: c.exitCode === 137 ? "SIGKILL" : null, timedOut: c.exitCode === 124, exitCode: c.exitCode === 137 || c.exitCode === 124 ? null : c.exitCode }));
    assert.equal(out.kind, "NOT_COMPLETED", c.name);
  }
});

test("G-PROBE: content truncated mid-file that ffprobe reports as an I/O-looking error stays operational; a successful (exit 0) probe is never a marker case", () => {
  for (const name of OPERATIONAL_CONTENT) { const c = fixture.cases.find(x => x.name === name)!; assert.equal(interpretProbeCompletion(input(c)).kind, "NOT_COMPLETED", name); }
  for (const c of fixture.cases.filter(x => x.exitCode === 0)) assert.equal(c.stderr === "" || !/Invalid data found/.test(c.stderr), true, c.name);
});

test("G-PROBE: a different ffprobe version has NO markers (every non-zero exit is operational until it is re-characterized)", () => {
  const forged = fixture.cases.find(c => c.name === "content_text_named_mp4")!;
  assert.equal(interpretProbeCompletion(input(forged, { ffprobeVersion: "6.0" })).kind, "NOT_COMPLETED");
  assert.equal(interpretProbeCompletion(input(forged, { ffprobeVersion: "unknown" })).kind, "NOT_COMPLETED");
  assert.equal(parseFfprobeVersion("not a banner"), "unknown");
});

test("R5: timeout, signal, spawn failure, output cap and unparseable zero-exit output are operational even with a marker-looking stderr", () => {
  const forged = fixture.cases.find(c => c.name === "content_text_named_mp4")!;
  assert.deepEqual(interpretProbeCompletion(input(forged, { timedOut: true })), { kind: "NOT_COMPLETED", reason: "UPLOAD_VERIFICATION_PROBE_TIMEOUT" });
  for (const over of [{ signal: "SIGKILL" }, { spawnError: true }, { stdoutTruncated: true }, { exitCode: null }] as Partial<ProbeCompletionInput>[]) assert.equal(interpretProbeCompletion(input(forged, over)).kind, "NOT_COMPLETED", JSON.stringify(over));
  assert.equal(interpretProbeCompletion({ ...input(forged), exitCode: 0, stdout: "not json" }).kind, "NOT_COMPLETED");
  assert.equal(interpretProbeCompletion({ ...input(forged), exitCode: 0, stdout: "[]" }).kind, "NOT_COMPLETED");
  assert.equal(interpretProbeCompletion({ ...input(forged), exitCode: 0, stdout: "{\"format\":{}}" }).kind, "COMPLETED");
});
