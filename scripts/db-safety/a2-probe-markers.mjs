#!/usr/bin/env node
// G-PROBE characterization (contract section 6.2 step 9 / section 14): runs the FIXED section 6.1 ffprobe invocation against genuinely malformed CONTENT fixtures and
// injected FAULTS inside the pinned worker image (network-less, read-only root, all capabilities dropped, unprivileged user) and records only the ffprobe exit status
// and the normalized stderr. The version-keyed marker table in apps/worker/src/media/classification-policy.ts may contain only strings proven here; the offline test
// apps/worker/tests/media/probe-markers.test.ts enforces that against the committed fixture.
//   node scripts/db-safety/a2-probe-markers.mjs [--image <worker image>]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
const image = args.includes('--image') ? args[args.indexOf('--image') + 1] : 'annotationplatformmain-worker:main-dcd540b7c665';
const PROBE = '-v error -hide_banner -probesize 10000000 -analyzeduration 5000000 -show_entries format=format_name,duration,size,nb_streams:format_tags=major_brand,compatible_brands:stream=index,codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration:stream_disposition=default,attached_pic,still_image,timed_thumbnails -of json';
const script = String.raw`
set -u
cd /tmp
V="-f lavfi -i testsrc=duration=2:size=128x96:rate=10"
ffmpeg -loglevel error -y $V -c:v libx264 -pix_fmt yuv420p good.mp4
ffmpeg -loglevel error -y $V -c:v libvpx-vp9 good.webm
run() { cls="$1"; name="$2"; shift; shift; err="$("$@" 2>&1 >/dev/null)"; code=$?; printf 'CASE\t%s\t%s\t%s\t%s\n' "$cls" "$name" "$code" "$(printf '%s' "$err" | head -3 | tr '\n\t' '  ' | sed -E 's/0x[0-9a-f]+/0xADDR/g; s#/tmp/[A-Za-z0-9_./-]+#<PATH>#g' | cut -c1-240)"; }
P="__PROBE__"
run control control_good_mp4 ffprobe $P good.mp4
run control control_good_webm ffprobe $P good.webm
head -c 2000 good.mp4 > a.mp4;                run content content_truncated_mp4_no_moov ffprobe $P a.mp4
head -c 4096 /dev/urandom > b.mp4;            run content content_random_bytes_mp4 ffprobe $P b.mp4
printf 'this is a text file pretending to be a video\n' > c.mp4; run content content_text_named_mp4 ffprobe $P c.mp4
: > d.mp4;                                    run content content_empty_file ffprobe $P d.mp4
head -c 4096 /dev/zero > e.mp4;               run content content_zero_bytes ffprobe $P e.mp4
head -c 4096 /dev/urandom > f.webm;           run content content_random_bytes_webm ffprobe $P f.webm
printf '\032\105\337\243garbagegarbagegarbagegarbage' > g.webm; run content content_ebml_magic_garbage ffprobe $P g.webm
head -c 100 good.webm > h.webm;               run content content_truncated_webm_100 ffprobe $P h.webm
head -c 40 good.webm > i.webm;                run content content_truncated_webm_40 ffprobe $P i.webm
S=$(wc -c < good.webm); head -c $((S/2)) good.webm > j.webm; run content content_truncated_webm_half ffprobe $P j.webm
run fault fault_missing_file ffprobe $P /tmp/does-not-exist.mp4
run fault fault_is_directory ffprobe $P /tmp
cp good.mp4 k.mp4; chmod 000 k.mp4;           run fault fault_permission_denied ffprobe $P k.mp4
run fault fault_read_eio ffprobe $P /proc/self/mem
run fault fault_dangling_symlink sh -c 'ln -sf /nonexistent/x /tmp/dangling.mp4; ffprobe '"$P"' /tmp/dangling.mp4'
( ulimit -v 40000; run fault fault_memory_exhaustion ffprobe $P good.mp4 )
run fault fault_sigkill timeout -s KILL 0.02 ffprobe $P good.mp4
run fault fault_sigterm_timeout timeout -s TERM 0.02 ffprobe $P good.mp4
printf 'FFPROBE\t%s\n' "$(ffprobe -version | head -1)"
`.replace('__PROBE__', PROBE);
const run = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=128m,exec', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--entrypoint', 'sh', image, '-c', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (run.status !== 0) { console.error('PROBE_CHARACTERIZATION_FAILED', run.stderr.slice(0, 300)); process.exit(1); }
const cases = []; let ffprobeBanner = '';
for (const line of run.stdout.split('\n')) {
  const [kind, cls, name, exit, stderr] = line.split('\t');
  if (kind === 'FFPROBE') ffprobeBanner = cls;
  if (kind === 'CASE') cases.push({ class: cls, name, exitCode: Number(exit), stderr: (stderr ?? '').replace(/\s+/g, ' ').trim() });
}
const version = /^ffprobe version (\S+)/.exec(ffprobeBanner)?.[1] ?? '';
const out = resolve(import.meta.dirname, '../../apps/worker/tests/media/fixtures/probe-characterization.json');
writeFileSync(out, JSON.stringify({ schema: 'phase029-a2-probe-characterization/v1', image, ffprobeVersion: version, probeArgs: PROBE, cases }, null, 1) + '\n');
for (const c of cases) console.log(c.class.padEnd(8), c.name.padEnd(34), 'exit', String(c.exitCode).padEnd(4), c.stderr.slice(0, 110));
console.log('ffprobe', version);
