import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RECEIPT_NAME, RECEIPT_SCHEMA, loadExpectations, verifyCleanup } from '../cleanup-verify.mjs';

// Fake probes only: no Docker, no real filesystem outside a temp dir, no ports or processes are inspected.
const VERIFIER = fileURLToPath(new URL('../cleanup-verify.mjs', import.meta.url));
const id = n => String(n).repeat(64).slice(0, 64);
const PG = id(1), REDIS = id(2), MINIO = id(3), BROWSER = id(4);
const STAGE = '/tmp/phase029-g1-abcd1234', ROOT = '/tmp/phase029-g1-runtime-ZZZZ99', PROFILE = ROOT + '/browser-profile';
const VOLS = [id(5), id(6), id(7)], ANON = id(8);
const RUNTIME = '50cc672f-321b-4a1c-96ba-1260b93491bb';

function runDir({ browser = false, withReceipt = true, claims = [PG, REDIS, MINIO], omit = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-verify-'));
  const put = (name, value) => { if (!omit.includes(name)) writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value)); };
  put('disposable-identities.json', [{ id: PG, role: 'postgres', port: 55460, name: 'phase029-g1-g3-deadbeef-postgres' }, { id: REDIS, role: 'redis', port: 55461, name: 'x' }, { id: MINIO, role: 'minio', port: 55462, name: 'y' }]);
  put('allocation-ownership.json', { privateStage: STAGE, ownerUid: 1004, runToken: 'deadbeef' });
  put('owned-volumes.json', VOLS.map((name, index) => ({ containerId: [PG, REDIS, MINIO][index], name })));
  put('cleanup.json', { containers: claims.map(claimed => ({ id: claimed, removed: true })), privateStageRemoved: true });
  if (browser) {
    const lines = ['G5_BROWSER_ALLOCATION ' + JSON.stringify({ runtime: RUNTIME, containerId: BROWSER, anonymousVolumes: [ANON], started: false })];
    if (withReceipt) lines.push('G4_RUNTIME_RECEIPT ' + JSON.stringify({ owner: { pid: 4100, start: '555', uid: 1004 }, processes: [{ pid: 4101, start: '556', role: 'web' }, { pid: 4102, start: '557', role: 'worker' }], browserOwnership: { id: BROWSER, profile: PROFILE, anonymousVolumes: [ANON] }, browserCleanup: { containerProcess: { pid: 4103, start: '558' }, attachProcess: { pid: 4104, start: '559', absent: true } } }));
    put('g5-browser-control.log', lines.join('\n') + '\n');
    put('g5-browser-control-postgres.log', 'ignored postgres log\n');
  }
  return dir;
}
const clean = () => ({
  containerExists: async () => false, volumeExists: async () => false, listContainers: async () => [], pathExists: async () => false,
  registryEntries: async () => [], portListening: async () => false, processAlive: async () => false, scanArgvContaining: async () => [],
});
const run = async (dir, overrides = {}) => verifyCleanup({ runDir: dir, probes: { ...clean(), ...overrides }, now: () => '2026-10-05T00:00:00.000Z' });
const failed = (receipt, kind, observed) => receipt.checks.some(check => check.kind.startsWith(kind) && check.observed === observed && check.pass === false);

test('positive: a fully cleaned compatibility-type run passes with a complete, non-vacuous receipt', async () => {
  const receipt = await run(runDir());
  assert.equal(receipt.result, 'PASS'); assert.deepEqual(receipt.failReasons, []); assert.deepEqual(receipt.missing, []);
  assert.equal(receipt.schema, RECEIPT_SCHEMA); assert.equal(receipt.trustedCleanupJson, false); assert.equal(receipt.browserExpected, false);
  const kinds = receipt.checks.map(check => check.kind);
  assert.equal(kinds.filter(kind => kind.startsWith('container:')).length, 3);
  for (const kind of ['container-discovery', 'path:private-stage', 'receipt-registry', 'process-scan']) assert.ok(kinds.includes(kind), kind);
  assert.equal(kinds.filter(kind => kind === 'volume').length, 3); assert.equal(kinds.filter(kind => kind === 'port').length, 3);
  assert.ok(receipt.checks.every(check => check.expected === 'absent' && check.observed === 'absent' && check.pass === true));
  assert.match(receipt.verifier.sha256, /^[0-9a-f]{64}$/);
});

