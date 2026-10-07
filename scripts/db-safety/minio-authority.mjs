// A2 / R9-M1 storage-authority provisioning library (S0). Pure helpers plus thin, injectable Docker wrappers. Nothing here starts a container by
// itself; `minio-authority-s0.mjs` composes these into the disposable run.
//
// Boundaries: disposable infrastructure only; provisioning tool = a digest-pinned `minio/mc` image; credentials exist only in memory and in
// child-process environments passed by NAME; secrets never reach a command line, a receipt, a log or an evidence file (and are scanned for).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const ARTIFACT_DIR = join(import.meta.dirname, 'minio-authority');
export const SEALED_PREFIX = 'verified-uploads/';
export const STAGING_PREFIXES = Object.freeze(['direct-uploads/', 'prepared-imports/']);
export const ROLES = Object.freeze(['web', 'worker', 'verifier']);
export const POLICY_NAME = role => `a2-s0-${role}`;
export const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Exact action sets (least privilege). Any action outside the role's set is a policy defect. */
export const SEALED_MUTATION_ACTIONS = Object.freeze(['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:AbortMultipartUpload', 's3:PutObjectTagging', 's3:DeleteObjectTagging', 's3:PutObjectRetention', 's3:PutObjectLegalHold', 's3:BypassGovernanceRetention']);
/** Web/worker are additionally denied READING in-flight multipart state of the sealed namespace (discovered in the first S0 rehearsal: ListMultipartUploadParts was granted by the broad worker allow). */
export const SEALED_DENY_ACTIONS = Object.freeze([...SEALED_MUTATION_ACTIONS, 's3:ListMultipartUploadParts']);
export const ALLOWED_ACTIONS = Object.freeze({
  web: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
  worker: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
  verifier: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
});
/** Bucket-administration and lifecycle actions that no application identity may ever hold (checked as a substring family). */
export const FORBIDDEN_FAMILIES = Object.freeze(['s3:*', '*', 's3:Put*', 's3:Delete*', 's3:CreateBucket', 's3:DeleteBucket', 's3:PutBucket', 's3:GetBucketPolicy', 's3:PutLifecycleConfiguration', 's3:PutBucketVersioning', 's3:ForceDeleteBucket', 's3:BypassGovernanceRetention', 'admin:']);

export function loadArtifacts(dir = ARTIFACT_DIR) {
  const read = name => readFileSync(join(dir, name), 'utf8');
  const files = { web: 'policy-web.json', worker: 'policy-worker.json', verifier: 'policy-verifier.json', lifecycle: 'lifecycle.json', provision: 'provision.sh', snapshot: 'snapshot.sh', deprovision: 'deprovision.sh', frozen: 'frozen-images.json' };
  const text = Object.fromEntries(Object.entries(files).map(([key, name]) => [key, read(name)]));
  return { files, text, hashes: Object.fromEntries(Object.entries(text).map(([key, value]) => [files[key], sha256(value)])) };
}
export const renderPolicy = (template, bucket) => { if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucket)) throw Error('S0_BUCKET_NAME_INVALID'); return JSON.parse(template.replaceAll('__BUCKET__', bucket)); };

const asArray = value => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
/** Order-insensitive canonical form of an IAM policy (MinIO may re-serialize arrays/strings). */
export function normalizePolicy(policy) {
  const statements = asArray(policy.Statement).map(statement => ({
    Sid: statement.Sid ?? '', Effect: statement.Effect,
    Action: [...asArray(statement.Action)].sort(), Resource: [...asArray(statement.Resource)].sort(),
    ...(statement.Condition ? { Condition: statement.Condition } : {}),
  })).sort((a, b) => `${a.Sid}|${a.Effect}`.localeCompare(`${b.Sid}|${b.Effect}`));
  return { Version: policy.Version ?? '2012-10-17', Statement: statements };
}
export const policyDigest = policy => sha256(JSON.stringify(normalizePolicy(policy)));

