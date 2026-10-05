// Verification only: native browser has no network namespace routes. Every page
// request is fulfilled by the existing G1-fenced Node runtime over a private CDP
// pipe; no browser/automation dependency or ambient debugging endpoint is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, realpathSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { verify, cleanEnv, sha, must, containerIdentity } from './guard.mjs';

const require = createRequire(import.meta.url);
const authority = require('./runtime-authority.cjs');
const executable = '/opt/google/chrome/chrome';
const readonlyDirectories = ['/opt/google/chrome', '/usr/lib/x86_64-linux-gnu', '/etc/fonts', '/usr/share/fonts', '/usr/share/fontconfig'];
const forbiddenNativeEnvironment = /^(?:DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|REDIS_|MINIO_|PGPASSWORD|PGHOST|PGPORT|PGUSER|PGDATABASE|SOURCE_CONNECTION_)/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function docker(args, options = {}) {
  const command = spawnSync('docker', args, { env: cleanEnv(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options });
  must(command.status === 0, 'BROWSER_DOCKER_OPERATION_FAILED');
  return command.stdout;
}
const inspect = id => JSON.parse(docker(['inspect', id]))[0];
const same = isDeepStrictEqual;
const canonicalShape = value => Array.isArray(value) ? value.map(canonicalShape) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalShape(value[key])])) : value;
const shapeHash = value => sha(JSON.stringify(canonicalShape(value)));
const fieldHashes = value => Object.fromEntries(Object.keys(value).sort().map(key => [key, shapeHash(value[key])]));
function changedFieldHashes(expected, actual) {
  const after = fieldHashes(actual);
  return [...new Set([...Object.keys(expected), ...Object.keys(after)])].sort().filter(field => expected[field] !== after[field]).map(field => ({ field, before: expected[field] ?? null, after: after[field] ?? null }));
}
const normalizedMounts = mounts => mounts.map(({ Source, Destination, RW, Type }) => ({ Source, Destination, RW, Type })).sort((a, b) => a.Destination.localeCompare(b.Destination));

/** Pin both complete representations before start; never learn a running shape. */
export function plannedBrowserHostShapes(hostConfig, daemonCgroupVersion) {
  must(['1', '2'].includes(daemonCgroupVersion), 'BROWSER_CGROUP_VERSION_REQUIRED');
  must(Object.hasOwn(hostConfig, 'OomKillDisable') && hostConfig.OomKillDisable === false, 'BROWSER_OOM_DEFAULT_REQUIRED');
  return {
    daemonCgroupVersion,
    hostConfigHash: shapeHash(hostConfig),
    // Docker discards --oom-kill-disable on cgroup v2. Only its observed
    // false -> null representation is authorized; every other field is pinned.
    // https://docs.docker.com/engine/containers/runmetrics/
    hostConfigV2DefaultHash: daemonCgroupVersion === '2' ? shapeHash({ ...hostConfig, OomKillDisable: null }) : null,
    hostConfigFieldHashes: fieldHashes(hostConfig),
  };
}

export function matchesPlannedBrowserHostShape(plan, hostConfig) {
  if (!['1', '2'].includes(plan.daemonCgroupVersion)) return false;
  if (!Object.hasOwn(hostConfig, 'OomKillDisable') || ![false, null].includes(hostConfig.OomKillDisable)) return false;
  const actual = shapeHash(hostConfig);
  return actual === plan.hostConfigHash || (
    plan.daemonCgroupVersion === '2' && hostConfig.OomKillDisable === null &&
    /^[a-f0-9]{64}$/.test(plan.hostConfigV2DefaultHash || '') && actual === plan.hostConfigV2DefaultHash
  );
}

/** Attributable record for a request the broker refuses. Never infers a URL: an unparsable/missing URL stays null so it cannot satisfy any probe. */
export function describeDeniedRequest(event) {
  let url = null, origin = null;
  try { const parsed = new URL(event?.request?.url); url = parsed.href; origin = parsed.origin; } catch { /* leave null */ }
  return { allowed: false, error: 'BROWSER_RESOURCE_TARGET_DENIED', url, origin, resourceType: event?.resourceType ?? null, frameId: event?.frameId ?? null };
}

/** Records the denial first, then fails the paused request. The record is the only proof of denial. */
export async function denyPausedRequest(requests, event, send, sessionId) {
  requests.push(describeDeniedRequest(event));
  await send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, sessionId);
}

