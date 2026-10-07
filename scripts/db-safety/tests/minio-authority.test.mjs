import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWED_ACTIONS, SEALED_DENY_ACTIONS, analyzePolicy, assertNoSecrets, checkImagePins, loadArtifacts, mcReference, normalizePolicy, parseSnapshot, policyDigest, newSecretKey, randomCredentials, renderPolicy, snapshotDigest, verifySnapshot, ROLES, POLICY_NAME,
} from '../minio-authority.mjs';
import { buildReport, compareAudit, findSites, loadAllowlist, webReachableMutatingModules } from '../minio-write-audit.mjs';

// A2 / R9-M1 S0, offline: policy review, snapshot verification (missing/wrong policy fails closed), image-pin rules, secret handling and the static
// MinIO write-site audit. The real-MinIO proofs are in minio-authority-s0.mjs (rehearsal/authoritative runs).
const artifacts = loadArtifacts();
const BUCKET = 'a2s0-test';
const rendered = Object.fromEntries(ROLES.map(role => [role, renderPolicy(artifacts.text[role], BUCKET)]));
const clone = value => JSON.parse(JSON.stringify(value));

test('provisioning artifacts are pinned by hash (any edit must be deliberate and reviewed)', () => {
  assert.deepEqual(Object.keys(artifacts.hashes).sort(), ['deprovision.sh', 'frozen-images.json', 'lifecycle.json', 'policy-verifier.json', 'policy-web.json', 'policy-worker.json', 'provision.sh', 'snapshot.sh']);
  for (const hash of Object.values(artifacts.hashes)) assert.match(hash, /^[0-9a-f]{64}$/);
  // the three IAM policies and the lifecycle are the reviewed ones; their digests are asserted here so drift fails the suite
  assert.equal(policyDigest(rendered.web).length, 64);
  assert.equal(new Set(ROLES.map(role => policyDigest(rendered[role]))).size, 3, 'three distinct policies');
});

test('every rendered policy passes the static least-privilege review; no role holds bucket administration or lifecycle authority', () => {
  for (const role of ROLES) assert.deepEqual(analyzePolicy(role, rendered[role], BUCKET), [], role);
  for (const role of ROLES) for (const statement of normalizePolicy(rendered[role]).Statement) if (statement.Effect === 'Allow') {
    for (const action of statement.Action) {
      assert.ok(ALLOWED_ACTIONS[role].includes(action), `${role}: ${action}`);
      assert.doesNotMatch(action, /Bucket(Policy|Versioning|Tagging|Cors)|Lifecycle|CreateBucket|DeleteBucket|\*/, `${role}: ${action}`);
    }
    for (const resource of statement.Resource) assert.ok(resource.startsWith(`arn:aws:s3:::${BUCKET}`), resource);
  }
  const web = normalizePolicy(rendered.web).Statement, worker = normalizePolicy(rendered.worker).Statement;
  const sealed = `arn:aws:s3:::${BUCKET}/verified-uploads/*`;
  for (const statements of [web, worker]) {
    const deny = statements.find(statement => statement.Effect === 'Deny' && statement.Resource.includes(sealed));
    assert.deepEqual(deny.Action, [...SEALED_DENY_ACTIONS].sort());
    assert.ok(deny.Action.includes('s3:ListMultipartUploadParts'), 'discovered in the first rehearsal: the broad worker allow granted it');
  }
  const webWrite = web.find(statement => statement.Effect === 'Allow' && statement.Action.includes('s3:PutObject'));
  assert.deepEqual(webWrite.Resource, [`arn:aws:s3:::${BUCKET}/direct-uploads/*`, `arn:aws:s3:::${BUCKET}/prepared-imports/*`]);
});