test('positive: a browser run also verifies the browser container, anonymous volume, profile, private root and every recorded process', async () => {
  const receipt = await run(runDir({ browser: true }));
  assert.equal(receipt.result, 'PASS'); assert.equal(receipt.browserExpected, true);
  const ids = receipt.checks.map(check => `${check.kind}|${check.id}`);
  for (const wanted of [`container:browser|${BROWSER}`, `volume|${ANON}`, `path:browser-profile|${PROFILE}`, `path:runtime-private-root|${ROOT}`, 'process:web|4101', 'process:worker|4102', 'process:owner|4100', 'process:browser-container|4103', 'process:browser-attach|4104']) assert.ok(ids.includes(wanted), wanted);
});

test('negative: a deliberately surviving container fails, even though cleanup.json claims it was removed (cleanup.json is never trusted)', async () => {
  const receipt = await run(runDir(), { containerExists: async value => value === MINIO });
  assert.equal(receipt.result, 'FAIL'); assert.ok(failed(receipt, 'container:minio', 'present'));
  assert.deepEqual(receipt.cleanupJsonComparison.contradictedByObservation, [MINIO]);
  assert.ok(receipt.checks.filter(check => check.kind.startsWith('container:') && check.observed === 'absent').length === 2);
});

test('negative: a container not in the manifest is still found by independent discovery (run token in its name)', async () => {
  const receipt = await run(runDir(), { listContainers: async () => [{ id: id(9), name: 'phase029-g1-g3-deadbeef-extra', runtimeLabel: '' }, { id: id('a'), name: 'unrelated', runtimeLabel: '' }] });
  assert.equal(receipt.result, 'FAIL'); assert.deepEqual(receipt.checks.find(check => check.kind === 'container-discovery').detail.survivors.map(entry => entry.name), ['phase029-g1-g3-deadbeef-extra']);
});
test('negative: each other surviving resource kind fails independently', async () => {
  const dir = runDir({ browser: true });
  assert.ok(failed(await run(dir, { volumeExists: async name => name === VOLS[0] }), 'volume', 'present'));
  assert.ok(failed(await run(dir, { volumeExists: async name => name === ANON }), 'volume', 'present'));
  assert.ok(failed(await run(dir, { pathExists: async path => path === STAGE }), 'path:private-stage', 'present'));
  assert.ok(failed(await run(dir, { pathExists: async path => path === PROFILE }), 'path:browser-profile', 'present'));
  assert.ok(failed(await run(dir, { pathExists: async path => path === ROOT }), 'path:runtime-private-root', 'present'));
  assert.ok(failed(await run(dir, { portListening: async port => port === 55461 }), 'port', 'present'));
  assert.ok(failed(await run(dir, { processAlive: async pid => pid === 4101 }), 'process:web', 'present'));
  assert.ok(failed(await run(dir, { processAlive: async pid => pid === 4103 }), 'process:browser-container', 'present'));
  assert.ok(failed(await run(dir, { scanArgvContaining: async () => [777] }), 'process-scan', 'present'));
  const registry = await run(dir, { registryEntries: async () => [{ file: 'receipt-1.json', text: JSON.stringify({ postgres: { id: PG } }) }, { file: 'other.json', text: '{}' }] });
  assert.equal(registry.result, 'FAIL'); assert.deepEqual(registry.checks.find(check => check.kind === 'receipt-registry').detail.survivors, ['receipt-1.json']);
  assert.equal((await run(dir, { registryEntries: async () => [{ file: 'u.json', text: '{"cfg":"unrelated"}' }] })).result, 'PASS');
});

test('fail closed: a probe that cannot run is a failed check, never a pass', async () => {
  for (const [probe, kind] of [['containerExists', 'container:'], ['volumeExists', 'volume'], ['pathExists', 'path:'], ['portListening', 'port'], ['listContainers', 'container-discovery'], ['registryEntries', 'receipt-registry'], ['scanArgvContaining', 'process-scan']]) {
    const receipt = await run(runDir(), { [probe]: async () => { throw Error('DOCKER_UNAVAILABLE'); } });
    assert.equal(receipt.result, 'FAIL', probe); assert.ok(failed(receipt, kind, 'error'), probe);
  }
});

