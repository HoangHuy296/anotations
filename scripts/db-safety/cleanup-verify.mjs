// Independent post-cleanup verifier for a receipt-bound disposable run.
//
// The run's own cleanup (cleanup.json) is never trusted. The manifests written
// at allocation time only say WHICH resources must be gone; PASS/FAIL comes
// from fresh observations of Docker, the filesystem, the receipt registry,
// listening ports and /proc. Any missing expected identity, malformed manifest
// or required check that cannot be performed FAILS CLOSED.
//
// CLI: node scripts/db-safety/cleanup-verify.mjs <runDir> [--out <file>]
//   Writes <runDir>/cleanup-independent.json by default and refuses to overwrite
//   an existing receipt. Exit 0 = PASS, 1 = FAIL (including inability to verify).
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityOf, isMonitorProcess, listProcesses, selfAndAncestors } from './process-monitor.mjs';

export const RECEIPT_SCHEMA = 'cleanup-independent/v1';
export const RECEIPT_NAME = 'cleanup-independent.json';
const HEX64 = /^[0-9a-f]{64}$/;
const STAGE_PREFIX = '/tmp/phase029-g1-';
const REQUIRED_ROLES = ['minio', 'postgres', 'redis'];

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const safeStage = value => typeof value === 'string' && value.startsWith(STAGE_PREFIX) && !value.includes('..') && !value.includes('\0');

/** Resolves what must be absent. Anything unresolved is reported in `missing` and fails the verification. */
export function loadExpectations(runDir) {
  const missing = [];
  const need = (condition, reason) => { if (!condition) missing.push(reason); return condition; };
  const expect = { containers: [], volumes: [], paths: [], ports: [], processes: [], runtimeIds: [], needles: [], browserExpected: false, runToken: null, cleanupJsonClaims: [] };
  const fileIn = name => join(runDir, name);
  const load = name => { try { return readJson(fileIn(name)); } catch { missing.push(`MANIFEST_UNREADABLE:${name}`); return null; } };

  const identities = load('disposable-identities.json');
  if (Array.isArray(identities)) {
    need(identities.length === 3 && REQUIRED_ROLES.every(role => identities.some(entry => entry?.role === role)), 'IDENTITIES_INCOMPLETE:expected postgres, redis and minio');
    for (const entry of identities) {
      if (need(HEX64.test(entry?.id ?? '') && Number.isInteger(entry?.port), `IDENTITY_MALFORMED:${entry?.role ?? 'unknown'}`)) {
        expect.containers.push({ id: entry.id, role: entry.role, name: entry.name ?? null });
        expect.ports.push(entry.port);
      }
    }
  } else if (identities !== null) missing.push('IDENTITIES_NOT_AN_ARRAY');

  const ownership = load('allocation-ownership.json');
  if (ownership) {
    if (need(safeStage(ownership.privateStage), 'PRIVATE_STAGE_MISSING_OR_UNSAFE')) expect.paths.push({ kind: 'private-stage', path: ownership.privateStage });
    if (need(/^[0-9a-f]{8}$/.test(ownership.runToken ?? ''), 'RUN_TOKEN_MISSING')) { expect.runToken = ownership.runToken; expect.needles.push(`phase029-g1-g3-${ownership.runToken}`); }
  }

  const volumes = load('owned-volumes.json');
  if (Array.isArray(volumes)) { for (const entry of volumes) if (need(typeof entry?.name === 'string' && entry.name.length > 0, 'VOLUME_ENTRY_MALFORMED')) expect.volumes.push({ name: entry.name, source: 'allocation' }); }
  else if (volumes !== null) missing.push('VOLUMES_NOT_AN_ARRAY');

  // Browser identities come from the run's own logs. A browser allocation without a resolvable ownership receipt is unverifiable.
  let allocation = null, receipt = null;
  for (const name of readdirSync(runDir).filter(file => file.endsWith('.log') && !file.includes('postgres'))) {
    for (const line of readFileSync(fileIn(name), 'utf8').split('\n')) {
      try {
        if (line.startsWith('G5_BROWSER_ALLOCATION ')) allocation = JSON.parse(line.slice('G5_BROWSER_ALLOCATION '.length));
        if (line.startsWith('G4_RUNTIME_RECEIPT ')) receipt = JSON.parse(line.slice('G4_RUNTIME_RECEIPT '.length));
      } catch { missing.push(`LOG_RECORD_UNPARSEABLE:${name}`); }
    }
  }
  if (allocation) {
    expect.browserExpected = true;
    if (need(HEX64.test(allocation.containerId ?? ''), 'BROWSER_CONTAINER_ID_MISSING')) expect.containers.push({ id: allocation.containerId, role: 'browser', name: null });
    for (const volume of allocation.anonymousVolumes ?? []) expect.volumes.push({ name: volume, source: 'browser-allocation' });
    if (need(typeof allocation.runtime === 'string', 'BROWSER_RUNTIME_ID_MISSING')) { expect.runtimeIds.push(allocation.runtime); expect.needles.push(`phase029-g1-browser-${allocation.runtime}`); }
    const profile = receipt?.browserOwnership?.profile;
    if (need(receipt && safeStage(profile), 'BROWSER_PROFILE_UNRESOLVED:allocation present but no ownership receipt with a profile path')) {
      expect.paths.push({ kind: 'browser-profile', path: profile });
      const runtimeRoot = dirname(profile);
      if (safeStage(runtimeRoot)) { expect.paths.push({ kind: 'runtime-private-root', path: runtimeRoot }); expect.needles.push(runtimeRoot); }
    }
    for (const volume of receipt?.browserOwnership?.anonymousVolumes ?? []) if (!expect.volumes.some(entry => entry.name === volume)) expect.volumes.push({ name: volume, source: 'browser-receipt' });
  }
  if (receipt) {
    const recorded = [...(receipt.processes ?? []), { ...receipt.owner, role: 'owner' }, { ...receipt.browserCleanup?.containerProcess, role: 'browser-container' }, { ...receipt.browserCleanup?.attachProcess, role: 'browser-attach' }];
    for (const entry of recorded) {
      if (Number.isInteger(entry?.pid)) expect.processes.push({ pid: entry.pid, start: entry.start != null ? String(entry.start) : null, role: entry.role });
    }
  }
  if (expect.paths.find(entry => entry.kind === 'private-stage')) expect.needles.push(expect.paths.find(entry => entry.kind === 'private-stage').path);

  try { const cleanup = readJson(fileIn('cleanup.json')); expect.cleanupJsonClaims = (cleanup.containers ?? []).filter(entry => entry.removed === true).map(entry => entry.id); } catch { /* informational only; absence does not affect the verdict */ }
  expect.needles = [...new Set(expect.needles)];
  return { expect, missing };
}

