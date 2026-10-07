// D7 characterization (frozen contract section 6.3, step 1): record what the CURRENT repository classifier does for a fixture corpus, using the real
// ffprobe of the pinned worker image with today's probe arguments. No behavior is changed here. Fixtures are generated inside a short-lived, network-less,
// read-only container from the exact worker image; only bytes' SHA-256, the ffprobe exit/JSON and the classifier verdict are recorded.
//   node --import tsx scripts/db-safety/a2-d7-characterize.mts [--image <worker image>]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { classifyDefinitiveHeader, classifyProbeOutput } from "../../apps/worker/src/jobs/repository-media-classification.js";

const args = process.argv.slice(2);
const image = args.includes("--image") ? args[args.indexOf("--image") + 1] : "annotationplatformmvp-worker:mvp-029-92ebc7117602";
const script = String.raw`
set -u
cd /tmp
R() { n="$1"; shift; if "$@" >/tmp/$n.log 2>&1; then :; else echo "GEN_FAILED $n" >&2; fi; }
V="-f lavfi -i testsrc=duration=2:size=128x96:rate=10"
A="-f lavfi -i sine=frequency=440:duration=2"
ffmpeg -loglevel error -y $V -f lavfi -i color=c=red:s=64x64 -frames:v 1 cover.png 2>/dev/null
ffmpeg -loglevel error -y -f lavfi -i color=c=red:s=64x64:d=1 -frames:v 1 cover.png
R mp4_video_audio ffmpeg -loglevel error -y $V $A -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest mp4_video_audio.mp4
R mp4_video_only ffmpeg -loglevel error -y $V -c:v libx264 -pix_fmt yuv420p mp4_video_only.mp4
R mp4_audio_only ffmpeg -loglevel error -y $A -c:a aac mp4_audio_only.m4a
R m4a_cover_art ffmpeg -loglevel error -y $A -i cover.png -map 0:a -map 1:v -c:a aac -c:v mjpeg -disposition:v attached_pic m4a_cover_art.m4a
R mp3_id3_cover ffmpeg -loglevel error -y $A -i cover.png -map 0:a -map 1:v -c:a libmp3lame -c:v mjpeg -id3v2_version 3 -disposition:v attached_pic mp3_id3_cover.mp3
R flac_picture ffmpeg -loglevel error -y $A -i cover.png -map 0:a -map 1:v -c:a flac -c:v mjpeg -disposition:v attached_pic flac_picture.flac
R webm_vp8 ffmpeg -loglevel error -y $V -c:v libvpx webm_vp8.webm
R webm_vp9 ffmpeg -loglevel error -y $V -c:v libvpx-vp9 webm_vp9.webm
R mp4_hevc ffmpeg -loglevel error -y $V -c:v libx265 -pix_fmt yuv420p mp4_hevc.mp4
R avif_still ffmpeg -loglevel error -y -f lavfi -i testsrc=size=64x64 -frames:v 1 -c:v libaom-av1 avif_still.avif
head -c 2000 mp4_video_audio.mp4 > mp4_truncated.mp4 2>/dev/null
head -c 4096 /dev/urandom > data_only.mp4
for f in *.mp4 *.m4a *.mp3 *.flac *.webm *.avif; do
  [ -f "$f" ] || continue
  out="$(ffprobe -v error -show_entries stream=codec_type -of json "$f" 2>/tmp/err.txt)"; code=$?
  printf 'FIXTURE\t%s\t%s\t%s\t%s\t%s\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)" "$(wc -c < "$f")" "$code" "$(printf '%s' "$out" | tr -d '\n ')"
  printf 'PREFIX\t%s\t%s\n' "$f" "$(head -c 65536 "$f" | base64 -w0)"
done
printf 'FFPROBE\t%s\n' "$(ffprobe -version | head -1)"
`;
const run = spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,size=64m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534", "--entrypoint", "sh", image, "-c", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) { console.error("CHARACTERIZATION_CONTAINER_FAILED", run.stderr.slice(0, 300)); process.exit(1); }
const rows: any[] = []; const prefixes = new Map<string, Buffer>(); let ffprobeVersion = "";
for (const line of run.stdout.split("\n")) {
  const [kind, name, ...rest] = line.split("\t");
  if (kind === "FFPROBE") ffprobeVersion = name!;
  if (kind === "PREFIX") prefixes.set(name!, Buffer.from(rest[0] ?? "", "base64"));
  if (kind === "FIXTURE") rows.push({ file: name, sha256: rest[0], bytes: Number(rest[1]), ffprobeExit: Number(rest[2]), probeJson: rest[3] });
}
const verdict = (fn: () => unknown) => { try { return String(fn()); } catch (error: any) { return `THROWS:${error.message}`; } };
for (const row of rows) {
  const prefix = prefixes.get(row.file)!;
  const header = classifyDefinitiveHeader(prefix);
  // Mirrors verifyRepositoryObjectModality: a definitive header wins; otherwise a completed probe is interpreted; a non-zero exit is "unverified".
  row.currentClassification = header ?? (row.ffprobeExit === 0 ? verdict(() => classifyProbeOutput(row.probeJson)) : "THROWS:SOURCE_CONTENT_UNVERIFIED(probe-not-completed)");
  row.path = header ? "header" : "ffprobe";
}
const expected: Record<string, string> = {
  "mp4_video_audio.mp4": "VIDEO", "mp4_video_only.mp4": "VIDEO", "mp4_audio_only.m4a": "AUDIO", "m4a_cover_art.m4a": "AUDIO", "mp3_id3_cover.mp3": "AUDIO", "flac_picture.flac": "AUDIO",
  "webm_vp8.webm": "VIDEO", "webm_vp9.webm": "VIDEO", "mp4_hevc.mp4": "VIDEO(container; codec policy is a later A2 gate)", "avif_still.avif": "STILL (never VIDEO)",
};
for (const row of rows) { const want = expected[row.file]; row.contractExpectation = want ?? "reject (malformed)"; row.exposesDefect = (row.file === "m4a_cover_art.m4a" || row.file === "flac_picture.flac" || row.file === "avif_still.avif") && row.currentClassification === "VIDEO"; }
const outDir = join(process.cwd(), "specs/029-modality-specific-datasets/verification/a2-m26", `d7-characterization-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`);
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const report = { image, ffprobeVersion, probeArgs: "-v error -show_entries stream=codec_type -of json", classifier: "classifyDefinitiveHeader + classifyProbeOutput (exported, unchanged behavior)", rows };
writeFileSync(join(outDir, "d7-characterization.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o400 }); chmodSync(join(outDir, "d7-characterization.json"), 0o400);
console.log(ffprobeVersion);
for (const row of rows) console.log(`${row.file.padEnd(22)} exit=${String(row.ffprobeExit).padEnd(3)} via=${row.path.padEnd(7)} current=${String(row.currentClassification).padEnd(48)} contract=${row.contractExpectation}${row.exposesDefect ? "   <== DEFECT (F6)" : ""}`);
console.log("report:", outDir);
