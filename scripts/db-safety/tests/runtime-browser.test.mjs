import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { plannedBrowserHostShapes, matchesPlannedBrowserHostShape, validateBrowserPlan } from '../runtime-browser.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function fixture(version = '2') {
  const runtime = { id: '11111111-1111-4111-8111-111111111111', expiresAt: new Date(Date.now() + 60000).toISOString(), config: '/tmp/receipt-owned-runtime/config.json' };
  const container = {
    Id: '1'.repeat(64), Image: 'sha256:' + '2'.repeat(64), Name: '/phase029-g1-browser-' + runtime.id,
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Privileged: false, PidMode: '', IpcMode: 'private', PortBindings: {}, RestartPolicy: { Name: 'no' },
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=256m', '/dev/shm': 'rw,noexec,nosuid,size=256m' },
      PidsLimit: 128, Memory: 1024 * 1024 * 1024, NanoCpus: 2000000000, OomKillDisable: false,
      UnrelatedPinnedField: { exact: 'original' },
    },
    Config: {
      Labels: { 'annotation.safety': 'g1-disposable', 'annotation.role': 'browser', 'annotation.runtime': runtime.id },
      Tty: false, OpenStdin: true, Entrypoint: ['/bin/sh'], Cmd: ['-c', 'receipt-owned-command'],
      User: `${process.getuid()}:${process.getgid()}`, Env: ['HOME=/profile'],
    },
    Mounts: [],
  };
  const plan = {
    runtime: runtime.id, id: container.Id, image: container.Image, name: container.Name.slice(1),
    profile: '/tmp/receipt-owned-runtime/browser-profile', executable: '/opt/google/chrome/chrome', executableHash: '3'.repeat(64),
    command: container.Config.Cmd[1], nativeEnvironment: container.Config.Env, mounts: [], anonymousVolumes: [],
    ...plannedBrowserHostShapes(container.HostConfig, version), configHash: digest(container.Config),
    configFieldHashes: Object.fromEntries(Object.keys(container.Config).sort().map(key => [key, digest(container.Config[key])])),
  };
  return { runtime, plan, container };
}

test('cgroup-v2 receipt precomputes exactly two complete HostConfig shapes without mutating the allocation', () => {
  const { plan, container } = fixture();
  assert.equal(container.HostConfig.OomKillDisable, false);
  assert.equal(plan.hostConfigHash, digest(container.HostConfig));
  assert.equal(plan.hostConfigV2DefaultHash, digest({ ...container.HostConfig, OomKillDisable: null }));
  assert.notEqual(plan.hostConfigHash, plan.hostConfigV2DefaultHash);
});

test('verified cgroup-v2 false and null representations both retain every complete browser-plan gate', () => {
  const { runtime, plan, container } = fixture();
  assert.equal(validateBrowserPlan(runtime, plan, container), true);
  assert.equal(validateBrowserPlan(runtime, plan, { ...container, HostConfig: { ...container.HostConfig, OomKillDisable: null } }), true);
});

test('cgroup-v1 accepts its original shape and cannot use the v2 null representation', () => {
  const { runtime, plan, container } = fixture('1');
  assert.equal(plan.hostConfigV2DefaultHash, null);
  assert.equal(validateBrowserPlan(runtime, plan, container), true);
  assert.throws(() => validateBrowserPlan(runtime, plan, { ...container, HostConfig: { ...container.HostConfig, OomKillDisable: null } }), /BROWSER_CONTAINER_CONFIGURATION_CHANGED/);
});

test('allocation rejects absent, malformed, or unsupported cgroup attestation', () => {
  const host = fixture().container.HostConfig;
  for (const value of [undefined, null, 2, '', '3', 'v2']) assert.throws(() => plannedBrowserHostShapes(host, value), /BROWSER_CGROUP_VERSION_REQUIRED/);
});