const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error: /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'PROBE_FAILED' }; } };

/** Runs every required observation. A probe that throws is recorded as `error` and fails the verification. */
export async function verifyCleanup({ runDir, probes, now = () => new Date().toISOString() }) {
  const absoluteRunDir = resolve(runDir);
  const { expect, missing } = loadExpectations(absoluteRunDir);
  const checks = [];
  const record = (kind, id, observed, pass, detail) => checks.push({ kind, id, expected: 'absent', observed, pass, ...(detail ? { detail } : {}) });
  const present = async (kind, id, probe) => {
    const result = await attempt(probe);
    if (!result.ok) return record(kind, id, 'error', false, result.error);
    record(kind, id, result.value ? 'present' : 'absent', !result.value);
  };

  for (const container of expect.containers) await present(`container:${container.role}`, container.id, () => probes.containerExists(container.id));
  const discovered = await attempt(() => probes.listContainers());
  if (!discovered.ok) record('container-discovery', 'docker ps -a', 'error', false, discovered.error);
  else {
    const known = new Set(expect.containers.map(container => container.id));
    const survivors = discovered.value.filter(entry => known.has(entry.id) || expect.needles.some(needle => (entry.name ?? '').includes(needle)) || expect.runtimeIds.includes(entry.runtimeLabel));
    record('container-discovery', 'docker ps -a', survivors.length ? 'present' : 'absent', survivors.length === 0, survivors.length ? { survivors: survivors.map(entry => ({ id: entry.id, name: entry.name })) } : undefined);
  }
  for (const volume of expect.volumes) await present('volume', volume.name, () => probes.volumeExists(volume.name));
  for (const entry of expect.paths) await present(`path:${entry.kind}`, entry.path, () => probes.pathExists(entry.path));
  const registry = await attempt(() => probes.registryEntries());
  if (!registry.ok) record('receipt-registry', 'registry directory', 'error', false, registry.error);
  else {
    const markers = [...expect.containers.map(container => container.id), ...expect.paths.map(entry => entry.path), ...expect.runtimeIds];
    const survivors = registry.value.filter(entry => markers.some(marker => entry.text.includes(marker))).map(entry => entry.file);
    record('receipt-registry', 'registry directory', survivors.length ? 'present' : 'absent', survivors.length === 0, survivors.length ? { survivors } : undefined);
  }
  for (const port of expect.ports) await present('port', String(port), () => probes.portListening(port));
  for (const processEntry of expect.processes) await present(`process:${processEntry.role}`, `${processEntry.pid}`, () => probes.processAlive(processEntry.pid, processEntry.start));
  const scan = await attempt(() => probes.scanArgvContaining(expect.needles));
  if (!scan.ok) record('process-scan', 'argv scan', 'error', false, scan.error);
  else record('process-scan', 'argv scan', scan.value.length ? 'present' : 'absent', scan.value.length === 0, scan.value.length ? { pids: scan.value } : undefined);

  // Non-vacuity: every resolved identity must have produced its check.
  const minimum = expect.containers.length + expect.volumes.length + expect.paths.length + expect.ports.length + expect.processes.length + 3;
  const failReasons = [...missing];
  if (checks.length < minimum) failReasons.push('CHECKS_INCOMPLETE');
  for (const check of checks) if (!check.pass) failReasons.push(`${check.kind}:${check.observed}`);
  const contradicted = expect.cleanupJsonClaims.filter(id => checks.some(check => check.kind.startsWith('container:') && check.id === id && check.observed === 'present'));
  const self = readFileSync(fileURLToPath(import.meta.url));
  return {
    schema: RECEIPT_SCHEMA,
    generatedAtUtc: now(),
    runDir: basename(absoluteRunDir),
    verifier: { script: 'scripts/db-safety/cleanup-verify.mjs', sha256: createHash('sha256').update(self).digest('hex'), node: process.version, uid: process.getuid?.() ?? null },
    trustedCleanupJson: false,
    browserExpected: expect.browserExpected,
    expectations: { containers: expect.containers.length, volumes: expect.volumes.length, paths: expect.paths.length, ports: expect.ports, processes: expect.processes.length, runToken: expect.runToken },
    cleanupJsonComparison: { claimedRemoved: expect.cleanupJsonClaims.length, contradictedByObservation: contradicted },
    checks,
    missing,
    result: failReasons.length === 0 ? 'PASS' : 'FAIL',
    failReasons,
  };
}

