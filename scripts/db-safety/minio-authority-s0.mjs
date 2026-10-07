// A2 / R9-M1 — S0 storage-authority proof against DISPOSABLE MinIO only. Run with tsx (it imports worker TypeScript):
//
//   node --import tsx scripts/db-safety/minio-authority-s0.mjs [--authoritative] [--out <dir>]
//
// REHEARSAL (default) uses the candidate image pins; AUTHORITATIVE additionally requires `frozen-images.json` to be frozen by the release owner
// (digest-pinned minio/minio and minio/mc). Floating tags are never accepted. No shared-dev, application database, G3/G5 or release artifact is touched.
// Everything created carries the labels annotation.safety=a2-s0 / annotation.run=<id> and is removed by exact id, then verified by an independent process.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ARTIFACT_DIR, POLICY_NAME, ROLES, ROOT, SEALED_PREFIX, analyzePolicy, assertNoSecrets, checkImagePins, collectSecrets, loadArtifacts, mcReference, minioReference,
  parseSnapshot, randomCredentials, renderPolicy, sha256, snapshotDigest, verifySnapshot,
} from './minio-authority.mjs';
import { buildReport, compareAudit, loadAllowlist } from './minio-write-audit.mjs';

const require = createRequire(join(ROOT, 'apps/worker/package.json'));
const { Client, CopyConditions } = require('minio');

const args = process.argv.slice(2);
const authoritative = args.includes('--authoritative');
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const runId = randomBytes(4).toString('hex');
const mode = authoritative ? 'AUTHORITATIVE' : 'REHEARSAL';
const bucket = `a2s0-${runId}`;
const scratch = `a2s0-${runId}-scratch`;
const LABELS = ['--label', 'annotation.safety=a2-s0', '--label', `annotation.run=${runId}`];
const artifacts = loadArtifacts();
const frozen = JSON.parse(artifacts.text.frozen);
const creds = randomCredentials();
const secrets = collectSecrets(creds);
const created = { containers: [], networks: [], volumes: [] };
const results = { battery: [], controls: [], steps: [] };
const sh = (command, argv, options = {}) => { const r = spawnSync(command, argv, { encoding: 'utf8', input: options.input, env: options.env ?? { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 64 * 1024 * 1024, timeout: options.timeout ?? 180000 }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
const docker = (argv, options) => sh('docker', argv, options);
const must = (ok, code, detail) => { if (!ok) throw Object.assign(Error(code), { detail }); };
const step = async (name, fn) => { const started = Date.now(); try { const value = await fn(); results.steps.push({ name, ok: true, ms: Date.now() - started }); return value; } catch (error) { results.steps.push({ name, ok: false, code: error.message, detail: error.detail ?? null }); throw error; } };

// ---------------------------------------------------------------------------------------------------------------- docker helpers
function inspectImage(reference) {
  const r = docker(['image', 'inspect', reference]);
  must(r.status === 0, 'S0_IMAGE_NOT_PRESENT', reference);
  const info = JSON.parse(r.stdout)[0];
  return { reference, id: info.Id, repoDigests: info.RepoDigests ?? [], created: info.Created, architecture: info.Architecture };
}
function runMc(ctx, label, script, extraEnv = {}) {
  const name = `a2s0-${runId}-mc-${label}`;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    MC_HOST_local: `http://${creds.root.accessKey}:${creds.root.secretKey}@minio:9000`,
    S0_BUCKET: bucket, S0_POLICY_WEB: JSON.stringify(renderPolicy(artifacts.text.web, bucket)), S0_POLICY_WORKER: JSON.stringify(renderPolicy(artifacts.text.worker, bucket)), S0_POLICY_VERIFIER: JSON.stringify(renderPolicy(artifacts.text.verifier, bucket)), S0_LIFECYCLE: artifacts.text.lifecycle,
    S0_WEB_KEY: creds.web.accessKey, S0_WEB_SECRET: creds.web.secretKey, S0_WORKER_KEY: creds.worker.accessKey, S0_WORKER_SECRET: creds.worker.secretKey,
    S0_VERIFIER_KEY: creds.verifier.accessKey, S0_VERIFIER_SECRET: creds.verifier.secretKey, ...extraEnv,
  };
  const names = Object.keys(env).filter(key => key.startsWith('S0_') || key === 'MC_HOST_local');
  const run = docker(['run', '-d', '--name', name, '--network', ctx.network.name, '--read-only', '--tmpfs', '/tmp:rw,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--user', '65534:65534', ...LABELS, ...names.flatMap(key => ['-e', key]), '--entrypoint', '/bin/sh', ctx.mcRef, '-c', script], { env });
  must(run.status === 0, 'S0_MC_CONTAINER_NOT_STARTED', run.stderr.slice(0, 300));
  const id = run.stdout.trim();
  created.containers.push({ role: `mc-${label}`, id, name });
  const waited = docker(['wait', id]);
  const logs = docker(['logs', id]);
  const output = `${logs.stdout}${logs.stderr}`;
  assertNoSecrets(output, secrets);
  docker(['rm', '-fv', id]);
  return { exit: Number(waited.stdout.trim()), output };
}
async function waitHealthy(port) {
  for (let i = 0; i < 120; i += 1) { try { const r = await fetch(`http://127.0.0.1:${port}/minio/health/ready`); if (r.status === 200) return; } catch { /* starting */ } await new Promise(done => setTimeout(done, 500)); }
  throw Error('S0_MINIO_NOT_READY');
}

// ---------------------------------------------------------------------------------------------------------------- client helpers
const mk = (port, entry) => new Client({ endPoint: '127.0.0.1', port, useSSL: false, accessKey: entry.accessKey, secretKey: entry.secretKey });
const TRANSIENT = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED']);
async function attempt(fn) {
  for (let tries = 0; ; tries += 1) {
    try { const value = await fn(); return { outcome: 'ALLOWED', value }; }
    catch (error) {
      const code = error.code ?? error.name ?? 'UNKNOWN';
      if (TRANSIENT.has(code) && tries < 3) { await new Promise(done => setTimeout(done, 200 * (tries + 1))); continue; } // a socket reset is inconclusive, never a denial
      return { outcome: 'ERROR', code, status: error.statusCode ?? null };
    }
  }
}
const DENIED = new Set(['AccessDenied', 'Forbidden', 'AccessDeniedException']);
const isDenied = r => r.outcome === 'ERROR' && (DENIED.has(r.code) || r.status === 403);
const record = (list, id, identity, op, target, expect, observed, pass) => list.push({ id, identity, op, target, expect, observed: { outcome: observed.outcome, code: observed.code ?? null, status: observed.status ?? null }, pass });
function check(list, id, identity, op, target, expect, observed) {
  const pass = expect === 'ALLOW' ? observed.outcome === 'ALLOWED'
    : expect === 'DENY' ? isDenied(observed)
      : expect === 'NOT_FOUND' ? observed.outcome === 'ERROR' && ['NotFound', 'NoSuchKey'].includes(observed.code)
        : expect === 'REACHED' ? (observed.outcome === 'ALLOWED' || !isDenied(observed)) : false;
  record(list, id, identity, op, target, expect, observed, pass);
  return pass;
}
const removeOne = async (client, key) => { const response = await client.removeObjects(bucket, [key]); if (response?.length) throw Object.assign(Error('remove'), { code: response[0].Code ?? response[0].code }); };
const rawRequest = (client, method, objectName, query, body = '') => client.makeRequestAsync({ method, bucketName: bucket, objectName, query }, body, [200, 204]);
const stat = async (client, key) => { const s = await client.statObject(bucket, key); return { etag: s.etag, size: s.size, lastModified: s.lastModified.toISOString() }; };
async function postForm(post, key, body) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...post.formData, ...(key ? { key } : {}) })) form.append(name, value);
  form.append('file', new Blob([body]), 'f.bin');
  const response = await fetch(post.postURL, { method: 'POST', body: form });
  return { status: response.status, text: (await response.text()).slice(0, 200) };
}
async function listKeys(client, prefix) { const out = []; await new Promise((ok, no) => { const stream = client.listObjectsV2(bucket, prefix, true); stream.on('data', item => item.name && out.push(item.name)); stream.on('error', no); stream.on('end', ok); }); return out.sort(); }