test('allocation requires an explicit original OOM-default false value', () => {
  const host = fixture().container.HostConfig;
  for (const value of [true, null, 'false', 0, undefined]) assert.throws(() => plannedBrowserHostShapes({ ...host, OomKillDisable: value }, '2'), /BROWSER_OOM_DEFAULT_REQUIRED/);
  const { OomKillDisable, ...omitted } = host;
  assert.throws(() => plannedBrowserHostShapes(omitted, '2'), /BROWSER_OOM_DEFAULT_REQUIRED/);
});

test('missing or mismatched v2 receipt attestation cannot authorize a null shape', () => {
  const { plan, container } = fixture();
  const nullHost = { ...container.HostConfig, OomKillDisable: null };
  for (const daemonCgroupVersion of [undefined, null, '1', '3', 2]) assert.equal(matchesPlannedBrowserHostShape({ ...plan, daemonCgroupVersion }, nullHost), false);
  for (const hostConfigV2DefaultHash of [undefined, null, '', '0'.repeat(64)]) assert.equal(matchesPlannedBrowserHostShape({ ...plan, hostConfigV2DefaultHash }, nullHost), false);
});

test('true, omitted, and malformed OOM values are rejected even with the matching full hash', () => {
  const { plan, container } = fixture();
  for (const value of [true, 'false', 0, undefined]) {
    const changed = { ...container.HostConfig, OomKillDisable: value };
    assert.equal(matchesPlannedBrowserHostShape({ ...plan, hostConfigHash: digest(changed), hostConfigV2DefaultHash: digest(changed) }, changed), false);
  }
  const { OomKillDisable, ...omitted } = container.HostConfig;
  assert.equal(matchesPlannedBrowserHostShape({ ...plan, hostConfigHash: digest(omitted), hostConfigV2DefaultHash: digest(omitted) }, omitted), false);
});

test('a null OOM representation cannot conceal any other HostConfig field transition', () => {
  const { runtime, plan, container } = fixture();
  const original = { ...container.HostConfig, OomKillDisable: null };
  for (const changed of [
    { ...original, Memory: original.Memory + 1 },
    { ...original, NetworkMode: 'bridge' },
    { ...original, UnrelatedPinnedField: { exact: 'changed' } },
    { ...original, AdditionalField: true },
    Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'UnrelatedPinnedField')),
  ]) {
    assert.equal(matchesPlannedBrowserHostShape(plan, changed), false);
    assert.throws(() => validateBrowserPlan(runtime, plan, { ...container, HostConfig: changed }));
  }
});

test('the alternate HostConfig shape does not permit Config or mount changes', () => {
  const { runtime, plan, container } = fixture();
  const started = { ...container, HostConfig: { ...container.HostConfig, OomKillDisable: null } };
  assert.throws(() => validateBrowserPlan(runtime, plan, { ...started, Config: { ...started.Config, AdditionalField: 'changed' } }), /BROWSER_CONTAINER_CONFIGURATION_CHANGED/);
  assert.throws(() => validateBrowserPlan(runtime, plan, { ...started, Mounts: [{ Type: 'bind', Source: '/tmp/unowned', Destination: '/unowned', RW: true }] }), /BROWSER_MOUNT_SCOPE_MISMATCH/);
});

test('object-key ordering is deterministic and failure diagnostics retain precise field identities', () => {
  const { runtime, plan, container } = fixture();
  const reordered = Object.fromEntries(Object.entries(container.HostConfig).toReversed());
  assert.equal(matchesPlannedBrowserHostShape(plan, reordered), true);
  assert.throws(() => validateBrowserPlan(runtime, plan, { ...container, HostConfig: { ...container.HostConfig, OomKillDisable: null, AdditionalField: true } }), error => {
    assert.equal(error.message, 'BROWSER_CONTAINER_CONFIGURATION_CHANGED');
    assert.deepEqual(error.browserShapeDelta.hostConfig.map(entry => entry.field), ['AdditionalField', 'OomKillDisable']);
    assert.deepEqual(error.browserShapeDelta.config, []);
    return true;
  });
});