/**
 * Evaluates one ambient probe against the requests recorded since it began.
 * Only an intercepted request for exactly this probe URL with an explicit
 * `allowed === false` satisfies it. Navigation errors, error pages, the
 * absence of a request and Network.* events are never proof of denial.
 */
export function evaluateAmbientProbe(requests, start, probeUrl) {
  const href = new URL(probeUrl).href;
  const since = requests.slice(start);
  const own = since.filter(request => request.url === href);
  const foreign = since.filter(request => request.url && request.url !== href);
  const unattributed = since.filter(request => !request.url);
  const allowed = since.filter(request => request.allowed !== false);
  let verdict = 'DENIED_OBSERVED';
  if (allowed.length) verdict = 'ALLOWED';
  else if (unattributed.length) verdict = 'UNATTRIBUTED';
  else if (!own.some(request => request.allowed === false)) verdict = 'NOT_OBSERVED';
  return { verdict, pass: verdict === 'DENIED_OBSERVED', own, foreign, unattributed, allowed };
}

export function allowedBrowserUrl(runtime, environment, value) {
  const url = new URL(value);
  const allowed = [`http://127.0.0.1:${runtime.roles.web.port}`, new URL(environment.MINIO_ENDPOINT).origin];
  must(!url.username && !url.password && url.protocol === 'http:' && allowed.includes(url.origin), 'BROWSER_RESOURCE_TARGET_DENIED');
  return url;
}

/** All caller arguments must equal the immutable registered receipt and config. */
export function validateBrowserContext(current, suppliedRuntime, suppliedEnvironment, privateEnvironment) {
  must(current && suppliedRuntime && suppliedEnvironment && privateEnvironment, 'BROWSER_CANONICAL_CONTEXT_REQUIRED');
  must(Date.now() < Date.parse(current.expiresAt) && Date.now() < Date.parse(suppliedRuntime.expiresAt), 'BROWSER_RUNTIME_RECEIPT_STALE');
  must(same(current, suppliedRuntime), 'BROWSER_CANONICAL_RUNTIME_MISMATCH');
  must(same(privateEnvironment, suppliedEnvironment), 'BROWSER_CANONICAL_ENVIRONMENT_MISMATCH');
  return { runtime: current, environment: privateEnvironment };
}

function proveRemovedAllocation(plan) {
  const remaining = spawnSync('docker', ['inspect', plan.id], { env: cleanEnv(), encoding: 'utf8' });
  must(remaining.status === 1 && /No such (?:object|container)/i.test(remaining.stderr), 'BROWSER_CONTAINER_REMAINS');
  for (const volume of plan.anonymousVolumes) {
    const removed = spawnSync('docker', ['volume', 'inspect', volume], { env: cleanEnv(), encoding: 'utf8' });
    must(removed.status === 1 && /no such volume/i.test(removed.stderr), 'BROWSER_ANONYMOUS_VOLUME_REMAINS');
  }
  must(realpathSync(plan.profile) === plan.profile && statSync(plan.profile).uid === process.getuid(), 'BROWSER_PROFILE_OWNERSHIP_MISMATCH');
  rmSync(plan.profile, { recursive: true, force: true }); must(!existsSync(plan.profile), 'BROWSER_PROFILE_REMAINS');
  return { containerId: plan.id, image: plan.image, anonymousVolumes: plan.anonymousVolumes, containerAbsent: true, profileAbsent: true, volumesAbsent: true };
}

