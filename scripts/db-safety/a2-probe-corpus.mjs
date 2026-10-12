#!/usr/bin/env node
// Regenerates apps/worker/tests/media/fixtures/premedia-corpus.json: fixtures are generated INSIDE the pinned worker image (network-less, read-only), probed with the
// FIXED section 6.1 invocation, and only the source SHA-256, size, ffprobe exit/stderr first line and the parsed ffprobe JSON are recorded (no media bytes are checked in).
// The AVIF/HEIC negative sample is sourced from the image's own libaom encoder (risk R3): this adds NO AVIF/HEIC support.
//   node scripts/db-safety/a2-probe-corpus.mjs [--image <worker image>]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
const image = args.includes('--image') ? args[args.indexOf('--image') + 1] : 'annotationplatformmvp-worker:mvp-029-92ebc7117602';
const PROBE = '-v error -hide_banner -probesize 10000000 -analyzeduration 5000000 -show_entries format=format_name,duration,size,nb_streams:format_tags=major_brand,compatible_brands:stream=index,codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration:stream_disposition=default,attached_pic,still_image,timed_thumbnails -of json';
const script = String.raw`
set -u
cd /tmp
V="-f lavfi -i testsrc=duration=2:size=128x96:rate=10"
A="-f lavfi -i sine=frequency=440:duration=2"
ffmpeg -loglevel error -y -f lavfi -i color=c=red:s=64x64:d=1 -frames:v 1 cover.png
g() { n="$1"; shift; "$@" >/dev/null 2>&1 || echo "GEN_FAILED $n" >&2; }
g mp4_h264_video_audio ffmpeg -loglevel error -y $V $A -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest mp4_h264_video_audio.mp4
g mp4_h264_with_cover ffmpeg -loglevel error -y $V $A -i cover.png -map 0:v -map 1:a -map 2:v -c:v:0 libx264 -pix_fmt yuv420p -c:a aac -c:v:1 mjpeg -disposition:v:1 attached_pic -shortest mp4_h264_with_cover.mp4
g mp4_audio_only_m4a ffmpeg -loglevel error -y $A -c:a aac mp4_audio_only.m4a
g m4a_cover_art ffmpeg -loglevel error -y $A -i cover.png -map 0:a -map 1:v -c:a aac -c:v mjpeg -disposition:v attached_pic m4a_cover_art.m4a
g flac_picture ffmpeg -loglevel error -y $A -i cover.png -map 0:a -map 1:v -c:a flac -c:v mjpeg -disposition:v attached_pic flac_picture.flac
g webm_vp8 ffmpeg -loglevel error -y $V -c:v libvpx webm_vp8.webm
g webm_vp9 ffmpeg -loglevel error -y $V -c:v libvpx-vp9 webm_vp9.webm
g webm_av1 ffmpeg -loglevel error -y $V -c:v libaom-av1 -cpu-used 8 webm_av1.webm
g mp4_hevc ffmpeg -loglevel error -y $V -c:v libx265 -pix_fmt yuv420p mp4_hevc.mp4
g mkv_h264 ffmpeg -loglevel error -y $V -c:v libx264 -pix_fmt yuv420p mkv_h264.mkv
g ogg_vorbis ffmpeg -loglevel error -y $A -c:a libvorbis ogg_vorbis.ogg
g avi_mpeg4 ffmpeg -loglevel error -y $V -c:v mpeg4 avi_mpeg4.avi
g avif_still ffmpeg -loglevel error -y -f lavfi -i testsrc=size=64x64 -frames:v 1 -c:v libaom-av1 avif_still.avif
g mp4_tiny_8x8 ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=2:size=8x8:rate=10 -c:v libx264 -pix_fmt yuv420p mp4_tiny_8x8.mp4
g mp4_single_frame ffmpeg -loglevel error -y -f lavfi -i testsrc=size=64x64 -frames:v 1 -c:v libx264 -pix_fmt yuv420p mp4_single_frame.mp4
head -c 2000 mp4_h264_video_audio.mp4 > mp4_truncated.mp4
head -c 4096 /dev/urandom > data_only.mp4
for f in *.mp4 *.m4a *.flac *.webm *.mkv *.ogg *.avi *.avif; do
  [ -f "$f" ] || continue
  out="$(ffprobe ${PROBE} "$f" 2>/tmp/err.txt)"; code=$?
  printf 'FIXTURE\t%s\t%s\t%s\t%s\t%s\t%s\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)" "$(wc -c < "$f")" "$code" "$(head -1 /tmp/err.txt | tr '\t' ' ' | cut -c1-120)" "$(printf '%s' "$out" | tr -d '\n')"
done
printf 'FFPROBE\t%s\n' "$(ffprobe -version | head -1)"
`.replace('${PROBE}', PROBE);
const run = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=128m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--entrypoint', 'sh', image, '-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) { console.error('CORPUS_CONTAINER_FAILED', run.stderr.slice(0, 300)); process.exit(1); }
const fixtures = []; let ffprobeVersion = '';
for (const line of run.stdout.split('\n')) {
  const [kind, name, sha, bytes, exit, stderr, json] = line.split('\t');
  if (kind === 'FFPROBE') ffprobeVersion = name;
  if (kind === 'FIXTURE') { let document = null; try { document = JSON.parse(json); } catch { /* non-zero exit */ } fixtures.push({ file: name, sha256: sha, bytes: Number(bytes), ffprobeExit: Number(exit), stderrFirstLine: stderr, document }); }
}
const out = resolve(import.meta.dirname, '../../apps/worker/tests/media/fixtures/premedia-corpus.json');
writeFileSync(out, JSON.stringify({ schema: 'phase029-a2-premedia-corpus/v1', image, ffprobeVersion, probeArgs: PROBE, generationWarnings: run.stderr.split('\n').filter(Boolean), fixtures }, null, 1) + '\n');
console.log(ffprobeVersion); for (const f of fixtures) console.log(f.file.padEnd(28), 'exit', f.ffprobeExit, f.document ? (f.document.format?.format_name ?? '?') : '(no json)'); console.log('warnings:', run.stderr.split('\n').filter(Boolean));
