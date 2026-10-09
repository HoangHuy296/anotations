// Stage-1 receipt-owned disposable HTTP runtime (design: specs/029-modality-specific-datasets/release/disposable-http-runtime-plan.md, Stage 1).
// Entered ONLY through a G1 test receipt scoped to the exact command `web:test:dataset-metadata` (the focused runner issues it on a fresh disposable PostgreSQL with the
// frozen 26-migration chain). That is the ONE guarded way to run the complete 21-test dataset-metadata contract: it starts one receipt-owned web role (the same
// `runtime-child.mjs web` the G4/G5 supervisor uses), then runs the four HTTP-bound files as the `legacy` role and `dataset-patch-route.test.ts` as the `dataset-patch` role,
// both under the same runtime receipt, and requires the executed test count to equal the declared count of `tests/dataset-metadata/*.test.ts` (nothing skipped or counted twice). It is a reduced form of runtime-suite.mjs: no provider, worker or browser, and none of the G4/G5
// negative scenarios. It starts from the same private source snapshot, the same project hash pinning, the same compiler-ancestry ledger and the same exact-PID cleanup.
// It is not G3 or G5 evidence and does not touch runtime-suite.mjs, runtime-child.mjs, runtime-authority.cjs, runtime-compilers.cjs or the network fence.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { verify, root, cleanEnv, registry, sha, walk, redact } from './guard.mjs';
const require = createRequire(import.meta.url);
const authority = require('./runtime-authority.cjs');
const compilerAuthority = require('./runtime-compilers.cjs');
export const HTTP_RUNTIME_COMMAND = 'web:test:dataset-metadata';
export const HTTP_RUNTIME_ROLES = Object.freeze(['web', 'legacy', 'dataset-patch']);
/** Which test files each test role runs (kept in step with runtime-child.mjs; offline-tested against the directory so a new file cannot be silently left out). */
export const HTTP_RUNTIME_ROLE_FILES = Object.freeze({ legacy: ['assets', 'datasets', 'labels', 'http-routes'], 'dataset-patch': ['dataset-patch-route'] });
export const HTTP_RUNTIME_WEB_PORT = 55470;
const baseReceipt = process.env.DB_SAFETY_RECEIPT;
const checked = await verify(baseReceipt, 'test');
process.env.DATABASE_URL = checked.target.url.toString();
assert.equal(checked.r.command, HTTP_RUNTIME_COMMAND, 'the HTTP runtime must be entered through its exact approved command');
assert.notEqual(HTTP_RUNTIME_WEB_PORT, 3000, 'the canonical application port is never a test target');
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
const evidence = { mode: 'http', command: HTTP_RUNTIME_COMMAND, owner: authority.identity(process.pid), scenarios: [], processes: [], cleanup: null };
assert.equal(process.env.G1_RUNTIME_EVIDENCE, undefined);
const entryHash = sha(readFileSync(join(root, 'scripts/db-safety/runtime-child.mjs')));
const roles = Object.fromEntries(HTTP_RUNTIME_ROLES.map(role => [role, { port: role === 'web' ? HTTP_RUNTIME_WEB_PORT : null, entryHash }]));
const config = join(privateRoot, 'environment.json');
const environment = {
  ...checked.env, DATABASE_URL: checked.target.url.toString(), NODE_ENV: 'development',
  MINIO_PUBLIC_ENDPOINT: checked.env.MINIO_ENDPOINT, MINIO_CORS_ALLOWED_ORIGIN: `http://127.0.0.1:${HTTP_RUNTIME_WEB_PORT}`,
  UPLOAD_CAPABILITY_SECRET: randomBytes(32).toString('hex'), SOURCE_CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  COOKIE_SECURE: 'false', NEXT_TELEMETRY_DISABLED: '1', TSX_TSCONFIG_PATH: join(root, 'apps/web/tsconfig.json'),
};
writeFileSync(config, JSON.stringify(environment), { mode: 0o600 });
const runtimePath = join(privateRoot, 'runtime.json');
let runtime;
let successful = false;
const registration = join(registry, `runtime-${id}.json`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launch(role) {
  // Recheck container/PG identity and the entire migration set before each child.
  await verify(baseReceipt, 'test');
  Object.assign(process.env, environment);
  const childEnv = { ...cleanEnv(), ...environment, DB_SAFETY_RECEIPT: baseReceipt, G1_RUNTIME_RECEIPT: runtimePath, G1_RUNTIME_ROLE: role, NODE_OPTIONS: `--require=${join(root, 'scripts/db-safety/network-fence.cjs')}` };
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

  const web = await launch('web'); await ready(web, 'RUNTIME_WEB_READY');
  evidence.scenarios.push({ name: 'receipt-owned-web-runtime-ready', pass: true });
  // The complete dataset-metadata contract under the same runtime receipt: the four HTTP-bound files, then the PATCH-route file. Counts are checked, not assumed.
  const declared = file => (readFileSync(join(root, `apps/web/tests/dataset-metadata/${file}.test.ts`), 'utf8').match(/^test\(/gm) ?? []).length;
  let executed = 0, expected = 0;
  for (const [role, files] of Object.entries(HTTP_RUNTIME_ROLE_FILES)) {
    const run = await launch(role); const exit = await run.done;
    const output = safeOutput(run.output());
    console.log('DATASET_METADATA_RESULTS', role, output);
    assert.equal(exit.code, 0, `dataset-metadata ${role} files failed`);
    const count = key => Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(output)?.[1] ?? NaN);
    const want = files.reduce((sum, file) => sum + declared(file), 0);
    assert.equal(count('tests'), want, `${role}: every declared test ran exactly once`);
    assert.equal(count('pass'), want); assert.equal(count('fail'), 0); assert.equal(count('skipped'), 0);
    executed += count('tests'); expected += want;
    evidence.scenarios.push({ name: `dataset-metadata-${role}`, pass: true, files, tests: want });
  }
  assert.equal(executed, expected);
  evidence.scenarios.push({ name: 'dataset-metadata-contract-complete', pass: true, tests: executed });
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