// ---------------------------------------------------------------------------------------------------------------- the battery
async function battery(ctx) {
  const { R, W, K, V } = ctx.clients;
  const list = results.battery;
  const sealed = `${SEALED_PREFIX}S0/sealed-1`;
  const original = `sealed-original-${randomBytes(6).toString('hex')}`;
  const stagedA = 'direct-uploads/S0/staged-1', stagedB = 'prepared-imports/S0/staged-2', other = 'exports/S0/other-1';
  for (const [key, body] of [[sealed, original], [stagedA, 'a'], [stagedB, 'b'], [other, 'o']]) await R.putObject(bucket, key, Buffer.from(body));
  const before = await stat(R, sealed);
  const keysBefore = await listKeys(R, '');
  const uploadId = await V.initiateNewMultipartUpload(bucket, `${SEALED_PREFIX}S0/mp-owner`, {}); // owner-created upload to test abort/list by others

  const D = (id, who, client, op, key, fn) => attempt(fn).then(r => check(list, id, who, op, key, 'DENY', r));
  const A = (id, who, client, op, key, fn) => attempt(fn).then(r => check(list, id, who, op, key, 'ALLOW', r));
  const sealedNew = `${SEALED_PREFIX}S0/never-created`;
  const tags = { k: 'v' };
  const retention = { mode: 'GOVERNANCE', retainUntilDate: new Date(Date.now() + 86400000).toISOString() };
  const rootRetention = await attempt(() => R.putObjectRetention(bucket, sealed, retention));
  const retentionCheck = (id, who, observed) => { const inert = observed.outcome === 'ERROR' && !isDenied(observed) && observed.code === rootRetention.code; record(list, id, who, `retention on sealed (${isDenied(observed) ? 'denied by IAM' : inert ? `INERT: the store rejects it for every identity incl. root with ${rootRetention.code} because the bucket has no Object Lock configuration` : 'NOT DENIED'})`, sealed, 'DENY_OR_INERT', observed, isDenied(observed) || inert); };
  const lifecycleBody = { Rule: [{ ID: 'x', Status: 'Enabled', Filter: { Prefix: SEALED_PREFIX }, Expiration: { Days: 1 } }] };

  // ---- I-WEB
  await A('W+1', 'WEB', W, 'put staging direct-uploads', 'direct-uploads/S0/w-put', () => W.putObject(bucket, 'direct-uploads/S0/w-put', Buffer.from('w')));
  await A('W+2', 'WEB', W, 'put staging prepared-imports', 'prepared-imports/S0/w-put', () => W.putObject(bucket, 'prepared-imports/S0/w-put', Buffer.from('w')));
  await A('W+3', 'WEB', W, 'read sealed (published objects are read by the web)', sealed, async () => { const s = await W.getObject(bucket, sealed); let text = ''; for await (const c of s) text += c; if (text !== original) throw Error('content'); });
  await A('W+4', 'WEB', W, 'stat sealed / list sealed prefix', sealed, async () => { await W.statObject(bucket, sealed); await listKeys(W, SEALED_PREFIX); });
  await A('W+5', 'WEB', W, 'delete staged object', 'direct-uploads/S0/w-put', () => removeOne(W, 'direct-uploads/S0/w-put'));
  await A('W+6', 'WEB', W, 'delete staged object (prepared-imports)', 'prepared-imports/S0/w-put', () => removeOne(W, 'prepared-imports/S0/w-put'));
  await D('W-1', 'WEB', W, 'PUT create under sealed', sealedNew, () => W.putObject(bucket, sealedNew, Buffer.from('x')));
  await D('W-2', 'WEB', W, 'PUT overwrite existing sealed', sealed, () => W.putObject(bucket, sealed, Buffer.from('overwritten')));
  await D('W-3', 'WEB', W, 'copy-to sealed (source = staged)', sealedNew, () => W.copyObject(bucket, sealedNew, `/${bucket}/${stagedA}`));
  await D('W-4', 'WEB', W, 'copy-over existing sealed', sealed, () => W.copyObject(bucket, sealed, `/${bucket}/${stagedA}`));
  await D('W-5', 'WEB', W, 'delete sealed (removeObjects)', sealed, () => removeOne(W, sealed));
  await D('W-6', 'WEB', W, 'multipart initiate on sealed', sealedNew, () => W.initiateNewMultipartUpload(bucket, sealedNew, {}));
  await D('W-7', 'WEB', W, 'multipart abort on sealed upload', `${SEALED_PREFIX}S0/mp-owner`, () => W.abortMultipartUpload(bucket, `${SEALED_PREFIX}S0/mp-owner`, uploadId));
  await D('W-8', 'WEB', W, 'multipart list parts on sealed upload', `${SEALED_PREFIX}S0/mp-owner`, () => rawRequest(W, 'GET', `${SEALED_PREFIX}S0/mp-owner`, `uploadId=${uploadId}`));
  await D('W-9', 'WEB', W, 'object tagging on sealed', sealed, () => W.setObjectTagging(bucket, sealed, tags));
  retentionCheck('W-10', 'WEB', await attempt(() => W.putObjectRetention(bucket, sealed, retention)));
  await D('W-11', 'WEB', W, 'legal hold on sealed', sealed, () => rawRequest(W, 'PUT', sealed, 'legal-hold', '<LegalHold><Status>ON</Status></LegalHold>'));
  await D('W-12', 'WEB', W, 'write outside staging (exports/)', 'exports/S0/w-other', () => W.putObject(bucket, 'exports/S0/w-other', Buffer.from('x')));
  await D('W-13', 'WEB', W, 'bucket lifecycle write', bucket, () => W.setBucketLifecycle(bucket, lifecycleBody));
  await D('W-14', 'WEB', W, 'bucket lifecycle read', bucket, () => W.getBucketLifecycle(bucket));
  await D('W-15', 'WEB', W, 'bucket policy write', bucket, () => W.setBucketPolicy(bucket, JSON.stringify({ Version: '2012-10-17', Statement: [] })));
  await D('W-16', 'WEB', W, 'bucket versioning write', bucket, () => W.setBucketVersioning(bucket, { Status: 'Enabled' }));
  await D('W-17', 'WEB', W, 'create another bucket', `${bucket}-w`, () => W.makeBucket(`${bucket}-w`));
  await D('W-18', 'WEB', W, 'delete bucket', bucket, () => W.removeBucket(bucket));
  // presign / capability redirection
  const putUrl = await W.presignedPutObject(bucket, sealedNew, 300);
  record(list, 'W-19a', 'WEB', 'presign PUT URL for sealed key is generated (local signing)', sealedNew, 'ALLOW', { outcome: 'ALLOWED' }, typeof putUrl === 'string');
  const putResponse = await fetch(putUrl, { method: 'PUT', body: 'redirected' });
  record(list, 'W-19b', 'WEB', 'use web-signed presigned PUT on sealed key', sealedNew, 'DENY', { outcome: 'ERROR', code: `HTTP_${putResponse.status}`, status: putResponse.status }, putResponse.status === 403);
  const sealedPost = W.newPostPolicy(); sealedPost.setBucket(bucket); sealedPost.setKey(sealedNew); sealedPost.setExpires(new Date(Date.now() + 300000)); sealedPost.setContentLengthRange(1, 1024);
  const sealedPostResult = await W.presignedPostPolicy(sealedPost);
  const sealedPostResponse = await postForm(sealedPostResult, null, 'redirected');
  record(list, 'W-20', 'WEB', 'use web-signed presigned POST naming a sealed key', sealedNew, 'DENY', { outcome: 'ERROR', code: `HTTP_${sealedPostResponse.status}`, status: sealedPostResponse.status }, sealedPostResponse.status === 403);
  const stagedKey = 'direct-uploads/S0/post-ok';
  const stagedPost = W.newPostPolicy(); stagedPost.setBucket(bucket); stagedPost.setKey(stagedKey); stagedPost.setExpires(new Date(Date.now() + 300000)); stagedPost.setContentLengthRange(1, 1024);
  const stagedPostResult = await W.presignedPostPolicy(stagedPost);
  const okPost = await postForm(stagedPostResult, null, 'ok-body');
  record(list, 'W+7', 'WEB', 'untampered presigned POST to a staging key (positive control)', stagedKey, 'ALLOW', { outcome: okPost.status === 204 ? 'ALLOWED' : 'ERROR', status: okPost.status }, okPost.status === 204 && (await listKeys(R, stagedKey)).length === 1);
  const tampered = await postForm(await W.presignedPostPolicy((() => { const p = W.newPostPolicy(); p.setBucket(bucket); p.setKey('direct-uploads/S0/post-tamper'); p.setExpires(new Date(Date.now() + 300000)); p.setContentLengthRange(1, 1024); return p; })()), sealedNew, 'tampered');
  record(list, 'W-21', 'WEB', 'POST signed for a staging key with the key field tampered to a sealed key', sealedNew, 'DENY', { outcome: 'ERROR', code: `HTTP_${tampered.status}`, status: tampered.status }, tampered.status >= 400 && tampered.status < 500);

  // ---- I-WORKER (general)
  await A('K+1', 'WORKER', K, 'put other prefix (exports)', 'exports/S0/k-put', () => K.putObject(bucket, 'exports/S0/k-put', Buffer.from('k')));
  await A('K+2', 'WORKER', K, 'delete other prefix', 'exports/S0/k-put', () => removeOne(K, 'exports/S0/k-put'));
  await A('K+3', 'WORKER', K, 'read sealed', sealed, async () => { const s = await K.getObject(bucket, sealed); for await (const c of s) void c; });
  await A('K+4', 'WORKER', K, 'staging cleanup delete (temp-upload cleanup shape)', stagedB, async () => { await K.putObject(bucket, 'prepared-imports/S0/k-del', Buffer.from('d')); await removeOne(K, 'prepared-imports/S0/k-del'); });
  await A('K+5', 'WORKER', K, 'bucket exists / list (readiness)', bucket, async () => { if (!(await K.bucketExists(bucket))) throw Error('exists'); await listKeys(K, ''); });
  await D('K-1', 'WORKER', K, 'PUT create under sealed', sealedNew, () => K.putObject(bucket, sealedNew, Buffer.from('x')));
  await D('K-2', 'WORKER', K, 'PUT overwrite existing sealed', sealed, () => K.putObject(bucket, sealed, Buffer.from('overwritten')));
  await D('K-3', 'WORKER', K, 'copy-to sealed', sealedNew, () => K.copyObject(bucket, sealedNew, `/${bucket}/${stagedA}`));
  await D('K-4', 'WORKER', K, 'delete sealed', sealed, () => removeOne(K, sealed));
  await D('K-5', 'WORKER', K, 'multipart initiate on sealed', sealedNew, () => K.initiateNewMultipartUpload(bucket, sealedNew, {}));
  await D('K-6', 'WORKER', K, 'multipart abort on sealed upload', `${SEALED_PREFIX}S0/mp-owner`, () => K.abortMultipartUpload(bucket, `${SEALED_PREFIX}S0/mp-owner`, uploadId));
  await D('K-7', 'WORKER', K, 'multipart list parts on sealed upload', `${SEALED_PREFIX}S0/mp-owner`, () => rawRequest(K, 'GET', `${SEALED_PREFIX}S0/mp-owner`, `uploadId=${uploadId}`));
  await D('K-8', 'WORKER', K, 'object tagging on sealed', sealed, () => K.setObjectTagging(bucket, sealed, tags));
  retentionCheck('K-9', 'WORKER', await attempt(() => K.putObjectRetention(bucket, sealed, retention)));
  await D('K-10', 'WORKER', K, 'legal hold on sealed', sealed, () => rawRequest(K, 'PUT', sealed, 'legal-hold', '<LegalHold><Status>ON</Status></LegalHold>'));
  await D('K-11', 'WORKER', K, 'bucket lifecycle write', bucket, () => K.setBucketLifecycle(bucket, lifecycleBody));
  await D('K-12', 'WORKER', K, 'bucket lifecycle read', bucket, () => K.getBucketLifecycle(bucket));
  await D('K-13', 'WORKER', K, 'bucket policy write', bucket, () => K.setBucketPolicy(bucket, JSON.stringify({ Version: '2012-10-17', Statement: [] })));
  await D('K-14', 'WORKER', K, 'bucket versioning write', bucket, () => K.setBucketVersioning(bucket, { Status: 'Enabled' }));
  await D('K-15', 'WORKER', K, 'create another bucket', `${bucket}-k`, () => K.makeBucket(`${bucket}-k`));
  await D('K-16', 'WORKER', K, 'delete bucket', bucket, () => K.removeBucket(bucket));
  const kPut = await fetch(await K.presignedPutObject(bucket, sealedNew, 300), { method: 'PUT', body: 'redirected' });
  record(list, 'K-17', 'WORKER', 'use worker-signed presigned PUT on sealed key', sealedNew, 'DENY', { outcome: 'ERROR', code: `HTTP_${kPut.status}`, status: kPut.status }, kPut.status === 403);

  // ---- I-VERIFIER
  await A('V+1', 'VERIFIER', V, 'read staged object', stagedA, async () => { const s = await V.getObject(bucket, stagedA); for await (const c of s) void c; });
  check(list, 'V+2', 'VERIFIER', 'stat a missing sealed key (404, not 403)', `${SEALED_PREFIX}S0/absent`, 'NOT_FOUND', await attempt(() => V.statObject(bucket, `${SEALED_PREFIX}S0/absent`)));
  check(list, 'V+3', 'VERIFIER', 'stat a missing staging key (404, not 403)', 'direct-uploads/S0/absent', 'NOT_FOUND', await attempt(() => V.statObject(bucket, 'direct-uploads/S0/absent')));
  const copyConditions = new CopyConditions(); copyConditions.setMatchETag((await R.statObject(bucket, stagedA)).etag);
  await A('V+4', 'VERIFIER', V, 'conditional seal: copy staged -> sealed (ETag precondition)', `${SEALED_PREFIX}S0/sealed-copy`, () => V.copyObject(bucket, `${SEALED_PREFIX}S0/sealed-copy`, `/${bucket}/${stagedA}`, copyConditions));
  const wrongCondition = new CopyConditions(); wrongCondition.setMatchETag('00000000000000000000000000000000');
  const wrong = await attempt(() => V.copyObject(bucket, `${SEALED_PREFIX}S0/sealed-wrong`, `/${bucket}/${stagedA}`, wrongCondition));
  record(list, 'V+5', 'VERIFIER', 'conditional seal with a stale ETag is refused by the store (precondition)', `${SEALED_PREFIX}S0/sealed-wrong`, 'PRECONDITION', { outcome: wrong.outcome, code: wrong.code, status: wrong.status }, wrong.outcome === 'ERROR' && !isDenied(wrong));
  await A('V+6', 'VERIFIER', V, 'independent stat + read of the sealed copy', `${SEALED_PREFIX}S0/sealed-copy`, async () => { await V.statObject(bucket, `${SEALED_PREFIX}S0/sealed-copy`); const s = await V.getObject(bucket, `${SEALED_PREFIX}S0/sealed-copy`); for await (const c of s) void c; });
  await A('V+7', 'VERIFIER', V, 'delete sealed (owner GC)', `${SEALED_PREFIX}S0/sealed-copy`, () => removeOne(V, `${SEALED_PREFIX}S0/sealed-copy`));
  await R.putObject(bucket, 'direct-uploads/S0/v-del', Buffer.from('d'));
  await A('V+8', 'VERIFIER', V, 'delete staged object (post-seal cleanup)', 'direct-uploads/S0/v-del', () => removeOne(V, 'direct-uploads/S0/v-del'));
  await A('V+9', 'VERIFIER', V, 'multipart verbs on the sealed namespace (positive control for the W/K multipart denials)', `${SEALED_PREFIX}S0/mp-owner`, async () => { await rawRequest(V, 'GET', `${SEALED_PREFIX}S0/mp-owner`, `uploadId=${uploadId}`); });
  await D('V-1', 'VERIFIER', V, 'write staging (direct-uploads)', 'direct-uploads/S0/v-put', () => V.putObject(bucket, 'direct-uploads/S0/v-put', Buffer.from('x')));
  await D('V-2', 'VERIFIER', V, 'write staging (prepared-imports)', 'prepared-imports/S0/v-put', () => V.putObject(bucket, 'prepared-imports/S0/v-put', Buffer.from('x')));
  await D('V-3', 'VERIFIER', V, 'write other prefix', 'exports/S0/v-put', () => V.putObject(bucket, 'exports/S0/v-put', Buffer.from('x')));
  await D('V-4', 'VERIFIER', V, 'read other prefix', other, async () => { const s = await V.getObject(bucket, other); for await (const c of s) void c; });
  await D('V-5', 'VERIFIER', V, 'delete other prefix', other, () => removeOne(V, other));
  await D('V-6', 'VERIFIER', V, 'copy-to staging', 'direct-uploads/S0/v-copy', () => V.copyObject(bucket, 'direct-uploads/S0/v-copy', `/${bucket}/${stagedA}`));
  await D('V-7', 'VERIFIER', V, 'object tagging on sealed', sealed, () => V.setObjectTagging(bucket, sealed, tags));
  retentionCheck('V-8', 'VERIFIER', await attempt(() => V.putObjectRetention(bucket, sealed, retention)));
  await D('V-9', 'VERIFIER', V, 'bucket lifecycle write', bucket, () => V.setBucketLifecycle(bucket, lifecycleBody));
  await D('V-10', 'VERIFIER', V, 'bucket lifecycle read', bucket, () => V.getBucketLifecycle(bucket));
  await D('V-11', 'VERIFIER', V, 'bucket policy write', bucket, () => V.setBucketPolicy(bucket, JSON.stringify({ Version: '2012-10-17', Statement: [] })));
  await D('V-12', 'VERIFIER', V, 'bucket versioning write', bucket, () => V.setBucketVersioning(bucket, { Status: 'Enabled' }));
  await D('V-13', 'VERIFIER', V, 'create another bucket', `${bucket}-v`, () => V.makeBucket(`${bucket}-v`));
  await D('V-14', 'VERIFIER', V, 'delete bucket', bucket, () => V.removeBucket(bucket));
  await A('V+10', 'VERIFIER', V, 'abort the owner-created multipart upload', `${SEALED_PREFIX}S0/mp-owner`, () => V.abortMultipartUpload(bucket, `${SEALED_PREFIX}S0/mp-owner`, uploadId));

  // ---- root controls: the same operation kinds reach the store (denials above are authorization, not malformed requests)
  const controls = results.controls;
  check(controls, 'R+1', 'ROOT', 'tagging reaches the store', sealed, 'REACHED', await attempt(() => R.setObjectTagging(bucket, sealed, tags)));
  await attempt(() => R.removeObjectTagging(bucket, sealed, {}));
  check(controls, 'R+2', 'ROOT', 'retention reaches the store (not AccessDenied)', sealed, 'REACHED', await attempt(() => R.putObjectRetention(bucket, sealed, retention)));
  check(controls, 'R+3', 'ROOT', 'legal hold reaches the store (not AccessDenied)', sealed, 'REACHED', await attempt(() => rawRequest(R, 'PUT', sealed, 'legal-hold', '<LegalHold><Status>ON</Status></LegalHold>')));
  check(controls, 'R+4', 'ROOT', 'multipart list reaches the store', `${SEALED_PREFIX}S0/mp-absent`, 'REACHED', await attempt(() => rawRequest(R, 'GET', `${SEALED_PREFIX}S0/mp-absent`, 'uploadId=nope')));
  check(controls, 'R+5', 'ROOT', 'bucket administration works on a scratch bucket', scratch, 'ALLOW', await attempt(async () => { await R.makeBucket(scratch); await R.setBucketVersioning(scratch, { Status: 'Enabled' }); await R.setBucketLifecycle(scratch, lifecycleBody); await R.removeBucketLifecycle(scratch); await R.setBucketPolicy(scratch, JSON.stringify({ Version: '2012-10-17', Statement: [] })); await R.removeBucket(scratch); }));
  const after = await stat(R, sealed);
  record(list, 'INV-1', 'ALL', 'sealed object unchanged after the whole battery (etag/size/lastModified)', sealed, 'INVARIANT', { outcome: 'ALLOWED' }, JSON.stringify(after) === JSON.stringify(before));
  const content = await (async () => { const s = await R.getObject(bucket, sealed); let t = ''; for await (const c of s) t += c; return t; })();
  record(list, 'INV-2', 'ALL', 'sealed object content unchanged', sealed, 'INVARIANT', { outcome: 'ALLOWED' }, content === original);
  const keysAfter = await listKeys(R, '');
  const stray = keysAfter.filter(key => !keysBefore.includes(key) && !['direct-uploads/S0/post-ok'].includes(key));
  record(list, 'INV-3', 'ALL', 'no stray object created by a denied operation (key set equals the before-set plus the one authorized POST)', '*', 'INVARIANT', { outcome: 'ALLOWED' }, stray.length === 0);
  for (const key of ['direct-uploads/S0/post-ok']) await removeOne(R, key);
  return { sealedKey: sealed, before, after };
}

