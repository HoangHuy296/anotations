import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { root, walk } from '../guard.mjs';

// Offline, source-only. Pins the audited set of production code that creates Assets (or Asset subtype rows) so a NEW writer cannot appear
// without a deliberate update here (and therefore a modality-guard review). Companion document: specs/029-modality-specific-datasets/writer-inventory.md
const SCAN_ROOTS = ['apps/web/src', 'apps/worker/src', 'packages/domain/src', 'packages/queue/src', 'apps/realtime/src'];
const sources = SCAN_ROOTS.flatMap(dir => { try { return walk(join(root, dir)); } catch { return []; } }).filter(file => /\.(ts|tsx)$/.test(file) && !/\.(test|spec)\./.test(file) && !file.includes('/node_modules/') && !file.includes('/dist/'));
const read = file => readFileSync(file, 'utf8');
const countOf = (text, pattern) => (text.match(pattern) ?? []).length;
const PATTERNS = {
  assetCreate: /\.asset\.create\(/g,
  assetCreateMany: /\.asset\.createMany\(/g,
  assetUpsert: /\.asset\.upsert\(/g,
  datasetNestedAssets: /\bassets:\s*\{\s*(?:create|createMany|connectOrCreate)/g,
  subtypeNestedCreate: /\b(?:imageAsset|videoAsset|audioAsset|textAsset):\s*\{\s*create\b/g,
  subtypeCreate: /\.(?:imageAsset|videoAsset|audioAsset|textAsset)\.(?:create|createMany)\(/g,
  subtypeUpsert: /\.(?:imageAsset|videoAsset|audioAsset|textAsset)\.upsert\(/g,
  reparent: /\.asset\.update(?:Many)?\(\s*\{[^;]*?data:\s*\{[^}]*\bdatasetId\b/gs,
};
const inventory = () => {
  const found = {};
  for (const file of sources) {
    const text = read(file); const rel = relative(root, file);
    for (const [name, pattern] of Object.entries(PATTERNS)) { const count = countOf(text, new RegExp(pattern.source, pattern.flags)); if (count) (found[rel] ??= {})[name] = count; }
  }
  return found;
};

const AUDITED = {
  // Direct and prepared (local-folder) upload: four modality branches in ONE transaction; parent modality asserted in-transaction and on both replay paths.
  'apps/web/src/lib/asset-upload.ts': { assetCreate: 4, subtypeNestedCreate: 4 },
  // Repository mirror: create + exact-reuse; parent modality asserted on create, reuse and reconcile.
  'apps/worker/src/jobs/repository-asset-upsert.ts': { assetCreate: 1, subtypeNestedCreate: 4 },
  // DORMANT (no production caller): hardcoded IMAGE, existing-Dataset modality guard. Intentionally unmodified; see the inventory document.
  'apps/web/src/lib/dataset-import.ts': { assetUpsert: 1, subtypeNestedCreate: 1 },
  // Subtype rows for EXISTING Assets, each guarded by an Asset lookup that filters on its own modality.
  'apps/worker/src/jobs/text-source-prepare.processor.ts': { subtypeUpsert: 1 },
  'apps/worker/src/jobs/video-metadata.ts': { subtypeUpsert: 1 },
  'apps/worker/src/jobs/audio-waveform.ts': { subtypeUpsert: 1 },
  'apps/worker/src/jobs/ai-video-prediction-writer.ts': { subtypeUpsert: 1 },
};
const SUBTYPE_GUARDS = {
  'apps/worker/src/jobs/text-source-prepare.processor.ts': /modality:\s*"TEXT"/,
  'apps/worker/src/jobs/video-metadata.ts': /modality:\s*"VIDEO"/,
  'apps/worker/src/jobs/audio-waveform.ts': /modality:\s*"AUDIO"/,
  'apps/worker/src/jobs/ai-video-prediction-writer.ts': /modality:\s*"VIDEO"/,
};

test('the set of production Asset / subtype writers is exactly the audited set (a new writer fails this test until it is reviewed)', () => {
  assert.ok(sources.length > 300, 'the scan sees the production sources');
  assert.deepEqual(inventory(), AUDITED);
});

test('no production code bulk-creates Assets, creates Assets through a Dataset, creates subtype rows directly, or moves an Asset between Datasets', () => {
  const found = inventory();
  for (const [file, kinds] of Object.entries(found)) for (const forbidden of ['assetCreateMany', 'datasetNestedAssets', 'subtypeCreate', 'reparent']) assert.equal(kinds[forbidden], undefined, `${file} has ${forbidden}`);
});

test('every subtype upsert sits behind an Asset lookup filtered on the matching modality (it can never create a subtype for another modality)', () => {
  for (const [file, guard] of Object.entries(SUBTYPE_GUARDS)) assert.match(read(join(root, file)), guard, file);
  assert.deepEqual(Object.keys(SUBTYPE_GUARDS).sort(), Object.entries(AUDITED).filter(([, kinds]) => kinds.subtypeUpsert).map(([file]) => file).sort());
});

test('the publishers keep the modality assertion on creation AND on every replay/reuse branch', () => {
  const upload = read(join(root, 'apps/web/src/lib/asset-upload.ts'));
  assert.ok(countOf(upload, /assertAssetModality\(/g) >= 3, 'outer replay, in-transaction create and in-transaction duplicate');
  const mirror = read(join(root, 'apps/worker/src/jobs/repository-asset-upsert.ts'));
  assert.ok(countOf(mirror, /assertAssetModality\(/g) >= 2, 'reconcile reuse and upsert');
  const folder = read(join(root, 'apps/web/src/lib/imports/complete-local-folder-item.ts'));
  assert.match(folder, /completedAsset\.modality !== parent\.modality/, 'prepared completed-item replay compares against the parent');
});

test('the dormant legacy importer has no production caller (so it cannot be reached)', () => {
  const callers = sources.filter(file => !file.endsWith('apps/web/src/lib/dataset-import.ts') && /\bpersistDatasetImport\b/.test(read(file)));
  assert.deepEqual(callers.map(file => relative(root, file)), []);
});

test('the audit companion document lists every audited writer', () => {
  const doc = read(join(root, 'specs/029-modality-specific-datasets/writer-inventory.md'));
  for (const file of Object.keys(AUDITED)) assert.ok(doc.includes(file), `${file} missing from writer-inventory.md`);
});