/** Real observation probes. Anything that cannot be observed throws, which the verifier records as a failed check. */
export function realProbes({ uid = process.getuid?.() ?? 0 } = {}) {
  const docker = args => spawnSync('docker', args, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
  const absent = (result, pattern) => result.status !== 0 && pattern.test(result.stderr ?? '');
  return {
    containerExists: id => { const r = docker(['inspect', '--type', 'container', id]); if (r.status === 0) return true; if (absent(r, /No such (object|container)/i)) return false; throw Error('DOCKER_UNAVAILABLE'); },
    volumeExists: name => { const r = docker(['volume', 'inspect', name]); if (r.status === 0) return true; if (absent(r, /No such volume/i)) return false; throw Error('DOCKER_UNAVAILABLE'); },
    listContainers: () => {
      const r = docker(['ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Label "annotation.runtime"}}']);
      if (r.status !== 0) throw Error('DOCKER_UNAVAILABLE');
      return r.stdout.split('\n').filter(Boolean).map(line => { const [id, name, runtimeLabel] = line.split('\t'); return { id, name, runtimeLabel }; });
    },
    pathExists: path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw Error('PATH_CHECK_FAILED'); } },
    registryEntries: () => {
      const dir = `/tmp/annotation-platform-db-safety-${uid}`;
      if (!existsSync(dir)) return [];
      return readdirSync(dir).map(file => { try { return { file, text: readFileSync(join(dir, file), 'utf8') }; } catch { throw Error('REGISTRY_UNREADABLE'); } });
    },
    portListening: port => {
      const r = spawnSync('ss', ['-ltnH'], { encoding: 'utf8' });
      if (r.status !== 0) throw Error('SS_UNAVAILABLE');
      return r.stdout.split('\n').some(line => (line.trim().split(/\s+/)[3] ?? '').endsWith(`:${port}`));
    },
    processAlive: (pid, start) => { const identity = identityOf(pid); return Boolean(identity) && (start === null || identity.start === String(start)); },
    scanArgvContaining: needles => {
      const table = listProcesses();
      const excluded = selfAndAncestors(table);
      return table.filter(entry => !excluded.has(entry.pid) && !isMonitorProcess(entry.argv) && !entry.argv.some(element => element.endsWith('cleanup-verify.mjs')) && !['Z', 'X'].includes(entry.state)
        && needles.some(needle => entry.argv.some(element => element.includes(needle)))).map(entry => entry.pid);
    },
  };
}

if (process.argv[1] && basename(process.argv[1]) === 'cleanup-verify.mjs') {
  const [runDir, flag, outArg] = process.argv.slice(2);
  if (!runDir || (flag && (flag !== '--out' || !outArg))) { console.error('usage: cleanup-verify.mjs <runDir> [--out <file>]'); process.exit(2); }
  const out = outArg ? resolve(outArg) : join(resolve(runDir), RECEIPT_NAME);
  if (existsSync(out)) { console.error('RECEIPT_EXISTS: refusing to overwrite ' + out); process.exit(2); }
  let receipt;
  try { receipt = await verifyCleanup({ runDir, probes: realProbes() }); }
  catch (error) { receipt = { schema: RECEIPT_SCHEMA, generatedAtUtc: new Date().toISOString(), runDir: basename(resolve(runDir)), trustedCleanupJson: false, checks: [], missing: ['VERIFIER_FAILED:' + (/^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'UNEXPECTED')], result: 'FAIL', failReasons: ['VERIFIER_FAILED'] }; }
  writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o444, flag: 'wx' });
  console.log(JSON.stringify({ result: receipt.result, receipt: out, failReasons: receipt.failReasons }));
  process.exit(receipt.result === 'PASS' ? 0 : 1);
}