// ---------------------------------------------------------------------------------------------------------------- routing proof (real worker modules)
async function routingProof(ctx) {
  const { R, K, V } = ctx.clients;
  const ns = await import(join(ROOT, 'apps/worker/src/providers/sealed-namespace.ts'));
  const scanner = await import(join(ROOT, 'apps/worker/src/queue/minio-orphan-scanner.ts'));
  const list = results.battery;
  const seed = async keys => { for (const key of keys) await V.putObject(bucket, key, Buffer.from('gc')); };
  const exists = async key => { try { await R.statObject(bucket, key); return true; } catch { return false; } };
  const common = { db: {}, bucket, dryRun: false, gracePeriodMs: 0, referenceCheckers: [] };
  const routed = ns.routeSealedDeletes(K, V);
  const noOwner = ns.routeSealedDeletes(K, null);

  await seed([`${SEALED_PREFIX}S0/gc-a`]);
  await R.putObject(bucket, 'exports/S0/gc-general', Buffer.from('g'));
  const direct = await scanner.sweepUnreferencedObjects({ ...common, minio: K, prefix: `${SEALED_PREFIX}S0/gc-a` });
  record(list, 'RT-1', 'WORKER(plain)', 'scanner sweep with the plain general client cannot delete a sealed key (control: routing is what grants deletion)', `${SEALED_PREFIX}S0/gc-a`, 'DENY', { outcome: direct.failed.length ? 'ERROR' : 'ALLOWED', code: direct.failed[0]?.reason ?? null }, direct.deleted.length === 0 && direct.failed.length === 1 && await exists(`${SEALED_PREFIX}S0/gc-a`));
  const noOwnerRun = await scanner.sweepUnreferencedObjects({ ...common, minio: noOwner, prefix: `${SEALED_PREFIX}S0/gc-a` });
  record(list, 'RT-2', 'WORKER(routed, no owner)', 'no verifier credentials => sealed deletion fails closed (SEALED_OWNER_UNAVAILABLE), no fallback', `${SEALED_PREFIX}S0/gc-a`, 'DENY', { outcome: 'ERROR', code: noOwnerRun.failed[0]?.reason ?? null }, noOwnerRun.failed[0]?.reason === 'SEALED_OWNER_UNAVAILABLE' && await exists(`${SEALED_PREFIX}S0/gc-a`));
  const routedRun = await scanner.sweepUnreferencedObjects({ ...common, minio: routed, prefix: `${SEALED_PREFIX}S0/gc-a` });
  record(list, 'RT-3', 'WORKER(routed)', 'scanner sweep deletes the sealed key via the owner client chosen by key classification', `${SEALED_PREFIX}S0/gc-a`, 'ALLOW', { outcome: routedRun.deleted.length === 1 ? 'ALLOWED' : 'ERROR' }, routedRun.deleted.length === 1 && !(await exists(`${SEALED_PREFIX}S0/gc-a`)));
  await seed([`${SEALED_PREFIX}S0/gc-b`]);
  const single = await scanner.sweepSingleObject({ ...common, minio: routed, key: `${SEALED_PREFIX}S0/gc-b` });
  record(list, 'RT-4', 'WORKER(routed)', 'sweepSingleObject (deleted-asset cleanup shape) deletes a sealed key via the owner client', `${SEALED_PREFIX}S0/gc-b`, 'ALLOW', { outcome: single.deleted.length === 1 ? 'ALLOWED' : 'ERROR' }, single.deleted.length === 1 && !(await exists(`${SEALED_PREFIX}S0/gc-b`)));
  const general = await scanner.sweepSingleObject({ ...common, minio: routed, key: 'exports/S0/gc-general' });
  record(list, 'RT-5', 'WORKER(routed)', 'a non-sealed key is deleted with the general client (the owner is not used)', 'exports/S0/gc-general', 'ALLOW', { outcome: general.deleted.length === 1 ? 'ALLOWED' : 'ERROR' }, general.deleted.length === 1 && !(await exists('exports/S0/gc-general')));
  await R.putObject(bucket, 'Verified-Uploads/S0/lookalike', Buffer.from('l'));
  const lookalike = await scanner.sweepSingleObject({ ...common, minio: routed, key: 'Verified-Uploads/S0/lookalike' });
  record(list, 'RT-6', 'WORKER(routed)', 'a case-variant of the sealed prefix is INVALID: refused, never routed to a privileged client', 'Verified-Uploads/S0/lookalike', 'DENY', { outcome: 'ERROR', code: lookalike.failed[0]?.reason ?? null }, lookalike.failed[0]?.reason === 'STORAGE_KEY_INVALID' && await exists('Verified-Uploads/S0/lookalike'));
  await removeOne(R, 'Verified-Uploads/S0/lookalike');
  const config = { MINIO_ENDPOINT: `http://127.0.0.1:${ctx.port}`, MINIO_ACCESS_KEY: creds.worker.accessKey, MINIO_SECRET_KEY: creds.worker.secretKey, MINIO_BUCKET: bucket };
  const factory = ns.createRoutedWorkerMinio(config, { MINIO_VERIFIER_ACCESS_KEY: creds.verifier.accessKey, MINIO_VERIFIER_SECRET_KEY: creds.verifier.secretKey });
  await seed([`${SEALED_PREFIX}S0/gc-c`]);
  const viaFactory = await attempt(() => factory.removeObject(bucket, `${SEALED_PREFIX}S0/gc-c`));
  record(list, 'RT-7', 'WORKER(factory)', 'createRoutedWorkerMinio (bulk-delete/readiness wiring) routes a sealed delete to the owner built from MINIO_VERIFIER_*', `${SEALED_PREFIX}S0/gc-c`, 'ALLOW', viaFactory, viaFactory.outcome === 'ALLOWED' && !(await exists(`${SEALED_PREFIX}S0/gc-c`)));
  const factoryNoVerifier = ns.createRoutedWorkerMinio(config, {});
  await seed([`${SEALED_PREFIX}S0/gc-d`]);
  const noFallback = await attempt(() => factoryNoVerifier.removeObject(bucket, `${SEALED_PREFIX}S0/gc-d`));
  record(list, 'RT-8', 'WORKER(factory)', 'no MINIO_VERIFIER_* => no fallback to MINIO_*: sealed delete refused', `${SEALED_PREFIX}S0/gc-d`, 'DENY', noFallback, noFallback.code === 'SEALED_OWNER_UNAVAILABLE' && await exists(`${SEALED_PREFIX}S0/gc-d`));
  await removeOne(V, `${SEALED_PREFIX}S0/gc-d`);
  // credential/config boundary
  const partial = await attempt(async () => ns.readSealedOwnerCredentials({ MINIO_VERIFIER_ACCESS_KEY: 'only-one' }));
  const same = await attempt(async () => ns.createSealedOwnerMinio({ ...config, MINIO_ACCESS_KEY: 'same-key' }, { MINIO_VERIFIER_ACCESS_KEY: 'same-key', MINIO_VERIFIER_SECRET_KEY: 'x'.repeat(12) }));
  const absent = await attempt(async () => ns.assertSealedOwnerReady(config, {}));
  record(list, 'CFG-1', 'WORKER', 'only one of MINIO_VERIFIER_ACCESS_KEY/SECRET_KEY set => error', '-', 'DENY', partial, partial.code === 'SEALED_OWNER_CREDENTIALS_PARTIAL');
  record(list, 'CFG-2', 'WORKER', 'verifier identical to the general identity => rejected (not distinct)', '-', 'DENY', same, same.code === 'SEALED_OWNER_NOT_DISTINCT');
  record(list, 'CFG-3', 'WORKER', 'A2 readiness with no verifier identity fails closed', '-', 'DENY', absent, absent.code === 'SEALED_OWNER_UNAVAILABLE');
  const secretLeak = JSON.stringify([partial, same, absent]);
  record(list, 'CFG-4', 'WORKER', 'configuration errors never contain a secret', '-', 'INVARIANT', { outcome: 'ALLOWED' }, !secrets.some(secret => secretLeak.includes(secret)));
}