/** Static review of a rendered policy against the contract (§5.5). Returns a list of defects (empty = acceptable). */
export function analyzePolicy(role, policy, bucket) {
  const problems = [];
  const norm = normalizePolicy(policy);
  const sealed = `arn:aws:s3:::${bucket}/${SEALED_PREFIX}*`;
  const allowed = new Set(ALLOWED_ACTIONS[role]);
  for (const statement of norm.Statement) {
    if (statement.Effect === 'Allow') {
      for (const action of statement.Action) {
        if (!allowed.has(action)) problems.push(`ACTION_NOT_ALLOWED_FOR_ROLE:${action}`);
        if (FORBIDDEN_FAMILIES.some(family => action === family || (family.endsWith(':') && action.startsWith(family)))) problems.push(`FORBIDDEN_ACTION:${action}`);
      }
      for (const resource of statement.Resource) if (resource === '*' || resource === 'arn:aws:s3:::*') problems.push(`RESOURCE_TOO_BROAD:${resource}`);
    }
  }
  const denies = norm.Statement.filter(statement => statement.Effect === 'Deny');
  if (role === 'web' || role === 'worker') {
    const denied = new Set(denies.filter(statement => statement.Resource.includes(sealed)).flatMap(statement => statement.Action));
    for (const action of SEALED_DENY_ACTIONS) if (!denied.has(action)) problems.push(`SEALED_DENY_MISSING:${action}`);
  }
  if (role === 'web') {
    const writes = norm.Statement.filter(statement => statement.Effect === 'Allow' && statement.Action.includes('s3:PutObject'));
    for (const statement of writes) for (const resource of statement.Resource) if (!STAGING_PREFIXES.some(prefix => resource === `arn:aws:s3:::${bucket}/${prefix}*`)) problems.push(`WEB_WRITE_OUTSIDE_STAGING:${resource}`);
  }
  if (role === 'verifier') {
    for (const statement of norm.Statement) if (statement.Effect === 'Allow' && statement.Action.some(action => ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'].includes(action)) && statement.Resource.some(resource => resource !== sealed)) problems.push('VERIFIER_WRITE_OUTSIDE_SEALED');
    for (const statement of norm.Statement) if (statement.Effect === 'Allow' && statement.Action.includes('s3:DeleteObject') && statement.Resource.some(resource => resource !== sealed && !STAGING_PREFIXES.some(prefix => resource === `arn:aws:s3:::${bucket}/${prefix}*`))) problems.push('VERIFIER_DELETE_OUTSIDE_SEALED_AND_STAGING');
    if (!denies.some(statement => statement.Action.includes('s3:PutObject') && STAGING_PREFIXES.every(prefix => statement.Resource.includes(`arn:aws:s3:::${bucket}/${prefix}*`)))) problems.push('VERIFIER_STAGING_PUT_DENY_MISSING');
  }
  return problems;
}

/** Compare the provisioned snapshot (parsed from the read-only snapshot script) with the rendered artifacts. Missing/wrong ⇒ problems (fail closed). */
export function verifySnapshot(snapshot, expected) {
  const problems = [];
  for (const role of ROLES) {
    const live = snapshot.policies?.[role];
    if (!live) { problems.push(`POLICY_MISSING:${role}`); continue; }
    if (policyDigest(live) !== policyDigest(expected.policies[role])) problems.push(`POLICY_MISMATCH:${role}`);
    const user = snapshot.users?.[role];
    if (!user) problems.push(`USER_MISSING:${role}`);
    else {
      if (user.policyName !== POLICY_NAME(role)) problems.push(`USER_POLICY_ATTACHMENT_WRONG:${role}`);
      if (user.userStatus && user.userStatus !== 'enabled') problems.push(`USER_DISABLED:${role}`);
      if (user.accessKey && user.accessKey !== expected.accessKeys[role]) problems.push(`USER_KEY_MISMATCH:${role}`);
    }
  }
  const rules = snapshot.lifecycle?.Rules ?? snapshot.lifecycle?.rules ?? [];
  const wanted = expected.lifecycle.Rules;
  if (rules.length !== wanted.length) problems.push('LIFECYCLE_RULE_COUNT_MISMATCH');
  for (const rule of wanted) {
    const live = rules.find(candidate => (candidate.ID ?? candidate.id) === rule.ID);
    const prefix = live && (live.Filter?.Prefix ?? live.Prefix ?? live.RuleFilter?.Prefix);
    const days = live && (live.Expiration?.Days ?? live.Expiration?.days);
    if (!live || prefix !== rule.Filter.Prefix || Number(days) !== rule.Expiration.Days || (live.Status ?? live.status) !== 'Enabled') problems.push(`LIFECYCLE_RULE_WRONG:${rule.ID}`);
  }
  if (rules.some(rule => String(rule.Filter?.Prefix ?? rule.Prefix ?? rule.RuleFilter?.Prefix ?? '').startsWith(SEALED_PREFIX) || (rule.Filter?.Prefix ?? rule.Prefix ?? rule.RuleFilter?.Prefix ?? '') === '')) problems.push('LIFECYCLE_TOUCHES_SEALED_OR_WHOLE_BUCKET');
  return problems;
}

export function parseSnapshot(output) {
  const out = { policies: {}, users: {}, lifecycle: null, buckets: null, ok: /S0_SNAPSHOT_OK/.test(output) };
  for (const line of output.split('\n')) {
    let match;
    if ((match = /^POLICY (\w+) (\{.*\})\s*$/.exec(line))) { const info = JSON.parse(match[2]); out.policies[match[1]] = info.policyInfo?.Policy ?? info.Policy ?? info.policy; }
    else if ((match = /^USER (\w+) (\{.*\})\s*$/.exec(line))) out.users[match[1]] = JSON.parse(match[2]);
    else if ((match = /^LIFECYCLE (\{.*\})\s*$/.exec(line))) out.lifecycle = JSON.parse(match[1]);
    else if ((match = /^BUCKETS (.*)$/.exec(line))) out.buckets = match[1];
  }
  return out;
}
export const snapshotDigest = snapshot => sha256(JSON.stringify({
  policies: Object.fromEntries(ROLES.map(role => [role, snapshot.policies[role] ? policyDigest(snapshot.policies[role]) : null])),
  users: Object.fromEntries(ROLES.map(role => [role, snapshot.users[role] ? { policyName: snapshot.users[role].policyName, userStatus: snapshot.users[role].userStatus, accessKey: snapshot.users[role].accessKey } : null])),
  lifecycle: snapshot.lifecycle,
}));

/**
 * A generated secret is passed to `mc admin user add` as a positional argument. A secret whose first base64url character is `-` (1 in 64) is parsed by mc as an
 * option; the usage error then echoes it into the container log (reproduced with dummy secrets; the runner's secret-output guard failed closed on it:
 * authoritative-20261007T063209Z-3c621100). Rejection sampling keeps the secret uniformly random over the remaining space; no character is ever substituted.
 */
export function newSecretKey(random = randomBytes) {
  for (;;) { const secret = random(24).toString('base64url'); if (!secret.startsWith('-')) return secret; }
}
export function randomCredentials() {
  const make = prefix => ({ accessKey: `${prefix}${randomBytes(6).toString('hex')}`, secretKey: newSecretKey() });
  return { root: { accessKey: `s0root${randomBytes(4).toString('hex')}`, secretKey: newSecretKey() }, web: make('s0web'), worker: make('s0wrk'), verifier: make('s0ver') };
}
export function collectSecrets(credentials) { return Object.values(credentials).flatMap(entry => [entry.secretKey]); }
export function assertNoSecrets(text, secrets) { for (const secret of secrets) if (secret && text.includes(secret)) throw Error('S0_SECRET_IN_OUTPUT'); }

/** Frozen-image policy: authoritative runs require an owner-frozen digest, never a floating tag. */
export function checkImagePins(frozen, { authoritative }) {
  const problems = [];
  if (!/^sha256:[0-9a-f]{64}$/.test(frozen.mc?.digest ?? '')) problems.push('MC_DIGEST_INVALID');
  if (!/^sha256:[0-9a-f]{64}$/.test(frozen.minio?.digest ?? '')) problems.push('MINIO_DIGEST_INVALID');
  if (/:latest$/.test(frozen.mc?.repository ?? '') || /latest/.test(frozen.minio?.tag ?? '')) problems.push('FLOATING_TAG');
  if (authoritative && frozen.frozen !== true) problems.push('IMAGES_NOT_FROZEN_BY_OWNER');
  return problems;
}
export const mcReference = frozen => `${frozen.mc.repository}@${frozen.mc.digest}`;
export const minioReference = frozen => `${frozen.minio.repository}@${frozen.minio.digest}`;