test('the static review rejects each kind of defective policy (the review is not vacuous)', () => {
  const mutate = (role, change) => { const policy = clone(rendered[role]); change(policy); return analyzePolicy(role, policy, BUCKET); };
  assert.ok(mutate('web', policy => { policy.Statement = policy.Statement.filter(statement => statement.Effect !== 'Deny'); }).some(problem => problem.startsWith('SEALED_DENY_MISSING')));
  assert.ok(mutate('worker', policy => { policy.Statement.find(statement => statement.Effect === 'Deny').Action = ['s3:PutObject']; }).some(problem => problem === 'SEALED_DENY_MISSING:s3:DeleteObject'));
  assert.ok(mutate('web', policy => { policy.Statement[0].Action.push('s3:*'); }).some(problem => problem.includes('s3:*')));
  assert.ok(mutate('web', policy => { policy.Statement.find(statement => statement.Sid === 'StagingWrite').Resource.push('arn:aws:s3:::a2s0-test/exports/*'); }).some(problem => problem.startsWith('WEB_WRITE_OUTSIDE_STAGING')));
  assert.ok(mutate('worker', policy => { policy.Statement.push({ Effect: 'Allow', Action: ['s3:PutLifecycleConfiguration'], Resource: ['arn:aws:s3:::a2s0-test'] }); }).some(problem => problem.includes('PutLifecycleConfiguration')));
  assert.ok(mutate('worker', policy => { policy.Statement.push({ Effect: 'Allow', Action: ['s3:CreateBucket'], Resource: ['*'] }); }).some(problem => problem.includes('CreateBucket')));
  assert.ok(mutate('verifier', policy => { policy.Statement.find(statement => statement.Sid === 'SealedOwner').Resource.push('arn:aws:s3:::a2s0-test/exports/*'); }).includes('VERIFIER_WRITE_OUTSIDE_SEALED'));
  assert.ok(mutate('verifier', policy => { policy.Statement.find(statement => statement.Sid === 'StagingCleanup').Resource.push('arn:aws:s3:::a2s0-test/exports/*'); }).includes('VERIFIER_DELETE_OUTSIDE_SEALED_AND_STAGING'));
  assert.ok(mutate('verifier', policy => { policy.Statement = policy.Statement.filter(statement => statement.Sid !== 'DenyStagingWrite'); }).includes('VERIFIER_STAGING_PUT_DENY_MISSING'));
  assert.throws(() => renderPolicy('{"a":"__BUCKET__"}', 'Bad Bucket!'), /S0_BUCKET_NAME_INVALID/);
});

function fakeSnapshot(over = {}) {
  const creds = randomCredentials();
  const expected = { policies: rendered, accessKeys: { web: creds.web.accessKey, worker: creds.worker.accessKey, verifier: creds.verifier.accessKey }, lifecycle: JSON.parse(artifacts.text.lifecycle) };
  const snapshot = {
    policies: Object.fromEntries(ROLES.map(role => [role, clone(rendered[role])])),
    users: Object.fromEntries(ROLES.map(role => [role, { policyName: POLICY_NAME(role), userStatus: 'enabled', accessKey: expected.accessKeys[role] }])),
    lifecycle: { Rules: [{ ID: 'annotationplatform-expire-direct-uploads', Status: 'Enabled', Filter: { Prefix: 'direct-uploads/' }, Expiration: { Days: 7 } }] }, ...over,
  };
  return { snapshot, expected };
}
test('snapshot verification: the intended state is clean; every missing or wrong element fails closed', () => {
  const { snapshot, expected } = fakeSnapshot();
  assert.deepEqual(verifySnapshot(snapshot, expected), []);
  const variants = [
    ['POLICY_MISSING:web', s => { delete s.policies.web; }],
    ['POLICY_MISMATCH:web', s => { s.policies.web.Statement = s.policies.web.Statement.filter(x => x.Effect !== 'Deny'); }],
    ['POLICY_MISMATCH:verifier', s => { s.policies.verifier.Statement[0].Action.push('s3:PutObject'); }],
    ['USER_MISSING:worker', s => { delete s.users.worker; }],
    ['USER_POLICY_ATTACHMENT_WRONG:verifier', s => { s.users.verifier.policyName = ''; }],
    ['USER_POLICY_ATTACHMENT_WRONG:web', s => { s.users.web.policyName = POLICY_NAME('verifier'); }],
    ['USER_DISABLED:web', s => { s.users.web.userStatus = 'disabled'; }],
    ['USER_KEY_MISMATCH:worker', s => { s.users.worker.accessKey = 'someone-else'; }],
    ['LIFECYCLE_RULE_COUNT_MISMATCH', s => { s.lifecycle.Rules = []; }],
    ['LIFECYCLE_RULE_WRONG:annotationplatform-expire-direct-uploads', s => { s.lifecycle.Rules[0].Filter.Prefix = 'prepared-imports/'; }],
    ['LIFECYCLE_TOUCHES_SEALED_OR_WHOLE_BUCKET', s => { s.lifecycle.Rules.push({ ID: 'x', Status: 'Enabled', Filter: { Prefix: 'verified-uploads/' }, Expiration: { Days: 1 } }); }],
    ['LIFECYCLE_TOUCHES_SEALED_OR_WHOLE_BUCKET', s => { s.lifecycle.Rules[0].Filter.Prefix = ''; }],
  ];
  for (const [expectedProblem, change] of variants) { const { snapshot: s, expected: e } = fakeSnapshot(); change(s); assert.ok(verifySnapshot(s, e).includes(expectedProblem), expectedProblem); }
  const a = fakeSnapshot(), b = fakeSnapshot();
  assert.equal(snapshotDigest({ ...a.snapshot, users: Object.fromEntries(ROLES.map(role => [role, { ...a.snapshot.users[role], accessKey: 'k' }])) }), snapshotDigest({ ...b.snapshot, users: Object.fromEntries(ROLES.map(role => [role, { ...b.snapshot.users[role], accessKey: 'k' }])) }), 'snapshot digest is order/format insensitive');
});