// ---------------------------------------------------------------------------------------------------------------- startup/readiness without admin authority
async function readinessProof(ctx, phase) {
  const { R, W, K, V } = ctx.clients;
  const minioModule = await import(join(ROOT, 'apps/worker/src/providers/minio.ts'));
  const ns = await import(join(ROOT, 'apps/worker/src/providers/sealed-namespace.ts'));
  const list = results.battery;
  if (phase === 'provisioned') {
    check(list, 'RD-1', 'WORKER', 'real startup probe (probeMinioProvisioning) succeeds with no admin authority on the provisioned bucket', bucket, 'ALLOW', await attempt(() => minioModule.probeMinioProvisioning(K, bucket, 7, {})));
    check(list, 'RD-2', 'WORKER', 'ensureBucket (export job path) is verify-only and succeeds', bucket, 'ALLOW', await attempt(() => minioModule.ensureBucket(K, bucket)));
    check(list, 'RD-3', 'WORKER', 'non-owner identity passes the sealed-write readiness probe (AccessDenied observed)', bucket, 'ALLOW', await attempt(() => ns.assertNoSealedWriteAuthority(K, bucket)));
    check(list, 'RD-4', 'WEB', 'web identity passes the same sealed-write readiness probe', bucket, 'ALLOW', await attempt(() => ns.assertNoSealedWriteAuthority(W, bucket)));
    const rootProbe = await attempt(() => ns.assertNoSealedWriteAuthority(R, bucket));
    record(list, 'RD-5', 'ROOT(control)', 'a root/shared credential FAILS the sealed-write readiness probe closed', bucket, 'DENY', { outcome: 'ERROR', code: rootProbe.code }, rootProbe.code === 'SEALED_NAMESPACE_WRITABLE');
    await V.removeObjects(bucket, (await listKeys(R, `${SEALED_PREFIX}.authority-probe/`))).catch(() => undefined);
  } else {
    const miss = await attempt(() => minioModule.probeMinioProvisioning(K, bucket, 7, {}));
    record(list, 'RD-6', 'WORKER', 'missing bucket fails closed (MINIO_BUCKET_NOT_PROVISIONED), no creation', bucket, 'DENY', miss, miss.code === 'MINIO_BUCKET_NOT_PROVISIONED');
    const legacy = await attempt(() => minioModule.probeMinioProvisioning(K, bucket, 7, { MINIO_LEGACY_APP_ADMIN: '1' }));
    check(list, 'RD-7', 'WORKER', 'even legacy bootstrap cannot create the bucket without admin authority', bucket, 'DENY', legacy);
    const exists = await attempt(() => R.bucketExists(bucket));
    record(list, 'RD-8', 'ROOT', 'bucket still absent after both attempts', bucket, 'INVARIANT', { outcome: 'ALLOWED' }, exists.value === false);
  }
}

