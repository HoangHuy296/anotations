import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { root, walk } from '../guard.mjs';

// Offline, source-only. T018 writer matrix for the Phase029 migration 24 triggers (Dataset insert/assignment guards, Asset write guard).
// Pins EVERY production Dataset writer and every Asset update/delete writer (Asset creators are pinned by asset-writer-inventory.test.mjs), so a NEW writer
// fails here until it is classified in specs/029-modality-specific-datasets/writer-inventory.md. Static evidence only; it is not a guarded database run.
const SCAN_ROOTS = ['apps/web/src', 'apps/worker/src', 'packages/domain/src', 'packages/queue/src', 'apps/realtime/src'];
const sources = SCAN_ROOTS.flatMap(dir => { try { return walk(join(root, dir)); } catch { return []; } }).filter(file => /\.(ts|tsx)$/.test(file) && !/\.(test|spec)\./.test(file) && !file.includes('/node_modules/') && !file.includes('/generated/') && !file.includes('/dist/'));
const read = file => readFileSync(file, 'utf8');
const PATTERNS = {
  datasetCreate: /\.dataset\.create\(/g, datasetCreateMany: /\.dataset\.createMany(?:AndReturn)?\(/g,
  datasetUpdate: /\.dataset\.update\(/g, datasetUpdateMany: /\.dataset\.updateMany\(/g, datasetUpsert: /\.dataset\.upsert\(/g,
  datasetDelete: /\.dataset\.delete\(/g, datasetDeleteMany: /\.dataset\.deleteMany\(/g,
  assetUpdate: /\.asset\.update\(/g, assetUpdateMany: /\.asset\.updateMany\(/g, assetDelete: /\.asset\.delete\(/g, assetDeleteMany: /\.asset\.deleteMany\(/g,
  rawWrite: /\$execute(?:Raw|RawUnsafe)\b/g,
};
const inventory = () => {
  const found = {};
  for (const file of sources) {
    const text = read(file); const rel = relative(root, file);
    for (const [name, pattern] of Object.entries(PATTERNS)) { const count = (text.match(new RegExp(pattern.source, pattern.flags)) ?? []).length; if (count) (found[rel] ??= {})[name] = count; }
  }
  return found;
};

// Classification: G = guarded and verified; D = dormant (unreachable, evidenced); I = intentionally incompatible (fails closed); U = unresolved blocker (must stay empty).
const MATRIX = {
  // Dataset INSERT: explicit modality, trigger requires non-null.
  'apps/web/src/app/api/datasets/route.ts': { counts: { datasetCreate: 1 }, class: 'G' },
  'apps/web/src/lib/queue/enqueue-job.ts': { counts: { datasetCreate: 1 }, class: 'G' },
  'apps/web/src/lib/imports/prepare-local-folder-import.ts': { counts: { datasetCreate: 1 }, class: 'G' },
  // Dataset modality assignment (the only writer of modality / receipt / fence from the application).
  'apps/web/src/lib/datasets/modality.ts': { counts: { datasetUpdate: 2 }, class: 'G' },
  // Dataset UPDATE of non-modality columns (metadata, archive, text policy, claims, visualization): trigger passes for resolved and unresolved parents.
  'apps/web/src/app/(app)/datasets/actions.ts': { counts: { datasetUpdate: 1 }, class: 'G' },
  'apps/web/src/app/api/datasets/[datasetId]/route.ts': { counts: { datasetUpdate: 2 }, class: 'G' },
  'apps/web/src/lib/workspace/label-management.ts': { counts: { datasetUpdate: 2 }, class: 'G' },
  'apps/web/src/lib/annotations/text-policy-write-service.ts': { counts: { datasetUpdate: 1 }, class: 'G' },
  'apps/web/src/lib/annotations/text-command-service.ts': { counts: { datasetUpdateMany: 1 }, class: 'G' },
  'apps/worker/src/jobs/visualization.processor.ts': { counts: { datasetUpdate: 1, datasetUpdateMany: 1 }, class: 'G' },
  // Dataset hard delete (cascade through the Asset DELETE trigger).
  'apps/worker/src/queue/deleted-dataset-cleanup.ts': { counts: { datasetDelete: 1 }, class: 'G' },
  // Dormant legacy importer (no caller; creates a Dataset without modality, would fail closed).
  'apps/web/src/lib/dataset-import.ts': { counts: { datasetCreate: 1, datasetUpdate: 1 }, class: 'D' },
  // Asset UPDATE of non-fence columns (revision, status, description, assignee, deletedAt): trigger cheap path, no parent write.
  'apps/web/src/lib/annotations/text-classification-service.ts': { counts: { assetUpdateMany: 1 }, class: 'G' },
  'apps/web/src/lib/annotations/text-relation-service.ts': { counts: { assetUpdateMany: 1 }, class: 'G' },
  'apps/web/src/lib/annotations/text-span-service.ts': { counts: { assetUpdateMany: 3 }, class: 'G' },
  'apps/web/src/lib/assets/asset-bulk-service.ts': { counts: { assetUpdateMany: 3 }, class: 'G' },
  'apps/web/src/lib/collaboration/asset-assignment-service.ts': { counts: { assetUpdate: 2 }, class: 'G' },
  'apps/web/src/lib/collaboration/dataset-membership-service.ts': { counts: { assetUpdateMany: 1 }, class: 'G' },
  'apps/web/src/lib/workflow/asset-workflow-service.ts': { counts: { assetUpdateMany: 2 }, class: 'G' },
  'apps/web/src/lib/workspace/image-mutations.ts': { counts: { assetUpdateMany: 1 }, class: 'G' },
  'apps/web/src/lib/workspace/text-mutations.ts': { counts: { assetUpdateMany: 1 }, class: 'G' },
  'apps/web/src/lib/workspace/video-mutations.ts': { counts: { assetUpdateMany: 1 }, class: 'G' },
  'apps/worker/src/jobs/ai-prediction-writer.ts': { counts: { assetUpdateMany: 1 }, class: 'G' },
  'apps/worker/src/jobs/bulk-delete-assets.ts': { counts: { assetUpdateMany: 1 }, class: 'G' },
  // Asset UPDATE of fence-evidence columns (durationMs, width, height): parent fence taken, datasetId/modality never changed.
  'apps/web/src/app/api/images/[imageId]/dimensions/route.ts': { counts: { assetUpdateMany: 1 }, class: 'G' },
  'apps/worker/src/jobs/ai-video-prediction-writer.ts': { counts: { assetUpdateMany: 2 }, class: 'G' },
  'apps/worker/src/jobs/audio-waveform.ts': { counts: { assetUpdate: 1 }, class: 'G' },
  'apps/worker/src/jobs/video-metadata.ts': { counts: { assetUpdate: 1 }, class: 'G' },
};
const AUDITED = Object.fromEntries(Object.entries(MATRIX).map(([file, entry]) => [file, entry.counts]));

test('the set of production Dataset writers and Asset update/delete writers is exactly the classified set (a new writer fails until it is reviewed)', () => {
  assert.ok(sources.length > 300, 'the scan sees the production sources');
  assert.deepEqual(inventory(), AUDITED);
});
test('no unresolved writer class exists; every writer is guarded/verified, dormant or intentionally incompatible', () => {
  assert.deepEqual(Object.entries(MATRIX).filter(([, entry]) => entry.class === 'U').map(([file]) => file), []);
  assert.deepEqual(Object.entries(MATRIX).filter(([, entry]) => entry.class === 'D').map(([file]) => file), ['apps/web/src/lib/dataset-import.ts']);
});
test('production code has no raw write against any table, no Asset delete and no Dataset bulk/upsert write', () => {
  for (const [file, kinds] of Object.entries(inventory())) for (const forbidden of ['rawWrite', 'assetDelete', 'assetDeleteMany', 'datasetCreateMany', 'datasetUpsert', 'datasetDeleteMany']) assert.equal(kinds[forbidden], undefined, `${file} has ${forbidden}`);
  for (const file of sources.filter(path => /\$queryRaw/.test(read(path)))) assert.doesNotMatch(read(file), /"(?:Dataset|Asset)"/, `${relative(root, file)} raw SQL must not name Dataset/Asset`);
});
test('every Dataset creator supplies an explicit modality (the insert trigger rejects NULL)', () => {
  for (const file of ['apps/web/src/app/api/datasets/route.ts', 'apps/web/src/lib/queue/enqueue-job.ts', 'apps/web/src/lib/imports/prepare-local-folder-import.ts']) {
    const text = read(join(root, file)); const at = text.indexOf('.dataset.create(');
    assert.ok(at >= 0, file); assert.match(text.slice(at, at + 700), /\bmodality\b/, `${file} creates a Dataset without modality`);
  }
});
test('only the resolution service writes Dataset.modality, the resolver subject or the content revision', () => {
  for (const file of sources) {
    const rel = relative(root, file); const text = read(file);
    if (rel === 'apps/web/src/lib/datasets/modality.ts' || !/\.dataset\.update(?:Many)?\(/.test(text)) continue;
    for (const match of text.matchAll(/\.dataset\.update(?:Many)?\(\s*\{[\s\S]{0,900}?\bdata:\s*\{([^}]*)\}/g)) assert.doesNotMatch(match[1], /\b(?:modality|modalityContentRevision|modalityResolvedAt|modalityResolverSubject)\b/, `${rel} writes a modality field`);
  }
});
test('no production Asset update changes datasetId or modality (no reparent), and the fence-evidence writers never name them', () => {
  for (const file of Object.entries(MATRIX).filter(([, entry]) => Object.keys(entry.counts).some(kind => kind.startsWith('asset'))).map(([name]) => name)) {
    const text = read(join(root, file));
    for (const match of text.matchAll(/\.asset\.update(?:Many)?\(\s*\{[\s\S]{0,900}?\bdata:\s*(\{[^}]*\}|[A-Za-z.]+)/g)) assert.doesNotMatch(match[1], /\b(?:datasetId|modality)\s*:/, `${file} changes datasetId/modality`);
  }
});
test('the dormant importer has no production caller', () => {
  assert.deepEqual(sources.filter(file => !file.endsWith('apps/web/src/lib/dataset-import.ts') && /\bpersistDatasetImport\b/.test(read(file))).map(file => relative(root, file)), []);
});
test('the companion document classifies every audited writer', () => {
  const doc = read(join(root, 'specs/029-modality-specific-datasets/writer-inventory.md'));
  for (const file of Object.keys(MATRIX)) assert.ok(doc.includes(file), `${file} missing from writer-inventory.md`);
});
