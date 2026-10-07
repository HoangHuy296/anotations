#!/usr/bin/env node
// A2 release guard. The M26 enum addition is NOT independently rollout-safe once a VERIFY_UPLOADED_MEDIA Job row exists: a web/worker built with the M25-generated client cannot
// read such a Job. Before MEDIA_VERIFICATION_ENABLED=1 may be set anywhere, every image that consumes the database must carry a client that knows the value.
//   node scripts/db-safety/a2-release-guard.mjs --image <tag> [--image <tag> ...]     (read-only: runs `grep` inside each image, nothing is started or modified)
//   node scripts/db-safety/a2-release-guard.mjs --tree <dir containing lib/generated/prisma>
// Exit 0 only when EVERY named consumer knows the value; otherwise 1 and the offenders are listed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GUARDED_VALUE = 'VERIFY_UPLOADED_MEDIA';
export const CLIENT_ENUMS = 'lib/generated/prisma/enums.ts';

/** True when the generated client under `root` declares the JobType value (a client generated before M26 does not). */
export function clientKnowsVerifyJobType(root) {
  const file = join(resolve(root), CLIENT_ENUMS);
  return existsSync(file) && new RegExp(`${GUARDED_VALUE}:\\s*'${GUARDED_VALUE}'`).test(readFileSync(file, 'utf8'));
}
export function imageKnowsVerifyJobType(image, run = spawnSync) {
  const r = run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--entrypoint', 'grep', image, '-c', GUARDED_VALUE, `/workspace/${CLIENT_ENUMS}`], { encoding: 'utf8' });
  return r.status === 0 && Number(r.stdout.trim()) >= 1;
}
export function evaluateConsumers({ images = [], trees = [] }, probes = { image: imageKnowsVerifyJobType, tree: clientKnowsVerifyJobType }) {
  if (images.length + trees.length === 0) return { ok: false, offenders: ['NO_CONSUMER_NAMED'] };
  const offenders = [...images.filter(image => !probes.image(image)).map(image => `image:${image}`), ...trees.filter(tree => !probes.tree(tree)).map(tree => `tree:${tree}`)];
  return { ok: offenders.length === 0, offenders };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2); const images = [], trees = [];
  for (let i = 0; i < argv.length; i += 2) { if (argv[i] === '--image') images.push(argv[i + 1]); else if (argv[i] === '--tree') trees.push(argv[i + 1]); else { console.error('USAGE'); process.exit(2); } }
  const result = evaluateConsumers({ images, trees });
  console.log(JSON.stringify({ guard: 'a2-release-guard', value: GUARDED_VALUE, ...result }, null, 2));
  process.exit(result.ok ? 0 : 1);
}