test('mc output parsing tolerates the real line formats and never needs a secret', () => {
  const text = [
    `POLICY web ${JSON.stringify({ status: 'success', policy: 'a2-s0-web', policyInfo: { PolicyName: 'a2-s0-web', Policy: rendered.web } })}`,
    `USER web ${JSON.stringify({ status: 'success', accessKey: 'k1', policyName: 'a2-s0-web', userStatus: 'enabled' })}`,
    `LIFECYCLE ${JSON.stringify({ Rules: [] })}`, 'BUCKETS {}', 'S0_SNAPSHOT_OK',
  ].join('\n');
  const parsed = parseSnapshot(text);
  assert.equal(parsed.ok, true); assert.equal(policyDigest(parsed.policies.web), policyDigest(rendered.web)); assert.equal(parsed.users.web.policyName, 'a2-s0-web');
});

test('image pins: floating tags and unfrozen digests are never authoritative; the candidate digests are well-formed', () => {
  const frozen = JSON.parse(artifacts.text.frozen);
  assert.equal(frozen.frozen, true, 'frozen by the release owner 2026-10-06 (Decision 1)');
  assert.deepEqual(checkImagePins(frozen, { authoritative: false }), []);
  assert.deepEqual(checkImagePins(frozen, { authoritative: true }), []);
  assert.deepEqual(checkImagePins({ ...frozen, frozen: false }, { authoritative: true }), ['IMAGES_NOT_FROZEN_BY_OWNER'], 'an unfrozen pin set is never authoritative');
  assert.ok(checkImagePins({ ...frozen, mc: { ...frozen.mc, digest: 'latest' } }, { authoritative: false }).includes('MC_DIGEST_INVALID'));
  assert.ok(checkImagePins({ ...frozen, mc: { ...frozen.mc, repository: 'minio/mc:latest' } }, { authoritative: false }).includes('FLOATING_TAG'));
  assert.match(mcReference(frozen), /^minio\/mc@sha256:[0-9a-f]{64}$/);
  for (const file of ['minio-authority-s0.mjs', 'minio-authority.mjs']) assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /minio\/mc:latest|minio\/minio:latest|:latest['"`]/, file);
});

test('secrets: generated per run, scanned out of evidence, never placed on a command line, never printed by the provisioning scripts', () => {
  const credentials = randomCredentials();
  assert.notEqual(credentials.web.secretKey, credentials.worker.secretKey);
  assert.throws(() => assertNoSecrets(`token ${credentials.web.secretKey}`, [credentials.web.secretKey]), /S0_SECRET_IN_OUTPUT/);
  assertNoSecrets('clean', [credentials.web.secretKey]);
  for (const name of ['provision.sh', 'snapshot.sh', 'deprovision.sh']) {
    const text = artifacts.text[name.replace('.sh', '')].split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
    assert.doesNotMatch(text, /echo[^\n]*\$S0_\w*SECRET/i, name);
    assert.doesNotMatch(text, /\b(sed|grep|awk)\b/, `${name}: the pinned mc image has no sed/grep/awk`);
  }
  const supervisor = readFileSync(new URL('../minio-authority-s0.mjs', import.meta.url), 'utf8');
  assert.match(supervisor, /flatMap\(key => \['-e', key\]\)/, 'secrets reach containers by NAME');
  assert.doesNotMatch(supervisor, /--env-file/);
});

test('supervisor safety: disposable-only, hardened mc container, internal network, exact-id cleanup, independent verification', () => {
  const supervisor = readFileSync(new URL('../minio-authority-s0.mjs', import.meta.url), 'utf8');
  for (const needle of ["'--read-only'", "'--cap-drop', 'ALL'", "'no-new-privileges'", "'--internal'", "'--pids-limit'", "'rm', '-fv'", 'minio-authority-verify.mjs', 'IMAGES_NOT_FROZEN_BY_OWNER'.length ? 'checkImagePins' : '']) assert.ok(supervisor.includes(needle), needle);
  assert.doesNotMatch(supervisor, /\b5433\b|55470|55472|DATABASE_URL|--env-file|['"`]\.env/, 'never references the application stack');
});

// ---------------------------------------------------------------------------------------------------------------- static write-site audit
function fixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'minio-audit-'));
  for (const [path, text] of Object.entries(files)) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, text); }
  return root;
}
test('audit: the repository equals the committed allowlist (a new write site, a removed site or a new web-reachable mutation fails)', () => {
  const result = compareAudit(buildReport(), loadAllowlist());
  assert.deepEqual(result.differences, []);
  const report = buildReport();
  assert.deepEqual(report.webIndirect, ['apps/worker/src/queue/minio-orphan-scanner.ts'], 'the web → worker cleanup import is found');
  assert.deepEqual(report.verifierEnvModules, ['apps/worker/src/providers/sealed-namespace.ts'], 'MINIO_VERIFIER_* is referenced by exactly one module');
  const web = report.sites.filter(site => site.file.startsWith('apps/web/src/'));
  assert.deepEqual(web.map(site => `${site.file}|${site.method}`).sort(), ['apps/web/src/app/api/assets/presigned-upload/route.ts|presignedPostPolicy', 'apps/web/src/lib/asset-upload.ts|removeObject', 'apps/web/src/lib/imports/local-folder-upload.ts|presignedPostPolicy']);
  // mutation: a changed allowlist is detected in both directions
  const allowlist = loadAllowlist();
  const extra = { ...allowlist, sites: allowlist.sites.slice(1) };
  assert.ok(compareAudit(report, extra).differences.some(d => d.kind === 'UNCLASSIFIED_SITE'));
  const phantom = { ...allowlist, sites: [...allowlist.sites, { file: 'apps/web/src/nope.ts', method: 'putObject', count: 1 }] };
  assert.ok(compareAudit(report, phantom).differences.some(d => d.kind === 'ALLOWLIST_ENTRY_NOT_FOUND'));
});