test('fail closed: missing, malformed or incomplete manifests fail with a named reason', async () => {
  for (const [options, reason] of [[{ omit: ['disposable-identities.json'] }, 'MANIFEST_UNREADABLE:disposable-identities.json'], [{ omit: ['allocation-ownership.json'] }, 'MANIFEST_UNREADABLE:allocation-ownership.json'], [{ omit: ['owned-volumes.json'] }, 'MANIFEST_UNREADABLE:owned-volumes.json']]) {
    const receipt = await run(runDir(options));
    assert.equal(receipt.result, 'FAIL'); assert.ok(receipt.missing.includes(reason), reason);
  }
  const dir = runDir(); writeFileSync(join(dir, 'disposable-identities.json'), JSON.stringify([{ id: PG, role: 'postgres', port: 55460 }]));
  assert.ok((await run(dir)).missing.some(reason => reason.startsWith('IDENTITIES_INCOMPLETE')));
  const unsafe = runDir(); writeFileSync(join(unsafe, 'allocation-ownership.json'), JSON.stringify({ privateStage: '/home/user/important', runToken: 'deadbeef' }));
  assert.ok((await run(unsafe)).missing.includes('PRIVATE_STAGE_MISSING_OR_UNSAFE'));
});

test('fail closed: a browser allocation whose ownership receipt (profile path) is unavailable cannot be verified', async () => {
  const receipt = await run(runDir({ browser: true, withReceipt: false }));
  assert.equal(receipt.result, 'FAIL'); assert.ok(receipt.missing.some(reason => reason.startsWith('BROWSER_PROFILE_UNRESOLVED')));
});

test('the verdict ignores a cleanup.json that claims everything was removed, and also a missing cleanup.json', async () => {
  assert.equal((await run(runDir({ omit: ['cleanup.json'] }))).result, 'PASS');
  const lying = await run(runDir({ claims: [PG, REDIS, MINIO] }), { containerExists: async () => true });
  assert.equal(lying.result, 'FAIL'); assert.equal(lying.cleanupJsonComparison.contradictedByObservation.length, 3);
});

test('the receipt is deterministic in shape and carries no secrets', async () => {
  const dir = runDir({ browser: true });
  const receipt = await run(dir);
  const text = JSON.stringify(receipt);
  assert.equal(/password|secret|token":|postgresql:\/\//i.test(text.replace('runToken', '')), false);
  assert.equal(JSON.stringify(await run(dir)), text); // same observations, same receipt
});

test('loadExpectations resolves identities from the manifests only', () => {
  const { expect, missing } = loadExpectations(runDir({ browser: true }));
  assert.deepEqual(missing, []);
  assert.deepEqual(expect.containers.map(container => container.role).sort(), ['browser', 'minio', 'postgres', 'redis']);
  assert.deepEqual(expect.ports, [55460, 55461, 55462]); assert.equal(expect.runToken, 'deadbeef');
});

test('CLI: writes a read-only receipt, exits 0/1 on PASS/FAIL, refuses to overwrite, and fails closed on a bad run directory', () => {
  const dir = runDir({ omit: ['disposable-identities.json'] });
  const first = spawnSync(process.execPath, [VERIFIER, dir], { encoding: 'utf8' });
  assert.equal(first.status, 1); assert.equal(JSON.parse(first.stdout).result, 'FAIL');
  const receiptPath = join(dir, RECEIPT_NAME); assert.ok(existsSync(receiptPath));
  assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).result, 'FAIL');
  const again = spawnSync(process.execPath, [VERIFIER, dir], { encoding: 'utf8' });
  assert.equal(again.status, 2); assert.match(again.stderr, /RECEIPT_EXISTS/);
  const missingDir = spawnSync(process.execPath, [VERIFIER, join(tmpdir(), 'no-such-run-dir-xyz'), '--out', join(tmpdir(), 'cv-out-' + process.pid + '.json')], { encoding: 'utf8' });
  assert.equal(missingDir.status, 1); assert.equal(JSON.parse(missingDir.stdout).result, 'FAIL');
  rmSync(join(tmpdir(), 'cv-out-' + process.pid + '.json'), { force: true });
  assert.equal(spawnSync(process.execPath, [VERIFIER], { encoding: 'utf8' }).status, 2);
});