/** Pure identity checks are also used by the negative rehearsal; no SQL or socket. */
export function validateBrowserPlan(runtime, plan, container) {
  must(runtime && plan && container, 'BROWSER_RUNTIME_IDENTITY_REQUIRED');
  must(Date.now() < Date.parse(runtime.expiresAt), 'BROWSER_RUNTIME_RECEIPT_STALE');
  must(plan.runtime === runtime.id && /^[a-f0-9]{64}$/.test(plan.id) && plan.name === `phase029-g1-browser-${runtime.id}`, 'BROWSER_RECEIPT_MISMATCH');
  must(plan.profile === join(dirname(runtime.config), 'browser-profile') && plan.executable === executable && /^[a-f0-9]{64}$/.test(plan.executableHash), 'BROWSER_PROFILE_OR_BINARY_MISMATCH');
  must(container.Id === plan.id && container.Image === plan.image && container.Name === '/' + plan.name, 'BROWSER_CONTAINER_IDENTITY_MISMATCH');
  must(container.Config.Labels?.['annotation.safety'] === 'g1-disposable' && container.Config.Labels?.['annotation.role'] === 'browser' && container.Config.Labels?.['annotation.runtime'] === runtime.id, 'BROWSER_CONTAINER_RECEIPT_MISMATCH');
  must(container.HostConfig.NetworkMode === 'none' && container.HostConfig.ReadonlyRootfs && same(container.HostConfig.CapDrop, ['ALL']) && container.HostConfig.SecurityOpt?.includes('no-new-privileges'), 'BROWSER_CONTAINER_ISOLATION_MISMATCH');
  must(!container.HostConfig.Privileged && !container.HostConfig.PidMode && !container.HostConfig.IpcMode?.startsWith('host') && Object.keys(container.HostConfig.PortBindings || {}).length === 0 && container.HostConfig.RestartPolicy.Name === 'no', 'BROWSER_CONTAINER_ISOLATION_MISMATCH');
  must(same(container.HostConfig.Tmpfs, { '/tmp': 'rw,noexec,nosuid,size=256m', '/dev/shm': 'rw,noexec,nosuid,size=256m' }) && container.HostConfig.PidsLimit === 128 && container.HostConfig.Memory === 1024 * 1024 * 1024 && container.HostConfig.NanoCpus === 2000000000, 'BROWSER_CONTAINER_LIMITS_MISMATCH');
  must(container.Config.Tty === false && container.Config.OpenStdin && same(container.Config.Entrypoint, ['/bin/sh']) && same(container.Config.Cmd, ['-c', plan.command]), 'BROWSER_PIPE_CONFIGURATION_MISMATCH');
  must(container.Config.User === `${process.getuid()}:${process.getgid()}` && !container.Config.Env.some(value => forbiddenNativeEnvironment.test(value.split('=')[0])) && same(container.Config.Env, plan.nativeEnvironment), 'BROWSER_NATIVE_CREDENTIALS_FORBIDDEN');
  must(same(normalizedMounts(container.Mounts.filter(mount => mount.Type === 'bind')), normalizedMounts(plan.mounts)), 'BROWSER_MOUNT_SCOPE_MISMATCH');
  // The reused PostgreSQL image declares this anonymous volume itself. It is a
  // fresh browser-container-owned allocation, contains no database, and is removed
  // only with that exact container's `rm --volumes` cleanup.
  must(container.Mounts.filter(mount => mount.Type === 'volume').every(mount => mount.Destination === '/var/lib/postgresql/data' && /^[a-f0-9]{64}$/.test(mount.Name)), 'BROWSER_UNAPPROVED_VOLUME');
  must(container.Mounts.every(mount => ['bind', 'volume'].includes(mount.Type)), 'BROWSER_MOUNT_SCOPE_MISMATCH');
  must(same(container.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name), plan.anonymousVolumes), 'BROWSER_VOLUME_IDENTITY_MISMATCH');
  if (!matchesPlannedBrowserHostShape(plan, container.HostConfig) || shapeHash(container.Config) !== plan.configHash) {
    const error = Error('BROWSER_CONTAINER_CONFIGURATION_CHANGED');
    // Only field identities and digests are disclosed. Values, environment,
    // command-line content and credentials never enter failure diagnostics.
    error.browserShapeDelta = {
      hostConfig: plan.hostConfigFieldHashes ? changedFieldHashes(plan.hostConfigFieldHashes, container.HostConfig) : null,
      config: plan.configFieldHashes ? changedFieldHashes(plan.configFieldHashes, container.Config) : null,
    };
    throw error;
  }
  return true;
}