test('audit: direct, relative-import, alias-import and transitive web paths to a mutation are all discovered; comments do not count; tests are ignored', () => {
  const root = fixtureRepo({
    'apps/web/src/lib/direct.ts': 'export const f = (m: any) => m.putObject("b","k",x);\n',
    'apps/web/src/lib/comment.ts': '// m.removeObject("b","k")\n/* m.copyObject() */\nexport const ok = 1;\n',
    'apps/web/src/lib/entry.ts': 'import { cleanup } from "@/lib/hop";\nexport const run = cleanup;\n',
    'apps/web/src/lib/hop.ts': 'import { sweep } from "../../../worker/src/queue/sweeper.js";\nexport const cleanup = sweep;\n',
    'apps/worker/src/queue/sweeper.ts': 'export const sweep = (m: any) => m.removeObject("b","k");\n',
    'apps/worker/src/queue/unrelated.ts': 'export const other = (m: any) => m.removeObjects("b", []);\n',
    'apps/web/src/lib/thing.test.ts': 'm.putObject("b","k")\n',
    'packages/domain/src/p.ts': 'export const p = (m: any) => m.presignedPutObject("b","k");\n',
  });
  try {
    const sites = findSites(root);
    assert.deepEqual(sites.map(site => `${site.file}|${site.method}`), ['apps/web/src/lib/direct.ts|putObject', 'apps/worker/src/queue/sweeper.ts|removeObject', 'apps/worker/src/queue/unrelated.ts|removeObjects', 'packages/domain/src/p.ts|presignedPutObject']);
    const indirect = webReachableMutatingModules(root, sites);
    assert.deepEqual(indirect.map(item => item.file), ['apps/worker/src/queue/sweeper.ts'], 'only the worker module the web actually reaches (through two hops), not the unrelated one');
    const report = buildReport(root);
    const clean = { sites: report.sites, webDirect: ['apps/web/src/lib/direct.ts|putObject'], webIndirect: report.webIndirect, verifierEnvModules: [] };
    assert.equal(compareAudit(report, clean).ok, true);
    assert.ok(compareAudit(report, { ...clean, webDirect: [] }).differences.some(d => d.kind === 'WEB_DIRECT_SITE_NOT_CLASSIFIED'), 'a web-owned site must be explicitly classified');
    assert.ok(compareAudit(report, { ...clean, webIndirect: [] }).differences.some(d => d.kind === 'UNCLASSIFIED_WEB_REACHABLE_MUTATION'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: a MINIO_VERIFIER_* reference outside the allowlisted module is a failure', () => {
  const root = fixtureRepo({ 'apps/web/src/lib/leak.ts': 'export const k = process.env.MINIO_VERIFIER_ACCESS_KEY;\n', 'apps/worker/src/providers/sealed-namespace.ts': 'const k = process.env.MINIO_VERIFIER_ACCESS_KEY;\n' });
  try {
    const report = buildReport(root);
    assert.deepEqual(report.verifierEnvModules, ['apps/web/src/lib/leak.ts', 'apps/worker/src/providers/sealed-namespace.ts']);
    const result = compareAudit(report, { sites: [], webDirect: [], webIndirect: [], verifierEnvModules: ['apps/worker/src/providers/sealed-namespace.ts'] });
    assert.ok(result.differences.some(d => d.kind === 'VERIFIER_ENV_OUTSIDE_ALLOWLIST' && d.entry.includes('leak.ts')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('generated secrets never begin with "-" (mc would parse it as an option and echo it), without losing randomness', () => {
  // Deterministic: a source that first yields a base64url "-" lead (byte 0xF8 => index 62) must be rejected and re-drawn, never patched.
  const draws = [Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(23, 7)]), Buffer.concat([Buffer.from([0xfb]), Buffer.alloc(23, 9)]), Buffer.alloc(24, 5)];
  let calls = 0;
  const secret = newSecretKey(() => draws[calls++]);
  assert.equal(calls, 3, 'both "-"-leading draws were rejected');
  assert.equal(secret, Buffer.alloc(24, 5).toString('base64url'), 'the accepted secret is the untouched third draw');
  assert.equal(Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(23, 7)]).toString('base64url')[0], '-', 'the rejected draw really did lead with "-"');
  // Statistical: with the unfixed generator about 1 in 64 would lead with "-"; 6,000 secrets (24,000 credentials worth of draws) must have none, and stay distinct.
  const seen = new Set();
  for (let i = 0; i < 1500; i += 1) {
    const credentials = randomCredentials();
    for (const entry of Object.values(credentials)) { assert.equal(entry.secretKey.startsWith('-'), false); assert.equal(entry.secretKey.length, 32); assert.match(entry.secretKey, /^[A-Za-z0-9_-]{32}$/); seen.add(entry.secretKey); }
  }
  assert.equal(seen.size, 6000, 'all distinct: no repeated or constant-patched secrets');
});

test('provisioning passes secrets as positional mc arguments, so the generator guarantee is what keeps them from being parsed as options', () => {
  const provision = readFileSync(new URL('../minio-authority/provision.sh', import.meta.url), 'utf8');
  assert.match(provision, /mc admin user add local "\$S0_WEB_KEY" "\$S0_WEB_SECRET"/);
  assert.equal(/mc admin user add[^\n]*--/.test(provision), false);
});

test('the secret-output guard stays fail-closed with the exact error code', () => {
  const credentials = randomCredentials();
  const secrets = Object.values(credentials).map(entry => entry.secretKey);
  for (const secret of secrets) assert.throws(() => assertNoSecrets(`mc: <ERROR> flag provided but not defined: ${secret}`, secrets), { message: 'S0_SECRET_IN_OUTPUT' });
  assert.doesNotThrow(() => assertNoSecrets('Added user `s0web123` successfully.', secrets));
});