// ---------------------------------------------------------------------------------------------------------------- main
async function main() {
  const expectedPolicies = Object.fromEntries(ROLES.map(role => [role, renderPolicy(artifacts.text[role], bucket)]));
  const expected = { policies: expectedPolicies, accessKeys: { web: creds.web.accessKey, worker: creds.worker.accessKey, verifier: creds.verifier.accessKey }, lifecycle: JSON.parse(artifacts.text.lifecycle) };
  const evidence = { schema: 'phase029-s0-storage-authority-receipt/v1', mode, runId, startedAt: new Date().toISOString() };
  const ctx = { network: null, clients: null, port: 0 };
  let failure = null;
  try {
    await step('preflight', async () => {
      must(docker(['version', '--format', '{{.Server.Version}}']).status === 0, 'S0_DOCKER_UNAVAILABLE');
      const problems = checkImagePins(frozen, { authoritative });
      must(problems.length === 0, 'S0_IMAGE_PIN_REFUSED', problems);
      const mcImage = inspectImage(mcReference(frozen)), minioImage = inspectImage(minioReference(frozen));
      must(mcImage.repoDigests.some(d => d.endsWith(`@${frozen.mc.digest}`)) || mcImage.id === frozen.mc.digest, 'S0_MC_DIGEST_MISMATCH', mcImage);
      must(minioImage.repoDigests.some(d => d.endsWith(`@${frozen.minio.digest}`)) || minioImage.id === frozen.minio.digest, 'S0_MINIO_DIGEST_MISMATCH', minioImage);
      const version = docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...LABELS, mcReference(frozen), '--version']).stdout;
      must(version.includes(frozen.mc.version), 'S0_MC_VERSION_MISMATCH', version.split('\n')[0]);
      evidence.images = { mc: { ...mcImage, version: version.split('\n')[0], frozenVersion: frozen.mc.version }, minio: { ...minioImage, tag: frozen.minio.tag }, frozenByOwner: frozen.frozen === true, candidateNote: frozen.note };
      for (const role of ROLES) { const problemsForRole = analyzePolicy(role, expectedPolicies[role], bucket); must(problemsForRole.length === 0, 'S0_POLICY_STATIC_REVIEW_FAILED', { role, problemsForRole }); }
      evidence.policyStaticReview = Object.fromEntries(ROLES.map(role => [role, { problems: [], policyDigest: sha256(JSON.stringify(expectedPolicies[role])) }]));
    });
    evidence.artifactHashes = artifacts.hashes;
    await step('create-infrastructure', async () => {
      const net = docker(['network', 'create', '--internal', ...LABELS, `a2s0-${runId}-net`]);
      must(net.status === 0, 'S0_NETWORK_FAILED', net.stderr);
      ctx.network = { id: net.stdout.trim(), name: `a2s0-${runId}-net` }; created.networks.push(ctx.network);
      const run = docker(['run', '-d', '--name', `a2s0-${runId}-minio`, ...LABELS, '-p', '127.0.0.1::9000', '--memory', '512m', '--pids-limit', '512', '-e', 'MINIO_ROOT_USER', '-e', 'MINIO_ROOT_PASSWORD', minioReference(frozen), 'server', '/data'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, MINIO_ROOT_USER: creds.root.accessKey, MINIO_ROOT_PASSWORD: creds.root.secretKey } });
      must(run.status === 0, 'S0_MINIO_START_FAILED', run.stderr.slice(0, 300));
      const id = run.stdout.trim(); created.containers.push({ role: 'minio', id, name: `a2s0-${runId}-minio` });
      ctx.port = Number(docker(['port', id, '9000/tcp']).stdout.trim().split(':').pop());
      must(docker(['network', 'connect', '--alias', 'minio', ctx.network.id, id]).status === 0, 'S0_NETWORK_CONNECT_FAILED');
      const volumes = JSON.parse(docker(['inspect', id]).stdout)[0].Mounts.filter(m => m.Type === 'volume').map(m => m.Name); created.volumes.push(...volumes);
      await waitHealthy(ctx.port);
      ctx.mcRef = mcReference(frozen);
      ctx.clients = { R: mk(ctx.port, creds.root), W: mk(ctx.port, creds.web), K: mk(ctx.port, creds.worker), V: mk(ctx.port, creds.verifier) };
      evidence.network = { id: ctx.network.id, internal: JSON.parse(docker(['network', 'inspect', ctx.network.id]).stdout)[0].Internal, name: ctx.network.name };
    });
    must(evidence.network.internal === true, 'S0_NETWORK_NOT_INTERNAL');
    const snapshots = {};
    const provision = label => { const r = runMc(ctx, label, artifacts.text.provision); must(r.exit === 0 && r.output.includes('S0_PROVISION_OK'), 'S0_PROVISION_FAILED', r.output.slice(-400)); return r; };
    const snap = label => { const r = runMc(ctx, label, artifacts.text.snapshot); const parsed = parseSnapshot(r.output); must(r.exit === 0 && parsed.ok, 'S0_SNAPSHOT_FAILED', r.output.slice(-400)); return parsed; };
    await step('provision-1', async () => { provision('p1'); });
    await step('snapshot-verify-1', async () => { snapshots.first = snap('s1'); const problems = verifySnapshot(snapshots.first, expected); must(problems.length === 0, 'S0_SNAPSHOT_VERIFY_FAILED', problems); evidence.snapshotDigest1 = snapshotDigest(snapshots.first); evidence.lifecycleProvisioned = snapshots.first.lifecycle; });
    await step('battery', async () => { evidence.battery = await battery(ctx); });
    await step('routing-proof', async () => { await routingProof(ctx); });
    await step('readiness-provisioned', async () => { await readinessProof(ctx, 'provisioned'); });
    await step('mutation-controls', async () => {
      const mc = results.controls;
      // m1: a wrong (over-broad) web policy must be DETECTED by verification and must make the battery's denial FAIL (tests are not vacuous); replay restores.
      const bad = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:*'], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`] }] });
      const m1 = runMc(ctx, 'm1', `export MC_CONFIG_DIR=/tmp/.mc HOME=/tmp; printf '%s' "$S0_BAD" > /tmp/bad.json; mc admin policy create local a2-s0-web /tmp/bad.json && echo S0_MUTATE_OK`, { S0_BAD: bad });
      must(m1.output.includes('S0_MUTATE_OK'), 'S0_MUTATION_FAILED', m1.output.slice(-200));
      const detected = verifySnapshot(snap('s-m1'), expected);
      const overwrite = await attempt(() => ctx.clients.W.putObject(bucket, `${SEALED_PREFIX}S0/m1-probe`, Buffer.from('x')));
      record(mc, 'M1a', 'WEB(wrong policy)', 'verification detects the over-broad web policy (fail closed)', 'policy', 'DETECT', { outcome: detected.includes('POLICY_MISMATCH:web') ? 'ERROR' : 'ALLOWED', code: detected.join(',') }, detected.includes('POLICY_MISMATCH:web'));
      record(mc, 'M1b', 'WEB(wrong policy)', 'with the wrong policy the sealed-write DENIAL FAILS (the battery would catch it: tests are not vacuous)', `${SEALED_PREFIX}S0/m1-probe`, 'ALLOWED_UNDER_WRONG_POLICY', overwrite, overwrite.outcome === 'ALLOWED');
      await attempt(() => removeOne(ctx.clients.R, `${SEALED_PREFIX}S0/m1-probe`));
      // m2: detached verifier policy => detection; the identity loses authority rather than gaining it.
      const m2 = runMc(ctx, 'm2', `export MC_CONFIG_DIR=/tmp/.mc HOME=/tmp; mc admin policy detach local a2-s0-verifier --user "$S0_VERIFIER_KEY" && echo S0_MUTATE_OK`);
      must(m2.output.includes('S0_MUTATE_OK'), 'S0_MUTATION_FAILED', m2.output.slice(-200));
      const detected2 = verifySnapshot(snap('s-m2'), expected);
      const lost = await attempt(() => ctx.clients.V.putObject(bucket, `${SEALED_PREFIX}S0/m2-probe`, Buffer.from('x')));
      record(mc, 'M2a', 'VERIFIER(detached)', 'verification detects the missing policy attachment', 'attachment', 'DETECT', { outcome: 'ERROR', code: detected2.join(',') }, detected2.includes('USER_POLICY_ATTACHMENT_WRONG:verifier'));
      record(mc, 'M2b', 'VERIFIER(detached)', 'a missing policy fails closed: the owner can no longer write the sealed namespace', `${SEALED_PREFIX}S0/m2-probe`, 'DENY', lost, isDenied(lost));
      // replay restores everything
      provision('p-restore');
      const restored = snap('s-restore'); const problems = verifySnapshot(restored, expected);
      record(mc, 'M3a', 'ALL', 'provisioning replay restores the exact intended state (verification clean)', 'snapshot', 'REPLAY', { outcome: problems.length ? 'ERROR' : 'ALLOWED', code: problems.join(',') }, problems.length === 0);
      const again = await attempt(() => ctx.clients.W.putObject(bucket, `${SEALED_PREFIX}S0/m1-probe`, Buffer.from('x')));
      record(mc, 'M3b', 'WEB', 'after replay the web identity is denied on the sealed namespace again', `${SEALED_PREFIX}S0/m1-probe`, 'DENY', again, isDenied(again));
      const ok = await attempt(() => ctx.clients.V.putObject(bucket, `${SEALED_PREFIX}S0/m2-probe`, Buffer.from('x')));
      record(mc, 'M3c', 'VERIFIER', 'after replay the owner can write the sealed namespace again', `${SEALED_PREFIX}S0/m2-probe`, 'ALLOW', ok, ok.outcome === 'ALLOWED');
      await attempt(() => removeOne(ctx.clients.V, `${SEALED_PREFIX}S0/m2-probe`));
    });
    await step('replay-idempotency', async () => {
      provision('p2');
      snapshots.second = snap('s2');
      must(verifySnapshot(snapshots.second, expected).length === 0, 'S0_REPLAY_VERIFY_FAILED');
      evidence.snapshotDigest2 = snapshotDigest(snapshots.second);
      evidence.replayIdempotent = evidence.snapshotDigest1 === evidence.snapshotDigest2;
      must(evidence.replayIdempotent, 'S0_REPLAY_NOT_IDEMPOTENT');
    });
    await step('bucket-missing-fail-closed', async () => {
      const { R } = ctx.clients;
      const keys = await listKeys(R, ''); if (keys.length) await R.removeObjects(bucket, keys);
      await R.removeBucket(bucket);
      await readinessProof(ctx, 'missing');
      provision('p3');
      const restored = verifySnapshot(snap('s3'), expected); must(restored.length === 0, 'S0_REPROVISION_AFTER_LOSS_FAILED', restored);
      check(results.battery, 'RD-9', 'WORKER', 'startup probe succeeds again after re-provisioning (no admin authority needed)', bucket, 'ALLOW', await attempt(() => import(join(ROOT, 'apps/worker/src/providers/minio.ts')).then(m => m.probeMinioProvisioning(ctx.clients.K, bucket, 7, {}))));
    });
    await step('static-audit', async () => {
      const report = buildReport(); const result = compareAudit(report, loadAllowlist());
      evidence.audit = { ok: result.ok, differences: result.differences, sites: report.sites.length, webIndirect: report.webIndirect, verifierEnvModules: report.verifierEnvModules };
      must(result.ok, 'S0_STATIC_AUDIT_FAILED', result.differences);
      must(report.webIndirect.includes('apps/worker/src/queue/minio-orphan-scanner.ts'), 'S0_AUDIT_MISSED_INDIRECT_PATH');
    });
  } catch (error) { failure = { code: error.message, detail: error.detail ?? null }; }
  // ---- teardown always runs
  const teardown = { identitiesPoliciesRemoved: null, objectsRemoved: null, containersRemoved: [], networksRemoved: [], volumesRemoved: [] };
  try {
    if (ctx.network && ctx.clients) {
      const { R } = ctx.clients;
      try { const keys = await listKeys(R, ''); if (keys.length) await R.removeObjects(bucket, keys); teardown.objectsRemoved = (await listKeys(R, '')).length === 0; } catch { teardown.objectsRemoved = 'bucket-absent'; }
      for (const name of [scratch]) await attempt(() => R.removeBucket(name));
      const r = runMc(ctx, 'down', artifacts.text.deprovision);
      const listing = r.output.split('\n').filter(line => line.startsWith('USERS ') || line.startsWith('POLICIES ')).join('\n');
      teardown.listingAfterRemoval = { usersLineSeen: /^USERS /m.test(listing), policiesLineSeen: /^POLICIES /m.test(listing) };
      teardown.identitiesPoliciesRemoved = r.exit === 0 && r.output.includes('S0_DEPROVISION_OK') && teardown.listingAfterRemoval.usersLineSeen && teardown.listingAfterRemoval.policiesLineSeen
        && !ROLES.some(role => listing.includes(POLICY_NAME(role))) && ![creds.web, creds.worker, creds.verifier].some(entry => listing.includes(entry.accessKey));
      teardown.deprovisionExit = r.exit;
    }
  } catch (error) { teardown.error = error.message; }
  for (const container of created.containers) { const r = docker(['rm', '-fv', container.id]); teardown.containersRemoved.push({ id: container.id, role: container.role, removed: r.status === 0 || /No such container/.test(r.stderr) }); }
  for (const network of created.networks) { const r = docker(['network', 'rm', network.id]); teardown.networksRemoved.push({ id: network.id, removed: r.status === 0 || /not found/.test(r.stderr) }); }
  for (const volume of created.volumes) { const r = docker(['volume', 'rm', '-f', volume]); teardown.volumesRemoved.push({ name: volume, removed: r.status === 0 || /No such volume/.test(r.stderr) }); }

  // ---- evidence
  const allResults = [...results.battery, ...results.controls];
  const outDir = resolve(outArg ?? join(ROOT, 'specs/029-modality-specific-datasets/verification/s0-storage-authority', `${mode.toLowerCase()}-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-${runId}`));
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const idsFile = join(outDir, 's0-ids.json');
  const write = (name, value) => { const text = JSON.stringify(value, null, 2) + '\n'; assertNoSecrets(text, secrets); const path = join(outDir, name); writeFileSync(path, text, { mode: 0o400, flag: 'wx' }); chmodSync(path, 0o400); return path; };
  write('s0-ids.json', { runId, containers: created.containers, networks: created.networks, volumes: created.volumes });
  const verify = sh(process.execPath, [join(ROOT, 'scripts/db-safety/minio-authority-verify.mjs'), idsFile]);
  let independent; try { independent = JSON.parse(verify.stdout); } catch { independent = { ok: false, raw: verify.stdout.slice(0, 200) }; }
  const failed = allResults.filter(entry => !entry.pass).map(entry => entry.id);
  const final = {
    ...evidence, finishedAt: new Date().toISOString(), result: failure || failed.length || !independent.ok || teardown.identitiesPoliciesRemoved !== true ? 'FAIL' : 'PASS',
    classification: authoritative && frozen.frozen === true ? 'AUTHORITATIVE' : 'REHEARSAL — NOT AUTHORITATIVE (image digests not frozen by the release owner or --authoritative not requested)',
    failure, counts: { tests: allResults.length, passed: allResults.length - failed.length, failed: failed.length, failedIds: failed },
    teardown, independentVerification: independent, steps: results.steps,
    boundaries: { sharedDevTouched: false, applicationDatabaseTouched: false, g3g5Touched: false, m24m25Touched: false, rootCredentialGivenToApplicationIdentity: false },
  };
  write('battery.json', { battery: results.battery, controls: results.controls });
  write('s0-receipt.json', final);
  console.log(JSON.stringify({ result: final.result, classification: final.classification, outDir, counts: final.counts, failure, replayIdempotent: evidence.replayIdempotent ?? null, audit: evidence.audit?.ok ?? null, independentVerification: independent.ok }, null, 2));
  process.exitCode = final.result === 'PASS' ? 0 : 1;
}
await main();