export async function prepareBrowser({ runtime }) {
  const checked = await verify(runtime.baseReceipt, 'test');
  must(checked.r.command === 'g5:runtime:e2e' && runtime.checkpoint === 'G5', 'BROWSER_COMMAND_SCOPE_REQUIRED');
  must(authority.same(authority.identity(process.pid), runtime.owner), 'BROWSER_SUPERVISOR_IDENTITY_MISMATCH');
  const pg = containerIdentity(checked.r.postgres, 'postgres');
  must(/^sha256:[a-f0-9]{64}$/.test(pg.Image), 'BROWSER_EXISTING_IMAGE_REQUIRED');
  const daemonCgroupVersion = JSON.parse(docker(['info', '--format', '{{json .CgroupVersion}}']).trim());
  must(['1', '2'].includes(daemonCgroupVersion), 'BROWSER_CGROUP_VERSION_REQUIRED');
  const profile = join(dirname(runtime.config), 'browser-profile');
  mkdirSync(profile, { mode: 0o700 });
  const mounts = readonlyDirectories.map(directory => ({ Source: realpathSync(directory), Destination: directory, RW: false, Type: 'bind' }));
  mounts.push({ Source: realpathSync('/usr/lib/x86_64-linux-gnu'), Destination: '/lib/x86_64-linux-gnu', RW: false, Type: 'bind' });
  mounts.push({ Source: realpathSync('/lib64/ld-linux-x86-64.so.2'), Destination: '/lib64/ld-linux-x86-64.so.2', RW: false, Type: 'bind' });
  mounts.push({ Source: realpathSync(profile), Destination: '/profile', RW: true, Type: 'bind' });
  const chromeArguments = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--disable-quic', '--no-proxy-server', '--password-store=basic', '--user-data-dir=/profile', '--remote-debugging-pipe', 'about:blank'];
  // --no-sandbox is scoped to a UID-bound, capless, read-only Docker container
  // with NetworkMode=none. It is never used for a host browser or host sandbox.
  const command = `exec 3<&0 4>&1 1>/dev/null; exec ${executable} ${chromeArguments.join(' ')}`;
  const name = `phase029-g1-browser-${runtime.id}`;
  const args = ['create', '-i', '--name', name, '--label', 'annotation.safety=g1-disposable', '--label', 'annotation.role=browser', '--label', `annotation.runtime=${runtime.id}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '1g', '--cpus', '2', '--oom-kill-disable=false', '--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--tmpfs', '/dev/shm:rw,noexec,nosuid,size=256m', '--env', 'HOME=/profile', '--env', 'XDG_CONFIG_HOME=/profile/config', '--env', 'XDG_CACHE_HOME=/profile/cache', '--env', 'LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/opt/google/chrome', '--entrypoint', '/bin/sh'];
  for (const mount of mounts) args.push('--mount', `type=bind,source=${mount.Source},destination=${mount.Destination}${mount.RW ? '' : ',readonly'}`);
  args.push(pg.Image, '-c', command);
  let id, plan;
  try {
    id = docker(args).trim();
    const allocated = inspect(id);
    plan = { runtime: runtime.id, id, name, image: pg.Image, executable, executableHash: sha(readFileSync(executable)), profile, mounts, command, nativeEnvironment: allocated.Config.Env, anonymousVolumes: allocated.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name), ...plannedBrowserHostShapes(allocated.HostConfig, daemonCgroupVersion), configHash: shapeHash(allocated.Config), configFieldHashes: fieldHashes(allocated.Config), supervisor: runtime.owner, program: { transport: 'cdp-pipe', network: 'none', nativeSandbox: 'docker-capdrop-readonly-network-none' } };
    console.log('G5_BROWSER_ALLOCATION', JSON.stringify({ runtime: runtime.id, containerId: id, image: plan.image, anonymousVolumes: plan.anonymousVolumes, daemonCgroupVersion, limits: { tmpfs: allocated.HostConfig.Tmpfs, pids: allocated.HostConfig.PidsLimit, memory: allocated.HostConfig.Memory, nanoCpus: allocated.HostConfig.NanoCpus }, hostConfigHash: plan.hostConfigHash, hostConfigV2DefaultHash: plan.hostConfigV2DefaultHash, configHash: plan.configHash, started: allocated.State.Running }));
    validateBrowserPlan(runtime, plan, allocated);
    return plan;
  } catch (error) {
    if (id) {
      const owned = inspect(id);
      must(owned.Id === id && owned.Image === pg.Image && owned.Name === '/' + name && owned.Config.Labels?.['annotation.runtime'] === runtime.id && owned.Config.Labels?.['annotation.role'] === 'browser' && !owned.State.Running && owned.State.Pid === 0, 'BROWSER_CLEANUP_IDENTITY_MISMATCH');
      if (!plan) plan = { id, image: pg.Image, profile, anonymousVolumes: owned.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name) };
      docker(['rm', '--volumes', id]);
      error.browserCleanup = { ...proveRemovedAllocation(plan), neverStarted: true };
      console.log('G5_BROWSER_ALLOCATION_ABORT_CLEANUP', JSON.stringify(error.browserCleanup));
    } else rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

/** Allocation failure cleanup; it never stops an unknown or running process. */
export function cleanupPreparedBrowser({ runtime }) {
  const plan = runtime.browser;
  must(authority.same(authority.identity(process.pid), runtime.owner), 'BROWSER_SUPERVISOR_IDENTITY_MISMATCH');
  const allocated = inspect(plan.id); validateBrowserPlan(runtime, plan, allocated);
  must(!allocated.State.Running && allocated.State.Pid === 0, 'BROWSER_PREPARED_CONTAINER_NOT_STOPPED');
  docker(['rm', '--volumes', plan.id]);
  return { ...proveRemovedAllocation(plan), neverStarted: true };
}

export async function connectBrowser({ runtime, environment }) {
  const current = authority.receipt();
  const privateEnvironment = authority.environment(current);
  ({ runtime, environment } = validateBrowserContext(current, runtime, environment, privateEnvironment));
  const checked = await verify(runtime.baseReceipt, 'test');
  must(checked.r.command === 'g5:runtime:e2e', 'BROWSER_COMMAND_SCOPE_REQUIRED');
  const plan = runtime.browser;
  validateBrowserPlan(runtime, plan, inspect(plan.id));
  must(realpathSync(plan.profile) === plan.profile && statSync(plan.profile).isDirectory() && (statSync(plan.profile).mode & 0o077) === 0 && statSync(plan.profile).uid === process.getuid(), 'BROWSER_PRIVATE_PROFILE_REQUIRED');
  must(sha(readFileSync(plan.executable)) === plan.executableHash, 'BROWSER_BINARY_CHANGED');
  must(!inspect(plan.id).State.Running, 'BROWSER_ALREADY_RUNNING');
  const child = spawn('docker', ['start', '--attach', '--interactive', plan.id], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const attachIdentity = authority.identity(child.pid);
  let diagnostic = '', buffer = Buffer.alloc(0), sequence = 0, sessionId, closed = false, containerProcess;
  const pending = new Map(), listeners = new Map(), requests = [], network = [];
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.once('exit', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('BROWSER_NATIVE_EXITED')); } pending.clear(); });
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-16000); });
  function assertContainer() {
    const actual = inspect(plan.id); validateBrowserPlan(runtime, plan, actual);
    if (actual.State.Running) {
      const live = authority.identity(actual.State.Pid);
      const cgroup = readFileSync(`/proc/${live.pid}/cgroup`, 'utf8');
      must(cgroup.includes(plan.id), 'BROWSER_PROCESS_CGROUP_MISMATCH');
      if (containerProcess) must(authority.same(live, containerProcess), 'BROWSER_CONTAINER_PROCESS_CHANGED');
      else containerProcess = { ...live, containerId: plan.id, cgroupHash: sha(cgroup) };
    }
    return actual;
  }
  function send(method, params = {}, session = sessionId) {
    must(!closed, 'BROWSER_PIPE_CLOSED'); assertContainer();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('BROWSER_CDP_TIMEOUT')); }, 60000); timer.unref();
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + '\0');
    });
  }
  const brokerErrors = [];
  async function broker(message) {
    const event = message.params;
    let target;
    try { target = allowedBrowserUrl(runtime, environment, event.request.url); }
    catch {
      await denyPausedRequest(requests, event, send, message.sessionId);
      return;
    }
    try {
      assertContainer();
      const pinned = await verify(runtime.baseReceipt, 'test');
      must(pinned.target.url.toString() === environment.DATABASE_URL, 'BROWSER_DATASOURCE_MISMATCH');
      Object.assign(process.env, environment); authority.ports();
      const headers = Object.fromEntries(Object.entries(event.request.headers).filter(([key]) => !['host', 'connection', 'content-length', 'accept-encoding', 'proxy-authorization'].includes(key.toLowerCase())));
      headers['accept-encoding'] = 'identity';
      const response = await fetch(target, { method: event.request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(60000), ...(['GET', 'HEAD'].includes(event.request.method) ? {} : { body: event.request.postData || '' }) });
      if (response.headers.has('location')) allowedBrowserUrl(runtime, environment, new URL(response.headers.get('location'), target).href);
      const body = Buffer.from(await response.arrayBuffer()); must(body.length <= 32 * 1024 * 1024, 'BROWSER_RESOURCE_TOO_LARGE');
      const responseHeaders = [...response.headers].filter(([key]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key.toLowerCase())).map(([name, value]) => ({ name, value }));
      for (const value of response.headers.getSetCookie()) responseHeaders.push({ name: 'Set-Cookie', value });
      responseHeaders.push({ name: 'Content-Length', value: String(body.length) });
      await send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: response.status, responseHeaders, body: body.toString('base64') }, message.sessionId);
      requests.push({ allowed: true, origin: target.origin, path: target.pathname, method: event.request.method, status: response.status });
    } catch (error) {
      brokerErrors.push({ error: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'BROWSER_RESOURCE_BROKER_FAILED' });
      await send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }, message.sessionId).catch(() => {});
    }
  }
  child.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    for (let end; (end = buffer.indexOf(0)) >= 0;) {
      const raw = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 1);
      if (!raw) continue;
      let message;
      try { message = JSON.parse(raw); } catch { brokerErrors.push({ error: 'BROWSER_PIPE_PROTOCOL_INVALID' }); continue; }
      if (message.id) { const entry = pending.get(message.id); if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(Error('BROWSER_CDP_COMMAND_FAILED')) : entry.resolve(message.result); } }
      else if (message.method === 'Fetch.requestPaused') void broker(message);
      else {
        // Evidence only: never consulted by any pass/fail decision.
        if ((message.method === 'Network.requestWillBeSent' || message.method === 'Network.loadingFailed') && network.length < 500) {
          const p = message.params || {};
          network.push({ method: message.method, url: p.request?.url ?? null, requestId: p.requestId ?? null, frameId: p.frameId ?? null, resourceType: p.type ?? null, errorText: p.errorText ?? null, blockedReason: p.blockedReason ?? null });
        }
        for (const callback of listeners.get(message.method) || []) callback(message.params);
      }
    }
  });
  async function close() {
    if (closed) return null;
    assertContainer();
    if (inspect(plan.id).State.Running && child.exitCode === null && child.signalCode === null) await Promise.race([send('Browser.close', {}, null).catch(() => {}), delay(5000)]);
    for (let n = 0; n < 100 && inspect(plan.id).State.Running; n++) await delay(50);
    if (inspect(plan.id).State.Running) docker(['stop', '--time', '10', plan.id]);
    await Promise.race([exited, delay(10000).then(() => { throw Error('BROWSER_ATTACH_DID_NOT_EXIT'); })]);
    must(!existsSync(`/proc/${attachIdentity.pid}`), 'BROWSER_ATTACH_PROCESS_REMAINS');
    assertContainer(); docker(['rm', '--volumes', plan.id]);
    const remaining = spawnSync('docker', ['inspect', plan.id], { env: cleanEnv(), encoding: 'utf8' });
    must(remaining.status === 1 && /No such (?:object|container)/i.test(remaining.stderr), 'BROWSER_CONTAINER_REMAINS');
    for (const volume of plan.anonymousVolumes) {
      const removed = spawnSync('docker', ['volume', 'inspect', volume], { env: cleanEnv(), encoding: 'utf8' });
      must(removed.status === 1 && /no such volume/i.test(removed.stderr), 'BROWSER_ANONYMOUS_VOLUME_REMAINS');
    }
    rmSync(plan.profile, { recursive: true, force: true }); must(!existsSync(plan.profile), 'BROWSER_PROFILE_REMAINS');
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('BROWSER_PIPE_CLOSED')); }
    return { containerId: plan.id, image: plan.image, containerProcess, attachProcess: { ...attachIdentity, absent: true }, containerAbsent: true, profileAbsent: true, volumesAbsent: true, nativeDiagnosticsHash: sha(diagnostic), requests, brokerErrors };
  }
  try {
    const version = await send('Browser.getVersion', {}, null);
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
    const attached = await send('Target.attachToTarget', { targetId, flatten: true }, null); sessionId = attached.sessionId;
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); must(!result.exceptionDetails, 'BROWSER_EVALUATION_FAILED'); return result.result.value; };
    const navigate = async url => { allowedBrowserUrl(runtime, environment, url); assert.equal(brokerErrors.length, 0, 'browser broker failed'); return send('Page.navigate', { url }); };
    return { send, evaluate, navigate, close, version, requests, network, brokerErrors, attachIdentity, on: (method, callback) => { listeners.set(method, [...(listeners.get(method) || []), callback]); } };
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'BROWSER_STARTUP_FAILED';
    error.browserStartup = { error: code, diagnosticsHash: sha(diagnostic), containerState: inspect(plan.id).State.Status, ...(error.browserShapeDelta ? { shapeDelta: error.browserShapeDelta } : {}) };
    try { error.browserCleanup = await close(); } catch (cleanupError) { error.browserCleanupError = /^[A-Z][A-Z0-9_]+$/.test(cleanupError.message) ? cleanupError.message : 'BROWSER_CLEANUP_FAILED'; }
    throw error;
  }
}

/** Actual intercepted navigation negatives run before any product DOM case. */
export async function rehearseBrowserIsolation(browser, runtime, environment) {
  const before = browser.requests.length;
  const results = [];
  const diagnose = (probe, url, navigate, evaluation) => ({
    probe, url: new URL(url).href, origin: new URL(url).origin, protocol: new URL(url).protocol,
    navigate, verdict: evaluation.verdict, pass: evaluation.pass,
    intercepted: [...evaluation.own, ...evaluation.foreign, ...evaluation.unattributed].map(({ allowed, error, url: u, origin, resourceType, frameId }) => ({ allowed, error: error ?? null, url: u ?? null, origin: origin ?? null, resourceType: resourceType ?? null, frameId: frameId ?? null })),
    networkObserved: (browser.network || []).filter(event => event.url === new URL(url).href).slice(0, 20),
  });
  const probes = ['http://127.0.0.1:3000/', 'http://localhost:9000/', 'http://127.0.0.1:5433/'];
  for (const [probe, url] of probes.entries()) {
    assert.throws(() => allowedBrowserUrl(runtime, environment, url), error => error.message === 'BROWSER_RESOURCE_TARGET_DENIED');
    const start = browser.requests.length;
    let navigate;
    try {
      const result = await browser.send('Page.navigate', { url });
      navigate = { frameId: result?.frameId ?? null, loaderIdPresent: Boolean(result?.loaderId), errorText: result?.errorText ?? null, threw: null };
    } catch (error) { navigate = { frameId: null, loaderIdPresent: false, errorText: null, threw: /^[A-Z][A-Z0-9_]+$/.test(error?.message) ? error.message : 'BROWSER_NAVIGATE_FAILED' }; }
    // Wait only for an attributable request for THIS probe; a late event from another probe cannot end or satisfy the wait. Timeout unchanged: 100 x 20 ms.
    for (let attempt = 0; attempt < 100 && !evaluateAmbientProbe(browser.requests, start, url).own.length; attempt++) await delay(20);
    const evaluation = evaluateAmbientProbe(browser.requests, start, url);
    const diagnostic = diagnose(probe, url, navigate, evaluation);
    results.push(diagnostic);
    if (!evaluation.pass) {
      const error = Error('BROWSER_AMBIENT_REQUEST_NOT_REJECTED');
      error.browserProbeDiagnostics = results;
      throw error;
    }
    if (browser.brokerErrors.length !== 0) {
      const error = Error('BROWSER_SAFETY_REHEARSAL_FAILED');
      error.browserProbeDiagnostics = results;
      throw error;
    }
    diagnostic.browserAttempted = true; diagnostic.nodeFetchRequests = 0;
  }
  must(browser.requests.slice(before).every(request => request.allowed === false), 'BROWSER_UNAPPROVED_REQUEST_EXECUTED');
  return results;
}

export function browserSafetyNegatives(runtime, environment, container) {
  const plan = runtime.browser;
  const checked = [];
  assert.equal(validateBrowserPlan(runtime, plan, { ...container, HostConfig: { ...container.HostConfig, Tmpfs: Object.fromEntries(Object.entries(container.HostConfig.Tmpfs).toReversed()) } }), true);
  checked.push({ name: 'tmpfs-object-key-order-does-not-change-identity', pass: true, requests: 0 });
  for (const [name, changed, target, expected] of [
    ['missing-receipt', null, container, 'BROWSER_RUNTIME_IDENTITY_REQUIRED'],
    ['mismatched-container', { ...plan, id: '0'.repeat(64) }, container, 'BROWSER_CONTAINER_IDENTITY_MISMATCH'],
    ['wrong-profile', { ...plan, profile: '/tmp/ambient-browser-profile' }, container, 'BROWSER_PROFILE_OR_BINARY_MISMATCH'],
    ['wrong-binary', { ...plan, executable: '/usr/bin/node' }, container, 'BROWSER_PROFILE_OR_BINARY_MISMATCH'],
    ['network-available', plan, { ...container, HostConfig: { ...container.HostConfig, NetworkMode: 'bridge' } }, 'BROWSER_CONTAINER_ISOLATION_MISMATCH'],
    ['resource-limit-tamper', plan, { ...container, HostConfig: { ...container.HostConfig, Memory: 2048 } }, 'BROWSER_CONTAINER_LIMITS_MISMATCH'],
    ['stale-runtime', plan, container, 'BROWSER_RUNTIME_RECEIPT_STALE'],
  ]) {
    assert.throws(() => validateBrowserPlan(name === 'stale-runtime' ? { ...runtime, expiresAt: '2000-01-01T00:00:00Z' } : runtime, changed, target), error => error.message === expected);
    checked.push({ name, pass: true, error: expected, requests: 0 });
  }
  for (const url of ['http://127.0.0.1:3000/', 'http://localhost:9000/', 'http://127.0.0.1:5433/', 'http://example.invalid/']) {
    assert.throws(() => allowedBrowserUrl(runtime, environment, url), error => error.message === 'BROWSER_RESOURCE_TARGET_DENIED');
  }
  checked.push({ name: 'ambient-resource-origins-denied-before-node-fetch', pass: true, requests: 0 });
  return checked;
}

/** The real connect entry point rejects caller drift before G1 probes/start. */
export async function browserContextNegatives(runtime, environment) {
  const results = [];
  const snapshot = inspect(runtime.browser.id); validateBrowserPlan(runtime, runtime.browser, snapshot);
  must(!snapshot.State.Running && snapshot.State.Pid === 0, 'BROWSER_NEGATIVE_REHEARSAL_REQUIRES_STOPPED_CONTAINER');
  for (const [name, suppliedRuntime, suppliedEnvironment, expected] of [
    ['missing-canonical-runtime', undefined, environment, 'BROWSER_CANONICAL_CONTEXT_REQUIRED'],
    ['wrong-canonical-run', { ...runtime, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, environment, 'BROWSER_CANONICAL_RUNTIME_MISMATCH'],
    ['stale-canonical-runtime', { ...runtime, expiresAt: '2000-01-01T00:00:00Z' }, environment, 'BROWSER_RUNTIME_RECEIPT_STALE'],
    ['same-browser-receipt-wrong-web-postgres-port', { ...runtime, roles: { ...runtime.roles, web: { ...runtime.roles.web, port: 55460 } } }, environment, 'BROWSER_CANONICAL_RUNTIME_MISMATCH'],
    ['same-browser-receipt-wrong-web-redis-port', { ...runtime, roles: { ...runtime.roles, web: { ...runtime.roles.web, port: 55461 } } }, environment, 'BROWSER_CANONICAL_RUNTIME_MISMATCH'],
    ['non-canonical-minio-environment', runtime, { ...environment, MINIO_ENDPOINT: 'http://127.0.0.1:9999' }, 'BROWSER_CANONICAL_ENVIRONMENT_MISMATCH'],
    ['non-canonical-datasource-environment', runtime, { ...environment, DATABASE_URL: 'postgresql://invalid:fixture@127.0.0.1:5433/fieldframe' }, 'BROWSER_CANONICAL_ENVIRONMENT_MISMATCH'],
  ]) {
    await assert.rejects(connectBrowser({ runtime: suppliedRuntime, environment: suppliedEnvironment }), error => error.message === expected);
    const after = inspect(runtime.browser.id); validateBrowserPlan(runtime, runtime.browser, after);
    must(!after.State.Running && after.State.Pid === 0 && after.State.StartedAt === snapshot.State.StartedAt, 'BROWSER_NEGATIVE_STARTED_CONTAINER');
    results.push({ name, pass: true, error: expected, validationStage: 'canonical-context-before-g1-probe-or-browser-start', started: false });
  }
  return results;
}
