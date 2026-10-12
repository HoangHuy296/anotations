// Stage-1 receipt-owned disposable HTTP runtime (design: specs/029-modality-specific-datasets/release/disposable-http-runtime-plan.md, Stage 1).
// Entered ONLY through a G1 test receipt scoped to one of the exact commands in HTTP_RUNTIME_COMMANDS (the focused runner issues it on a fresh disposable PostgreSQL, Redis and
// MinIO with the frozen 26-migration chain). It starts one receipt-owned web role (the same `runtime-child.mjs web` the G4/G5 supervisor uses) from the same private source
// snapshot, project hash pinning and compiler-ancestry ledger, then runs the command's test files as receipt-owned roles and requires the executed counts to match:
//   web:test:dataset-metadata       the complete 21-test dataset-metadata contract (four HTTP-bound files as `legacy`, dataset-patch-route as `dataset-patch`).
//   web:test:workspace-integration  the annotation/workspace persistence suites that are opt-in outside Compose (WORKSPACE_INTEGRATION_TESTS, ANNOTATION_API_INTEGRATION_TESTS,
//                                   VIDEO_VIEW_INTEGRATION_TESTS) and the TEXT suites, one process per file (role `suite`). The opt-in flags are part of the receipt-verified
//                                   environment of THIS run only, a disposable MinIO bucket is created for it, and any skipped test fails the run.
// It is not G3 or G5 evidence and does not touch runtime-suite.mjs, runtime-authority.cjs, runtime-compilers.cjs or the network fence.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { verify, root, cleanEnv, registry, sha, walk, redact } from './guard.mjs';
const require = createRequire(import.meta.url);
const authority = require('./runtime-authority.cjs');
const compilerAuthority = require('./runtime-compilers.cjs');
export const HTTP_RUNTIME_ROLES = Object.freeze(['web', 'legacy', 'dataset-patch', 'suite']);
/** Test files (relative to apps/web/tests) the `suite` role may import, one per process. Kept in step with runtime-child.mjs and offline-tested for equality. */
export const WORKSPACE_INTEGRATION_FILES = Object.freeze([
  'annotation-api/annotation-service.test.ts', 'annotation-api/annotation-validation.test.ts', 'annotation-api/annotation-create-authorization.test.ts', 'annotation-api/video-foundation.test.ts',
  'workspace/annotation-mutations.test.ts', 'workspace/annotation-shape-editing.test.ts', 'workspace/annotation-locking.test.ts', 'workspace/video-engine-read.test.ts', 'workspace/video-timeline-ownership.test.ts', 'workspace/autosave-state.test.ts',
  'annotation-api/text-generic-reader.test.ts',
  'workspace/video-update-schema.test.ts',
  'workspace/label-management.test.ts',
  'workspace/dataset-library-counts.test.ts',
  'text-annotations/text-classification-commands.test.ts',
  'text-annotations/text-classification-races.test.ts',
  'text-annotations/text-command-foundation.test.ts',
  'text-annotations/text-label-eligibility.test.ts',
  'text-annotations/text-policy-service.test.ts',
  'text-annotations/text-properties.test.ts',
  'text-annotations/text-relation-commands.test.ts',
  'text-annotations/text-span-command-races.test.ts',
  'text-annotations/text-span-commands.test.ts',
  'text-annotations/text-span-isolation.test.ts',
  'text-annotations/text-span-unicode-fixtures.test.ts',
  'text-annotations/workspace-selection-text.test.ts',
  'text-source/text-access-denial.test.ts',
  'text-source/text-boundary-loader.test.ts',
  'text-source/text-prepare-route.test.ts',
  'text-source/text-read-route.test.ts',
  'text-source/text-reader-browser.test.ts',
  'text-source/text-reader-fixtures.test.ts',
  'text-source/text-source-prepare-service.test.ts',
  'text-source/text-source-readiness.test.ts',
  'text-source/text-source-service.test.ts'
]);
export const HTTP_RUNTIME_COMMANDS = Object.freeze({
  'web:test:dataset-metadata': Object.freeze({ flags: Object.freeze({}), bucket: false, roleFiles: Object.freeze({ legacy: ['assets', 'datasets', 'labels', 'http-routes'], 'dataset-patch': ['dataset-patch-route'] }), dir: 'dataset-metadata' }),
  'web:test:workspace-integration': Object.freeze({ flags: Object.freeze({ WORKSPACE_INTEGRATION_TESTS: '1', ANNOTATION_API_INTEGRATION_TESTS: '1', VIDEO_VIEW_INTEGRATION_TESTS: '1' }), bucket: true, suites: WORKSPACE_INTEGRATION_FILES }),
});
/** Kept for the dataset-metadata plan (and its offline tests). */
export const HTTP_RUNTIME_COMMAND = 'web:test:dataset-metadata';
export const HTTP_RUNTIME_ROLE_FILES = HTTP_RUNTIME_COMMANDS[HTTP_RUNTIME_COMMAND].roleFiles;
export const HTTP_RUNTIME_WEB_PORT = 55470;
const baseReceipt = process.env.DB_SAFETY_RECEIPT;
const checked = await verify(baseReceipt, 'test');
process.env.DATABASE_URL = checked.target.url.toString();
const COMMAND = checked.r.command;
const PLAN = Object.hasOwn(HTTP_RUNTIME_COMMANDS, COMMAND) ? HTTP_RUNTIME_COMMANDS[COMMAND] : null;
assert.ok(PLAN, 'the HTTP runtime must be entered through one of its exact approved commands');
assert.notEqual(HTTP_RUNTIME_WEB_PORT, 3000, 'the canonical application port is never a test target');
// The web port must be a G1 loopback port that is not the disposable PostgreSQL's (or any other receipt-owned provider's) and must be free: the runtime never falls back to another port.
const claimedPorts = [Number(checked.target.url.port), ...Object.entries(checked.env).flatMap(([key, value]) => { if (/PORT$/.test(key)) return [Number(value)]; try { return [Number(new URL(String(value)).port)]; } catch { return []; } })].filter(Number.isInteger);
assert.ok(!claimedPorts.includes(HTTP_RUNTIME_WEB_PORT), 'the runtime web port collides with a receipt-owned provider port');
await new Promise((resolveProbe, rejectProbe) => { const probe = createServer(); probe.once('error', () => rejectProbe(Error('RUNTIME_WEB_PORT_IN_USE'))); probe.listen(HTTP_RUNTIME_WEB_PORT, '127.0.0.1', () => probe.close(() => resolveProbe())); });
const privateRoot = mkdtempSync('/tmp/phase029-g1-runtime-');
const id = randomUUID();
const ledger = join(privateRoot, 'processes'); mkdirSync(ledger, { mode: 0o700 });
const project = join(privateRoot, 'project'); mkdirSync(project, { mode: 0o700 });
const children = [];
// An interrupted supervisor must not leave its web runtime behind: terminate each owned child by exact identity, then exit (the finally block below covers ordinary failures).
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  for (const owned of children) {
    try { if (owned.child.exitCode === null && authority.same(authority.identity(owned.identity.pid), owned.identity)) owned.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(130), 3000).unref();
});
const evidence = { mode: 'http', command: COMMAND, owner: authority.identity(process.pid), scenarios: [], processes: [], cleanup: null };
assert.equal(process.env.G1_RUNTIME_EVIDENCE, undefined);
const entryHash = sha(readFileSync(join(root, 'scripts/db-safety/runtime-child.mjs')));
const roles = Object.fromEntries(HTTP_RUNTIME_ROLES.map(role => [role, { port: role === 'web' ? HTTP_RUNTIME_WEB_PORT : null, entryHash }]));
const config = join(privateRoot, 'environment.json');
const environment = {
  ...checked.env, DATABASE_URL: checked.target.url.toString(), NODE_ENV: 'development',
  MINIO_PUBLIC_ENDPOINT: checked.env.MINIO_ENDPOINT, MINIO_CORS_ALLOWED_ORIGIN: `http://127.0.0.1:${HTTP_RUNTIME_WEB_PORT}`,
  UPLOAD_CAPABILITY_SECRET: randomBytes(32).toString('hex'), SOURCE_CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  COOKIE_SECURE: 'false', NEXT_TELEMETRY_DISABLED: '1', TSX_TSCONFIG_PATH: join(root, 'apps/web/tsconfig.json'),
  ...PLAN.flags, // opt-in test flags exist ONLY in this receipt-verified environment, never in the caller's
};
writeFileSync(config, JSON.stringify(environment), { mode: 0o600 });
const runtimePath = join(privateRoot, 'runtime.json');
let runtime;
let successful = false;
const registration = join(registry, `runtime-${id}.json`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launch(role, extraEnv = {}) {
  assert.ok(Object.keys(extraEnv).every(key => key === 'G1_RUNTIME_SUITE_FILES'), 'a child may receive only its approved suite selector');
  // Recheck container/PG identity and the entire migration set before each child.
  await verify(baseReceipt, 'test');
  Object.assign(process.env, environment);
  const childEnv = { ...cleanEnv(), ...environment, DB_SAFETY_RECEIPT: baseReceipt, G1_RUNTIME_RECEIPT: runtimePath, G1_RUNTIME_ROLE: role, ...extraEnv, NODE_OPTIONS: `--require=${join(root, 'scripts/db-safety/network-fence.cjs')}` };
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'scripts/db-safety/runtime-child.mjs'), role], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  // PID identity is captured immediately by the supervisor, independently of the child.
  const identity = authority.identity(child.pid); children.push({ child, identity, role, done, output: () => output });
  evidence.processes.push({ ...identity, role });
  return children.at(-1);
}
async function ready(child, marker) {
  for (let n = 0; n < 480; n++) {
    if (child.output().includes(marker)) return;
    if (child.child.exitCode !== null || child.child.signalCode) throw Error(`RUNTIME_${child.role.toUpperCase()}_START_FAILED`);
    await delay(250);
  }
  throw Error('RUNTIME_READINESS_TIMEOUT');
}
function safeOutput(text) {
  text = redact(text);
  for (const value of Object.entries(environment).filter(([key]) => /SECRET|PASSWORD|KEY/.test(key)).map(([, v]) => v)) text = text.split(value).join('[REDACTED]');
  return text;
}
try {
  // Private source snapshot has no .env or package scripts that source it.
  for (const part of ['apps/web/src', 'apps/web/public', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts', 'apps/web/package.json', 'apps/web/postcss.config.mjs', 'apps/web/next.config.ts', 'lib/generated/prisma', 'database-url.ts', 'packages/domain', 'packages/queue']) {
    const from = join(root, part); if (!existsSync(from)) continue;
    cpSync(from, join(project, part), { recursive: true, filter: p => !p.split('/').includes('node_modules') && !p.split('/').at(-1).startsWith('.env') });
  }
  symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
  symlinkSync(join(root, 'apps/web/node_modules'), join(project, 'apps/web/node_modules'), 'dir');
  const projectHashes = Object.fromEntries([...walk(project), ...walk(join(root, 'apps/worker/src')), ...walk(join(root, 'packages/domain/src')), ...walk(join(root, 'packages/queue/src'))].filter(p => !p.split('/').includes('node_modules') && !p.endsWith('/next-env.d.ts')).map(p => [p, sha(readFileSync(p))]));
  const nextRequire = createRequire(join(root, 'apps/web/package.json'));
  const compilerEntry = realpathSync(nextRequire.resolve('next/dist/compiled/jest-worker/processChild.js'));
  const compilerModule = realpathSync(nextRequire.resolve('next/dist/server/dev/static-paths-worker.js'));
  runtime = { id, mode: 'http', checkpoint: 'HTTP', owner: authority.identity(process.pid), baseReceipt, expiresAt: checked.r.expiresAt, config, configHash: sha(readFileSync(config)), ledger, roles, project, projectHashes, compiler: { distDir: join(project, 'apps/web/.next/dev'), entry: compilerEntry, entryHash: sha(readFileSync(compilerEntry)), module: compilerModule, moduleHash: sha(readFileSync(compilerModule)) } };
  writeFileSync(runtimePath, JSON.stringify(runtime), { mode: 0o400, flag: 'wx' });
  writeFileSync(registration, JSON.stringify({ path: runtimePath, hash: sha(readFileSync(runtimePath)) }), { mode: 0o400, flag: 'wx' });
  Object.assign(process.env, environment, { G1_RUNTIME_RECEIPT: runtimePath });

  if (PLAN.bucket) {
    // A disposable bucket on the receipt-owned MinIO (the generic focused plan provisions the server but no bucket). It dies with the MinIO container.
    assert.match(String(checked.env.MINIO_BUCKET), /^g1-[a-z0-9-]+$/); assert.match(String(checked.env.MINIO_ENDPOINT), /^http:\/\/127\.0\.0\.1:\d+$/);
    const { Client } = createRequire(join(root, 'apps/web/package.json'))('minio');
    const endpoint = new URL(checked.env.MINIO_ENDPOINT);
    await new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port), useSSL: false, accessKey: checked.env.MINIO_ACCESS_KEY, secretKey: checked.env.MINIO_SECRET_KEY }).makeBucket(checked.env.MINIO_BUCKET);
    evidence.scenarios.push({ name: 'disposable-bucket-created', pass: true, bucket: checked.env.MINIO_BUCKET });
  }
  const web = await launch('web'); await ready(web, 'RUNTIME_WEB_READY');
  evidence.scenarios.push({ name: 'receipt-owned-web-runtime-ready', pass: true });
  const tap = (output, key) => Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(output)?.[1] ?? NaN);
  const declared = path => (readFileSync(join(root, `apps/web/tests/${path}`), 'utf8').match(/^test\(/gm) ?? []).length;
  let executed = 0;
  if (PLAN.roleFiles) {
    // The complete dataset-metadata contract under the same runtime receipt. Counts are checked, not assumed.
    let expected = 0;
    for (const [role, files] of Object.entries(PLAN.roleFiles)) {
      const run = await launch(role); const exit = await run.done;
      const output = safeOutput(run.output());
      console.log('DATASET_METADATA_RESULTS', role, output);
      assert.equal(exit.code, 0, `dataset-metadata ${role} files failed`);
      const want = files.reduce((sum, file) => sum + declared(`${PLAN.dir}/${file}.test.ts`), 0);
      assert.equal(tap(output, 'tests'), want, `${role}: every declared test ran exactly once`);
      assert.equal(tap(output, 'pass'), want); assert.equal(tap(output, 'fail'), 0); assert.equal(tap(output, 'skipped'), 0);
      executed += tap(output, 'tests'); expected += want;
      evidence.scenarios.push({ name: `dataset-metadata-${role}`, pass: true, files, tests: want });
    }
    assert.equal(executed, expected);
    evidence.scenarios.push({ name: 'dataset-metadata-contract-complete', pass: true, tests: executed });
  } else {
    // Opt-in integration suites and TEXT suites, one process per file. A skipped test is a failure here: these flags exist so that nothing is skipped.
    const perFile = [];
    for (const file of PLAN.suites) {
      const run = await launch('suite', { G1_RUNTIME_SUITE_FILES: JSON.stringify([file]) }); const exit = await run.done;
      // The suite role is launched once per file: its exited child's ledger entry is retired so the next child registers its own identity (a live child is never replaced).
      rmSync(join(ledger, 'suite.json'), { force: true });
      const output = safeOutput(run.output());
      const counts = { tests: tap(output, 'tests'), pass: tap(output, 'pass'), fail: tap(output, 'fail'), skipped: tap(output, 'skipped'), todo: tap(output, 'todo') };
      perFile.push({ file, exit: exit.code, ...counts, declared: declared(file) });
      if (exit.code !== 0 || counts.fail !== 0) console.log('SUITE_FAILURE', file, output.slice(-3000));
      // every file runs even after a failure, so one run reports the complete picture; the run still fails below
      const problems = [];
      if (exit.code !== 0) problems.push(`exit ${exit.code}`);
      if (!(counts.tests >= declared(file) && counts.tests > 0)) problems.push('a declared test did not run');
      if (counts.pass !== counts.tests) problems.push('not all passed');
      if (counts.fail !== 0) problems.push('failures');
      if (counts.skipped !== 0) problems.push('skipped tests');
      if (counts.todo !== 0) problems.push('todo tests');
      perFile[perFile.length - 1].problems = problems;
      executed += counts.tests;
    }
    console.log('WORKSPACE_INTEGRATION_RESULTS', JSON.stringify(perFile));
    const failed = perFile.filter(entry => entry.problems.length > 0);
    assert.equal(failed.length, 0, `suites with problems: ${failed.map(entry => `${entry.file} (${entry.problems.join(', ')})`).join('; ')}`);
    evidence.scenarios.push({ name: 'workspace-integration-suites-complete', pass: true, files: perFile.length, tests: executed, skipped: 0, perFile });
  }
  await verify(baseReceipt, 'test'); successful = true;
} finally {
  const stopped = [];
  for (const owned of children.toReversed()) {
    if (owned.child.exitCode === null && !owned.child.signalCode) {
      const actual = authority.identity(owned.identity.pid);
      assert.ok(authority.same(actual, owned.identity), 'cleanup PID identity changed');
      owned.child.kill('SIGTERM');
      const result = await Promise.race([owned.done, delay(30000).then(() => null)]);
      assert.ok(result, 'owned runtime did not drain; no unverified kill permitted');
    }
    assert.ok(!existsSync(`/proc/${owned.identity.pid}`), 'owned child still exists');
    stopped.push({ ...owned.identity, role: owned.role, absent: true });
    const logs = safeOutput(owned.output()); if (!successful && logs) console.log('RUNTIME_DIAGNOSTIC', owned.role, logs);
  }
  const compilerProcesses = [];
  for (const file of readdirSync(ledger).filter(name => /^compiler-[a-f0-9-]{36}\.json$/.test(name))) {
    const token = file.slice('compiler-'.length, -'.json'.length), c = compilerAuthority.claim(runtime, token).c;
    assert.equal(c.runtime, runtime.id); assert.ok(c.observed, 'compiler was never independently observed');
    const webProcess = evidence.processes.find(p => p.role === 'web'); assert.ok(webProcess && authority.same(c.parent, webProcess));
    if (existsSync(`/proc/${c.observed.pid}`)) {
      assert.ok(authority.same(authority.identity(c.observed.pid), c.observed), 'compiler PID was reused; cannot signal');
      process.kill(c.observed.pid, 'SIGTERM');
      for (let n = 0; n < 100 && existsSync(`/proc/${c.observed.pid}`); n++) await delay(50);
    }
    assert.ok(!existsSync(`/proc/${c.observed.pid}`), 'owned compiler remains after cleanup');
    compilerProcesses.push({ ...c, absent: true });
    assert.ok(c.verified, 'compiler exited without verified startup; never claim an unobserved child as verified');
  }
  rmSync(registration, { force: true }); rmSync(privateRoot, { recursive: true, force: true });
  delete process.env.G1_RUNTIME_RECEIPT;
  evidence.cleanup = { processes: stopped, compilerProcesses, registrationAbsent: !existsSync(registration), privateStageAbsent: !existsSync(privateRoot) };
  evidence.pass = successful;
  console.log('HTTP_RUNTIME_RECEIPT', JSON.stringify(evidence));
}
