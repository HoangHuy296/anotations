// Static audit of MinIO mutating call sites (A2 / R9-M1). Reports every direct site in apps/web/src, apps/worker/src and packages/*/src and
// follows import edges from the web app so INDIRECT paths (a web module importing worker cleanup code) are found too. The result must equal
// the committed allowlist exactly: a new site, a removed site or a new web-reachable mutating module fails the audit until it is classified.
//
//   node scripts/db-safety/minio-write-audit.mjs            # print the report and compare with the allowlist (exit 1 on difference)
//   node scripts/db-safety/minio-write-audit.mjs --print    # print only
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const ALLOWLIST_PATH = join(ROOT, 'scripts/db-safety/minio-write-audit.allowlist.json');
export const MUTATING = Object.freeze(['putObject', 'fPutObject', 'copyObject', 'composeObject', 'removeObject', 'removeObjects', 'removeIncompleteUpload', 'presignedPostPolicy', 'presignedPutObject', 'initiateNewMultipartUpload', 'makeBucket', 'removeBucket', 'setBucketLifecycle', 'setBucketPolicy', 'setBucketVersioning', 'setBucketEncryption', 'setBucketTagging', 'setBucketReplication', 'setObjectTagging', 'removeObjectTagging', 'setObjectLegalHold', 'setObjectRetention', 'setObjectLockConfig']);
const METHOD = new RegExp(`\\.(${MUTATING.join('|')})\\s*(?:<[^>]*>)?\\(`, 'g');
const SCAN_ROOTS = ['apps/web/src', 'apps/worker/src', 'apps/realtime/src'];
const SKIP_DIR = new Set(['node_modules', 'dist', '.next', 'generated']);
const isSource = file => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) && !/\.(test|spec)\.[tj]sx?$/.test(file) && !file.endsWith('.d.ts');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIR.has(entry.name)) walk(join(dir, entry.name), out); }
    else if (isSource(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}
function sourceRoots(root) {
  const roots = SCAN_ROOTS.map(path => join(root, path));
  const packages = join(root, 'packages');
  if (existsSync(packages)) for (const name of readdirSync(packages)) if (statSync(join(packages, name)).isDirectory()) roots.push(join(packages, name, 'src'));
  return roots;
}
function codeLines(text) {
  // Drop line/block comments conservatively so documentation never counts as a call site.
  return text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).split('\n').map(line => line.replace(/^\s*\/\/.*$/, ''));
}

export function findSites(root = ROOT) {
  const sites = [];
  for (const base of sourceRoots(root)) for (const file of walk(base)) {
    const lines = codeLines(readFileSync(file, 'utf8'));
    lines.forEach((line, index) => { for (const match of line.matchAll(METHOD)) sites.push({ file: relative(root, file), line: index + 1, method: match[1] }); });
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
export function verifierEnvModules(root = ROOT) {
  const found = [];
  for (const base of sourceRoots(root)) for (const file of walk(base)) if (/MINIO_VERIFIER_/.test(readFileSync(file, 'utf8'))) found.push(relative(root, file));
  return found.sort();
}

function resolveImport(fromFile, spec, root) {
  let target = null;
  if (spec.startsWith('@/')) target = join(root, 'apps/web/src', spec.slice(2));
  else if (spec.startsWith('.')) target = resolve(dirname(fromFile), spec);
  else {
    const m = /^@annotationplatform\/([^/]+)(?:\/(.+))?$/.exec(spec);
    if (m) target = join(root, 'packages', m[1], 'src', m[2] ?? 'index');
  }
  if (!target) return null;
  const base = target.replace(/\.(js|mjs|cjs|jsx)$/, '');
  for (const candidate of [base + '.ts', base + '.tsx', base + '.mts', join(base, 'index.ts'), target]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}
const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

/** Mutating modules reachable from any apps/web/src file through imports, outside apps/web/src itself (the INDIRECT paths). */
export function webReachableMutatingModules(root = ROOT, sites = findSites(root)) {
  const mutating = new Set(sites.map(site => join(root, site.file)));
  const queue = walk(join(root, 'apps/web/src')).map(file => ({ file, chain: [relative(root, file)] }));
  const seen = new Set(queue.map(item => item.file));
  const reachable = new Map();
  while (queue.length) {
    const { file, chain } = queue.shift();
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3];
      const target = spec && resolveImport(file, spec, root);
      if (!target || seen.has(target) || !isSource(target)) continue;
      seen.add(target);
      const next = [...chain, relative(root, target)];
      if (mutating.has(target) && !relative(root, target).startsWith('apps/web/src/')) reachable.set(relative(root, target), next.slice(-3));
      queue.push({ file: target, chain: next });
    }
  }
  return [...reachable.entries()].map(([file, chain]) => ({ file, via: chain })).sort((a, b) => a.file.localeCompare(b.file));
}

export function buildReport(root = ROOT) {
  const sites = findSites(root);
  const grouped = new Map();
  for (const site of sites) { const key = `${site.file}|${site.method}`; grouped.set(key, (grouped.get(key) ?? 0) + 1); }
  return {
    sites: [...grouped.entries()].map(([key, count]) => { const [file, method] = key.split('|'); return { file, method, count }; }).sort((a, b) => a.file.localeCompare(b.file) || a.method.localeCompare(b.method)),
    webIndirect: webReachableMutatingModules(root, sites).map(item => item.file),
    verifierEnvModules: verifierEnvModules(root),
  };
}

export function compareAudit(report, allowlist) {
  const key = site => `${site.file}|${site.method}|${site.count}`;
  const have = new Set(report.sites.map(key)), want = new Set((allowlist.sites ?? []).map(key));
  const differences = [];
  for (const entry of have) if (!want.has(entry)) differences.push({ kind: 'UNCLASSIFIED_SITE', entry });
  for (const entry of want) if (!have.has(entry)) differences.push({ kind: 'ALLOWLIST_ENTRY_NOT_FOUND', entry });
  const setDiff = (name, a, b, kindExtra, kindMissing) => { for (const item of a) if (!b.includes(item)) differences.push({ kind: kindExtra, entry: `${name}:${item}` }); for (const item of b) if (!a.includes(item)) differences.push({ kind: kindMissing, entry: `${name}:${item}` }); };
  setDiff('webIndirect', report.webIndirect, allowlist.webIndirect ?? [], 'UNCLASSIFIED_WEB_REACHABLE_MUTATION', 'ALLOWLIST_WEB_INDIRECT_NOT_FOUND');
  setDiff('verifierEnvModules', report.verifierEnvModules, allowlist.verifierEnvModules ?? [], 'VERIFIER_ENV_OUTSIDE_ALLOWLIST', 'ALLOWLIST_VERIFIER_MODULE_NOT_FOUND');
  // Hard rules independent of the allowlist: a web-owned file must never mutate outside the three classified staging sites.
  for (const site of report.sites) if (site.file.startsWith('apps/web/src/') && !(allowlist.webDirect ?? []).includes(`${site.file}|${site.method}`)) differences.push({ kind: 'WEB_DIRECT_SITE_NOT_CLASSIFIED', entry: `${site.file}|${site.method}` });
  return { ok: differences.length === 0, differences };
}

export function loadAllowlist(path = ALLOWLIST_PATH) { return JSON.parse(readFileSync(path, 'utf8')); }

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const report = buildReport();
  const print = process.argv.includes('--print');
  const result = print ? { ok: true, differences: [] } : compareAudit(report, loadAllowlist());
  console.log(JSON.stringify({ ...result, report }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
