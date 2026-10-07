// Independent cleanup verifier for the S0 storage-authority run. Uses only the Docker CLI and the recorded ids/labels (no MinIO client, no
// credentials, no code shared with the supervisor beyond reading its ids file):  node minio-authority-verify.mjs <s0-ids.json>
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const docker = args => { const r = spawnSync('docker', args, { encoding: 'utf8' }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
const ids = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const checks = [];
const add = (id, ok, detail) => checks.push({ id, ok, detail });
const label = `annotation.run=${ids.runId}`;
const byLabel = docker(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}} {{.Names}}']).stdout.trim();
add('no-container-with-run-label', byLabel === '', byLabel || 'none');
for (const container of ids.containers) {
  const r = docker(['inspect', container.id]);
  add(`container-absent:${container.role}`, r.status !== 0, r.status !== 0 ? 'absent' : 'STILL PRESENT');
}
const networks = docker(['network', 'ls', '--filter', `label=${label}`, '--format', '{{.ID}}']).stdout.trim();
add('no-network-with-run-label', networks === '', networks || 'none');
for (const network of ids.networks) add(`network-absent:${network.id.slice(0, 12)}`, docker(['network', 'inspect', network.id]).status !== 0, 'checked');
for (const volume of ids.volumes) add(`volume-absent:${volume.slice(0, 12)}`, docker(['volume', 'inspect', volume]).status !== 0, 'checked');
const volumes = docker(['volume', 'ls', '--filter', `label=${label}`, '--format', '{{.Name}}']).stdout.trim();
add('no-volume-with-run-label', volumes === '', volumes || 'none');
console.log(JSON.stringify({ ok: checks.every(check => check.ok), runId: ids.runId, checks }));
process.exitCode = checks.every(check => check.ok) ? 0 : 1;
